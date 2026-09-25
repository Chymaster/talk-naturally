/**
 * Shared test fixtures. No network, no host, no database (AGENT.md §11).
 */
import { fitClass } from "../core/classes/ingest.js";
import type { ClassRecord } from "../core/domain/knowledge.js";
import type { UserProgress } from "../core/domain/progress.js";
import type { RawClassInput } from "../core/classes/schema.js";

export const NOW = "2026-09-25T09:00:00.000Z";

export const rawFixture: RawClassInput = {
  title: "Test Chapter",
  source_language: "English",
  target_language: "German",
  origin: "imported",
  points: [
    { kind: "grammar", title: "Dativ: mit + dem/der", detail: "mit + dative", raw_source: "t1" },
    { kind: "vocab", title: "der Bus", detail: "bus", raw_source: "t2" },
    { kind: "vocab", title: "die Bahn", detail: "train", raw_source: "t3" },
    { kind: "sentence_structure", title: "Womit fährst du?", detail: "question", raw_source: "t4" },
  ],
};

export function makeClass(ownerLearnerId: string | null = "lrn_a"): ClassRecord {
  return fitClass(rawFixture, { ownerLearnerId, nowIso: NOW });
}

export function allIds(klass: ClassRecord): string[] {
  return [...klass.grammar, ...klass.sentenceStructure, ...klass.vocab].map((point) => point.id);
}

export function progressRow(
  knowledgePointId: string,
  overrides: Partial<UserProgress> = {},
): UserProgress {
  return {
    learnerId: "lrn_a",
    knowledgePointId,
    timesSeen: 0,
    timesUsed: 0,
    timesUsedWithHelp: 0,
    timesWrong: 0,
    lastSeenAt: null,
    lastWrongAt: null,
    notes: "",
    ...overrides,
  };
}
