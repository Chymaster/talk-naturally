/**
 * File-backed built-in level catalog — design/60-ingestion.md §3.
 *
 * The built-in language library ships as `datasets/builtin/manifest.json` plus one
 * JSON file per level (for example `german/A1.json`, `chinese/A2.json`). Reading
 * files is an adapter concern; the core only ever
 * sees `LevelCatalogPort` (design/20-architecture.md §2), so the composition
 * root chooses the directory.
 *
 * A missing or malformed manifest or level file is a deployment error, not a
 * learner condition. This adapter throws with the offending path so the failure
 * is diagnosable, and only an unknown language or level yields `null` / `[]`.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { rawClassInputSchema, type RawClassInput } from "../core/classes/schema.js";
import type { LevelCatalogPort, LevelDescriptor } from "../core/ports/catalog.js";

/** The manifest file name inside the catalog directory. */
export const MANIFEST_FILE = "manifest.json";

export interface ManifestLevel {
 /** CEFR level tag, e.g. "A1". */
 readonly level: string;
 /** Class title used for the built-in class, e.g. "German A1". */
 readonly title: string;
 /** Path to the level JSON, relative to the catalog directory. */
 readonly file: string;
 /** Ordered unit labels; the level file repeats them per point. */
 readonly units: readonly string[];
}

export interface ManifestLanguage {
 /** Target language, e.g. "German". */
 readonly language: string;
 /** Language the explanations are written in, e.g. "English". */
 readonly sourceLanguage: string;
 /** Levels for this language, lowest first (design/40-steering.md §3). */
 readonly levels: readonly ManifestLevel[];
}

export interface CatalogManifest {
 readonly version: 1;
 readonly languages: readonly ManifestLanguage[];
}

function fail(path: string, problem: string): never {
 throw new Error(`invalid built-in catalog manifest at ${path}: ${problem}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
 return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(value: unknown, where: string, path: string): string {
 if (typeof value !== "string" || value.trim().length === 0) {
 fail(path, `${where} must be a non-empty string`);
 }
 return value;
}

/**
 * Validate the manifest by hand rather than trusting the JSON: a broken manifest
 * must fail loudly at the path, not become an empty catalog
 * (design/60-ingestion.md §3).
 */
function parseManifest(raw: unknown, manifestPath: string): CatalogManifest {
 if (!isRecord(raw)) {
 fail(manifestPath, "the top level must be a JSON object");
 }
 if (raw.version !== 1) {
 fail(manifestPath, `version must be 1, got ${JSON.stringify(raw.version)}`);
 }
 if (!Array.isArray(raw.languages) || raw.languages.length === 0) {
 fail(manifestPath, "languages must be a non-empty array");
 }

 const languages = raw.languages.map((languageEntry, languageIndex): ManifestLanguage => {
 const languageWhere = `languages[${languageIndex}]`;
 if (!isRecord(languageEntry)) {
 fail(manifestPath, `${languageWhere} must be an object`);
 }
 const language = requireString(languageEntry.language, `${languageWhere}.language`, manifestPath);
 const sourceLanguage = requireString(
 languageEntry.sourceLanguage,
 `${languageWhere}.sourceLanguage`,
 manifestPath,
 );
 if (!Array.isArray(languageEntry.levels) || languageEntry.levels.length === 0) {
 fail(manifestPath, `${languageWhere}.levels must be a non-empty array`);
 }

 const levels = languageEntry.levels.map((levelEntry, levelIndex): ManifestLevel => {
 const levelWhere = `${languageWhere}.levels[${levelIndex}]`;
 if (!isRecord(levelEntry)) {
 fail(manifestPath, `${levelWhere} must be an object`);
 }
 const level = requireString(levelEntry.level, `${levelWhere}.level`, manifestPath);
 const title = requireString(levelEntry.title, `${levelWhere}.title`, manifestPath);
 const file = requireString(levelEntry.file, `${levelWhere}.file`, manifestPath);
 if (!Array.isArray(levelEntry.units)) {
 fail(manifestPath, `${levelWhere}.units must be an array`);
 }
 const units = levelEntry.units.map((unit, unitIndex) =>
 requireString(unit, `${levelWhere}.units[${unitIndex}]`, manifestPath),
 );
 return { level, title, file, units };
 });

 return { language, sourceLanguage, levels };
 });

 return { version: 1, languages };
}

/** Built-in catalog read from a directory on disk. */
export class FileLevelCatalog implements LevelCatalogPort {
 readonly #directory: string;
 #manifest: CatalogManifest | null = null;

 constructor(directory: string) {
 this.#directory = directory;
 }

 /** Languages in manifest order. */
 async listLanguages(): Promise<readonly string[]> {
 return this.#loadManifest().languages.map((entry) => entry.language);
 }

 /** Descriptors for one language, lowest level first; `[]` for an unknown language. */
 async listLevels(language: string): Promise<readonly LevelDescriptor[]> {
 const entry = this.#languageEntry(language);
 if (entry === undefined) {
 return [];
 }
 return entry.levels.map((level) => ({
 language: entry.language,
 level: level.level,
 title: level.title,
 units: [...level.units],
 }));
 }

 /** Raw material for one level, or `null` when the catalog does not ship it. */
 async loadBuiltIn(language: string, level: string): Promise<RawClassInput | null> {
 const entry = this.#languageEntry(language);
 if (entry === undefined) {
 return null;
 }
 const manifestLevel = entry.levels.find((candidate) => candidate.level === level);
 if (manifestLevel === undefined) {
 return null;
 }

 const path = join(this.#directory, manifestLevel.file);
 const parsed = rawClassInputSchema.safeParse(this.#readJson(path));
 if (!parsed.success) {
 throw new Error(
 `invalid built-in level file at ${path}: ${parsed.error.issues
 .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
 .join("; ")}`,
 );
 }
 return parsed.data;
 }

 #loadManifest(): CatalogManifest {
 if (this.#manifest === null) {
 const path = join(this.#directory, MANIFEST_FILE);
 this.#manifest = parseManifest(this.#readJson(path), path);
 }
 return this.#manifest;
 }

 #languageEntry(language: string): ManifestLanguage | undefined {
 return this.#loadManifest().languages.find((entry) => entry.language === language);
 }

 #readJson(path: string): unknown {
 let text: string;
 try {
 text = readFileSync(path, "utf8");
 } catch (error) {
 throw new Error(
 `could not read built-in catalog file at ${path}: ${
 error instanceof Error ? error.message : String(error)
 }`,
 );
 }
 try {
 return JSON.parse(text) as unknown;
 } catch (error) {
 throw new Error(
 `could not parse built-in catalog JSON at ${path}: ${
 error instanceof Error ? error.message : String(error)
 }`,
 );
 }
 }
}
