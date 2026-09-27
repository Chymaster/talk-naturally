/**
 * The built-in seed catalog: manifest shape, level content, and the file-backed
 * adapter, for every shipped language (design/60-ingestion.md §3,
 * design/40-steering.md §3).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { fitClass } from "../core/classes/ingest.js";
import { rawClassInputSchema, type RawClassInputParsed } from "../core/classes/schema.js";
import { FileLevelCatalog, MANIFEST_FILE } from "../hosts/catalog-file.js";

const CATALOG_DIRECTORY = fileURLToPath(new URL("../datasets/builtin/", import.meta.url));
const NOW = "2026-01-01T00:00:00.000Z";

/** One shipped class per (language, level); German first, then Chinese. */
const SHIPPED = [
 { language: "German", directory: "german", level: "A1" },
 { language: "German", directory: "german", level: "A2" },
 { language: "Chinese", directory: "chinese", level: "A1" },
 { language: "Chinese", directory: "chinese", level: "A2" },
] as const;

interface ShippedLevel {
 readonly language: string;
 readonly directory: string;
 readonly level: string;
}

function readJson(path: string): unknown {
 return JSON.parse(readFileSync(path, "utf8")) as unknown;
}

function levelPath({ directory, level }: ShippedLevel): string {
 return join(CATALOG_DIRECTORY, directory, `${level}.json`);
}

function parseLevel(path: string): RawClassInputParsed {
 const parsed = rawClassInputSchema.safeParse(readJson(path));
 if (!parsed.success) {
 throw new Error(
 `${path} does not fit the raw class schema: ${parsed.error.issues
 .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
 .join("; ")}`,
 );
 }
 return parsed.data;
}

function idsOf(klass: ReturnType<typeof fitClass>): string[] {
 return [...klass.grammar, ...klass.sentenceStructure, ...klass.vocab].map((point) => point.id);
}

describe("built-in seed catalog", () => {
 it("validates the manifest shape and lists German first, then Chinese", async () => {
 const manifest = readJson(join(CATALOG_DIRECTORY, MANIFEST_FILE));
 expect(manifest).toMatchObject({ version: 1 });

 const catalog = new FileLevelCatalog(CATALOG_DIRECTORY);
 expect(await catalog.listLanguages()).toEqual(["German", "Chinese"]);
 });

 it.each(SHIPPED)(
 "validates $language $level against rawClassInputSchema",
 ({ language, directory, level }) => {
 const raw = parseLevel(levelPath({ language, directory, level }));
 expect(raw.title).toBe(`${language} ${level}`);
 expect(raw.origin).toBe("builtin");
 expect(raw.level).toBe(level);
 expect(raw.source_language).toBe("English");
 expect(raw.target_language).toBe(language);
 expect(raw.points.length).toBeGreaterThanOrEqual(20);
 expect(raw.points.length).toBeLessThanOrEqual(30);
 expect(new Set(raw.points.map((point) => point.kind))).toEqual(
 new Set(["grammar", "sentence_structure", "vocab"]),
 );
 // Seed content is honest about its provenance (datasets/builtin/README.md).
 for (const point of raw.points) {
 expect(point.raw_source).toMatch(new RegExp(`^seed: ${level} unit \\d+$`, "u"));
 }
 },
 );

 it("orders levels lowest first and declares only non-empty unit labels", async () => {
 const catalog = new FileLevelCatalog(CATALOG_DIRECTORY);
 for (const language of await catalog.listLanguages()) {
 const levels = await catalog.listLevels(language);
 expect(levels.map((level) => level.level)).toEqual(["A1", "A2"]);
 for (const level of levels) {
 expect(level.title).toBe(`${language} ${level.level}`);
 expect(level.units.length).toBeGreaterThanOrEqual(4);
 expect(level.units.length).toBeLessThanOrEqual(6);
 for (const label of level.units) {
 expect(label.trim()).not.toBe("");
 }
 }
 }
 });

 it.each(SHIPPED)(
 "keeps $language $level unit_order ascending and every point inside a declared unit",
 async ({ language, directory, level }) => {
 const catalog = new FileLevelCatalog(CATALOG_DIRECTORY);
 const descriptor = (await catalog.listLevels(language)).find(
 (candidate) => candidate.level === level,
 );
 expect(descriptor).toBeDefined();
 const raw = parseLevel(levelPath({ language, directory, level }));
 const orders = new Set<number>();
 let previous = 0;
 for (const point of raw.points) {
 const unitIndex = descriptor?.units.indexOf(point.unit) ?? -1;
 expect(unitIndex, `undeclared unit "${point.unit}"`).toBeGreaterThanOrEqual(0);
 expect(point.unit_order).toBe(unitIndex + 1);
 expect(point.unit_order).toBeGreaterThanOrEqual(previous);
 previous = point.unit_order;
 orders.add(point.unit_order);
 }
 expect([...orders].sort((left, right) => left - right)).toEqual(
 descriptor?.units.map((_, index) => index + 1),
 );
 },
 );

 it.each(SHIPPED)(
 "fits $language $level deterministically with unique ids",
 ({ language, directory, level }) => {
 const raw = parseLevel(levelPath({ language, directory, level }));
 const first = idsOf(fitClass(raw, { ownerLearnerId: null, nowIso: NOW }));
 const second = idsOf(fitClass(raw, { ownerLearnerId: null, nowIso: NOW }));
 expect(second).toEqual(first);
 expect(new Set(first).size).toBe(first.length);
 // Nothing was silently merged as a duplicate.
 expect(first).toHaveLength(raw.points.length);
 },
 );

 it("loads a known built-in level and returns null for an unknown one", async () => {
 const catalog = new FileLevelCatalog(CATALOG_DIRECTORY);

 const german = await catalog.loadBuiltIn("German", "A1");
 expect(german).not.toBeNull();
 expect(german?.title).toBe("German A1");
 expect(german?.level).toBe("A1");
 expect(german?.origin).toBe("builtin");

 const chinese = await catalog.loadBuiltIn("Chinese", "A2");
 expect(chinese).not.toBeNull();
 expect(chinese?.title).toBe("Chinese A2");
 expect(chinese?.target_language).toBe("Chinese");
 expect(chinese?.level).toBe("A2");

 expect(await catalog.loadBuiltIn("German", "C1")).toBeNull();
 expect(await catalog.loadBuiltIn("Chinese", "B1")).toBeNull();
 expect(await catalog.loadBuiltIn("French", "A1")).toBeNull();
 expect(await catalog.listLevels("French")).toEqual([]);
 });

 it("throws with the path instead of returning an empty catalog", async () => {
 const catalog = new FileLevelCatalog(join(CATALOG_DIRECTORY, "does-not-exist"));
 await expect(catalog.listLanguages()).rejects.toThrow(/manifest\.json/u);
 await expect(catalog.loadBuiltIn("German", "A1")).rejects.toThrow(/does-not-exist/u);
 });
});
