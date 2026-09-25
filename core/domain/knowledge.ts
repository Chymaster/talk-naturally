/**
 * Class dataset and knowledge-point model — AGENT.md §6.1.
 *
 * Pure types and pure helpers. No I/O, no platform APIs, no external systems
 * (AGENT.md §3).
 */

/** The three grouping keys of every class dataset (§6.1). */
export type KnowledgeKind = "grammar" | "sentence_structure" | "vocab";

export const KNOWLEDGE_KINDS: readonly KnowledgeKind[] = [
  "grammar",
  "sentence_structure",
  "vocab",
];

/** Where a class came from (§6.5). A built-in class is not special-cased. */
export type ClassOrigin = "imported" | "builtin" | "personal";

/**
 * A single thing the learner is meant to learn.
 *
 * `id` is stable and deterministic (§6.4); `canonicalKey` is the exact string
 * the id was derived from, kept so the scheme is auditable and a hash collision
 * can be detected loudly instead of silently orphaning progress.
 */
export interface KnowledgePoint {
  readonly id: string;
  readonly kind: KnowledgeKind;
  readonly title: string;
  readonly detail: string;
  /** Pointer back into the source material, for debugging a bad fit (§6.1). */
  readonly rawSource: string;
  readonly canonicalKey: string;
  /** Set instead of deleting when a re-import no longer contains this point (§6.4). */
  readonly retiredAt: string | null;
}

/** Bump when the persisted shape changes; migrations are tested (§11, §19.1). */
export const CLASS_SCHEMA_VERSION = 1;

/** A body of material: "German A1.2, chapter 8" (§6.1). */
export interface ClassRecord {
  readonly schemaVersion: number;
  readonly id: string;
  /** null means shared material (e.g. a built-in class); otherwise learner-owned. */
  readonly ownerLearnerId: string | null;
  readonly title: string;
  readonly sourceLanguage: string;
  readonly targetLanguage: string;
  readonly importedAt: string;
  readonly origin: ClassOrigin;
  readonly grammar: readonly KnowledgePoint[];
  readonly sentenceStructure: readonly KnowledgePoint[];
  readonly vocab: readonly KnowledgePoint[];
}

/** All knowledge points of a class, in a stable order. */
export function allKnowledgePoints(klass: ClassRecord): readonly KnowledgePoint[] {
  return [...klass.grammar, ...klass.sentenceStructure, ...klass.vocab];
}

/** Points that still take part in progress and steering (§6.4). */
export function activeKnowledgePoints(klass: ClassRecord): readonly KnowledgePoint[] {
  return allKnowledgePoints(klass).filter((point) => point.retiredAt === null);
}

export function findKnowledgePoint(
  klass: ClassRecord,
  knowledgePointId: string,
): KnowledgePoint | null {
  return (
    allKnowledgePoints(klass).find((point) => point.id === knowledgePointId) ?? null
  );
}

/** Human-readable label for a kind, used in prompts and logs. */
export function kindLabel(kind: KnowledgeKind): string {
  switch (kind) {
    case "grammar":
      return "grammar";
    case "sentence_structure":
      return "sentence structure";
    case "vocab":
      return "vocabulary";
  }
}
