/**
 * Class dataset and knowledge-point model — design/30-domain-model.md §1.
 *
 * Pure types and pure helpers. No I/O, no platform APIs, no external systems
 * (design/20-architecture.md §2).
 */

/** The three grouping keys of every class dataset (design/30-domain-model.md §1). */
export type KnowledgeKind = "grammar" | "sentence_structure" | "vocab";

export const KNOWLEDGE_KINDS: readonly KnowledgeKind[] = [
 "grammar",
 "sentence_structure",
 "vocab",
];

/** Where a class came from (design/30-domain-model.md §3). A built-in class is not special-cased. */
export type ClassOrigin = "imported" | "builtin" | "personal";

/**
 * A single thing the learner is meant to learn.
 *
 * `id` is stable and deterministic (design/30-domain-model.md §4); `canonicalKey` is the exact string
 * the id was derived from, kept so the scheme is auditable and a hash collision
 * can be detected loudly instead of silently orphaning progress.
 */
export interface KnowledgePoint {
 readonly id: string;
 readonly kind: KnowledgeKind;
 readonly title: string;
 readonly detail: string;
 /** Pointer back into the source material, for debugging a bad fit (design/30-domain-model.md §1). */
 readonly rawSource: string;
 /** Chapter/unit label from the source material, e.g. "Kapitel 4"; "" when the material has no units (design/30-domain-model.md §1). */
 readonly unit: string;
 /** Position of that unit within the level; 0 when the material has no units (design/30-domain-model.md §1). */
 readonly unitOrder: number;
 readonly canonicalKey: string;
 /** Set instead of deleting when a re-import no longer contains this point (design/30-domain-model.md §4). */
 readonly retiredAt: string | null;
}

/** Bump when the persisted shape changes; migrations are tested (design/70-stack.md §5, design/60-ingestion.md §1). */
export const CLASS_SCHEMA_VERSION = 2;

/** A body of material for one (target language, CEFR level): "German A2" (design/30-domain-model.md §1). */
export interface ClassRecord {
 readonly schemaVersion: number;
 readonly id: string;
 /** null means shared material (e.g. a built-in class); otherwise learner-owned. */
 readonly ownerLearnerId: string | null;
 readonly title: string;
 readonly sourceLanguage: string;
 readonly targetLanguage: string;
 /** CEFR level tag ("A1"–"C2"); null when the material does not declare one (design/30-domain-model.md §1). */
 readonly level: string | null;
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

/** Points that still take part in progress and steering (design/30-domain-model.md §4). */
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
