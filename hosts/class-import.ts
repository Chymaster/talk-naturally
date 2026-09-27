/**
 * Class import for the host layer.
 *
 * Reads material from disk and hands it to the engine, which owns fitting and
 * reconciliation (design/30-domain-model.md §4, design/60-ingestion.md §1–2).
 * Re-importing is safe: ids are stable, new points are added, missing ones are
 * retired, and progress is preserved.
 */
import { readFileSync } from "node:fs";
import { ClassFitError } from "../core/classes/ingest.js";
import type { RawClassInput } from "../core/classes/schema.js";
import type { StoragePort } from "../core/ports/storage.js";
import { importRawClass, type ImportResult } from "../engine/class-import.js";

export type { ImportResult };

/** Read raw class JSON from disk; a malformed or missing file fails loudly. */
export function readClassFile(path: string): RawClassInput {
 try {
 return JSON.parse(readFileSync(path, "utf8")) as RawClassInput;
 } catch (error) {
 throw new ClassFitError(
 `could not read class material at ${path}: ${error instanceof Error ? error.message : String(error)}`,
 );
 }
}

/**
 * Fit and reconcile one class. The logic lives in `engine/class-import.ts` so the
 * onboarding flow and the hosts share one implementation (design/60-ingestion.md §2).
 */
export function importClass(
 storage: StoragePort,
 learnerId: string,
 raw: RawClassInput,
 nowIso: string,
): Promise<ImportResult> {
 return importRawClass(storage, learnerId, raw, nowIso);
}

export function importClassFile(
 storage: StoragePort,
 learnerId: string,
 path: string,
 nowIso: string,
): Promise<ImportResult> {
 return importClass(storage, learnerId, readClassFile(path), nowIso);
}
