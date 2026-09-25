/**
 * Class import for the host layer.
 *
 * Reads material from disk and hands it to the core, which owns fitting and
 * identity (AGENT.md §6.4, §19.1). Re-importing is safe: ids are stable, new
 * points are added, missing ones are retired, and progress is preserved.
 */
import { readFileSync } from "node:fs";
import { ClassFitError, fitClass, reconcileClass } from "../core/classes/ingest.js";
import type { RawClassInput } from "../core/classes/schema.js";
import type { ClassRecord } from "../core/domain/knowledge.js";
import type { StoragePort } from "../core/ports/storage.js";

export interface ImportResult {
  readonly klass: ClassRecord;
  readonly pointCount: number;
  readonly added: number;
  readonly retired: number;
  readonly revived: number;
  readonly unchanged: number;
  readonly reimport: boolean;
}

export function readClassFile(path: string): RawClassInput {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as RawClassInput;
  } catch (error) {
    throw new ClassFitError(
      `could not read class material at ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export async function importClass(
  storage: StoragePort,
  learnerId: string,
  raw: RawClassInput,
  nowIso: string,
): Promise<ImportResult> {
  const incoming = fitClass(raw, { ownerLearnerId: learnerId, nowIso });
  const existing = await storage.getClass(learnerId, incoming.id);

  if (existing === null) {
    await storage.saveClass(learnerId, incoming);
    const pointCount =
      incoming.grammar.length + incoming.sentenceStructure.length + incoming.vocab.length;
    return {
      klass: incoming,
      pointCount,
      added: pointCount,
      retired: 0,
      revived: 0,
      unchanged: 0,
      reimport: false,
    };
  }

  const { klass, summary } = reconcileClass(existing, incoming, nowIso);
  await storage.saveClass(learnerId, klass);
  return {
    klass,
    pointCount: klass.grammar.length + klass.sentenceStructure.length + klass.vocab.length,
    ...summary,
    reimport: true,
  };
}

export async function importClassFile(
  storage: StoragePort,
  learnerId: string,
  path: string,
  nowIso: string,
): Promise<ImportResult> {
  return importClass(storage, learnerId, readClassFile(path), nowIso);
}
