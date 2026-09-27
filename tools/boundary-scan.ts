/**
 * Core boundary scanner — design/20-architecture.md §2/20-architecture §3.
 *
 * Why this exists instead of dependency-cruiser: under this project's
 * TypeScript/ESM setup, depcruise resolved relative imports but silently
 * dropped *bare* imports (`@langchain/langgraph`, `discord.js`), so a rule
 * forbidding SDKs in `core/` could never fire and the check reported success
 * while the boundary was broken. A guard rail that cannot fail is worse than
 * none, so the rule is implemented here and shared by the CLI (`pnpm boundary`)
 * and the test suite, which means both always agree.
 *
 * The scanner is deliberately conservative: it is better to flag a suspicious
 * mention and adjust than to let a channel or provider concept into the domain.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

/** The only non-relative import the core is allowed to have. */
export const ALLOWED_BARE_IMPORTS: readonly string[] = ["zod"];

/** Channel and provider concepts that must never appear in the domain (design/20-architecture.md §2). */
export const FORBIDDEN_NAME_PATTERN =
 /\b(discord|telegram|guild|snowflake|openrouter|openai|deepseek|llama|gemma|postgres|sqlite)\b/iu;

const FROM_SPECIFIER = /\bfrom\s*["']([^"']+)["']/gu;
const DYNAMIC_SPECIFIER = /\bimport\s*\(\s*["']([^"']+)["']/gu;
const SIDE_EFFECT_SPECIFIER = /(?:^|[\n;])\s*import\s+["']([^"']+)["']/gu;

export interface BoundaryReport {
 /** How many core files were read. A check must never pass vacuously. */
 readonly scanned: number;
 readonly violations: readonly string[];
}

interface CoreFile {
 readonly path: string;
 readonly source: string;
}

function tsFilesUnder(directory: string): string[] {
 const found: string[] = [];
 for (const entry of readdirSync(directory)) {
 const full = join(directory, entry);
 if (statSync(full).isDirectory()) {
 found.push(...tsFilesUnder(full));
 } else if (entry.endsWith(".ts")) {
 found.push(full);
 }
 }
 return found;
}

function specifiersIn(source: string): string[] {
 const found = new Set<string>();
 for (const pattern of [FROM_SPECIFIER, DYNAMIC_SPECIFIER, SIDE_EFFECT_SPECIFIER]) {
 pattern.lastIndex = 0;
 for (const match of source.matchAll(pattern)) {
 if (match[1] !== undefined) {
 found.add(match[1]);
 }
 }
 }
 return [...found];
}

export function scanCoreBoundary(coreDir: string = resolve("core")): BoundaryReport {
 const files: CoreFile[] = tsFilesUnder(coreDir).map((path) => ({
 path,
 source: readFileSync(path, "utf8"),
 }));
 const violations: string[] = [];
 const allowed = new Set(ALLOWED_BARE_IMPORTS);

 for (const file of files) {
 const label = relative(coreDir, file.path);

 for (const specifier of specifiersIn(file.source)) {
 if (specifier.startsWith(".")) {
 const target = resolve(dirname(file.path), specifier);
 if (target !== coreDir && !target.startsWith(`${coreDir}${sep}`)) {
 violations.push(
 `[imports] ${label} imports outside core: ${specifier} (the domain must not depend on outer layers, design/20-architecture.md §2)`,
 );
 }
 continue;
 }
 if (!allowed.has(specifier)) {
 violations.push(
 `[imports] ${label} imports a non-allowed package or platform module: ${specifier} (only pure libraries are allowed, design/20-architecture.md §2)`,
 );
 }
 }

 if (/process\.env/u.test(file.source)) {
 violations.push(
 `[config] ${label} reads process.env; configuration arrives from the host (design/20-architecture.md §2)`,
 );
 }
 if (/\bfetch\s*\(/u.test(file.source)) {
 violations.push(
 `[network] ${label} calls fetch; the model port owns the network (design/20-architecture.md §2, design/20-architecture.md §5)`,
 );
 }
 if (/new\s+Date\s*\(\s*\)/u.test(file.source)) {
 violations.push(
 `[clock] ${label} reads the clock directly; the clock port is injected (design/20-architecture.md §2)`,
 );
 }

 const named = FORBIDDEN_NAME_PATTERN.exec(file.source);
 if (named !== null) {
 violations.push(
 `[naming] ${label} mentions "${named[0]}"; channel and provider concepts belong outside the domain (design/20-architecture.md §2)`,
 );
 }
 }

 return { scanned: files.length, violations };
}
