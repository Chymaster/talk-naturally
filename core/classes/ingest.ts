/**
 * Fitting raw material into the class schema, and reconciling a re-import —
 * AGENT.md §6.4, §6.5, §19.1.
 *
 * Fitting is deterministic and model-free here: it assigns ids from canonical
 * content. The model never assigns ids (§19.1). A model-driven free-text fit is
 * out of PoC scope (MVP.md §5.6) and would call this same function afterwards.
 */
import {
  CLASS_SCHEMA_VERSION,
  type ClassOrigin,
  type ClassRecord,
  type KnowledgeKind,
  type KnowledgePoint,
} from "../domain/knowledge.js";
import { canonicalKeyOf, classIdOf, knowledgePointId } from "./canonical.js";
import {
  rawClassInputSchema,
  type RawClassInput,
  type RawClassInputParsed,
} from "./schema.js";

/** A bad fit is surfaced to the learner in conversation, never a crash (§6.5). */
export class ClassFitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClassFitError";
  }
}

export interface FitContext {
  /** null for shared/built-in material. */
  readonly ownerLearnerId: string | null;
  readonly nowIso: string;
}

export interface ReconcileSummary {
  readonly added: number;
  readonly retired: number;
  readonly revived: number;
  readonly unchanged: number;
}

function toKnowledgePoint(
  raw: RawClassInputParsed["points"][number],
  targetLanguage: string,
): KnowledgePoint {
  const canonicalKey = canonicalKeyOf(raw.kind, raw.title, targetLanguage);
  return {
    id: knowledgePointId(raw.kind, raw.title, targetLanguage),
    kind: raw.kind,
    title: raw.title,
    detail: raw.detail,
    rawSource: raw.raw_source,
    canonicalKey,
    retiredAt: null,
  };
}

/**
 * Two different canonical keys hashing to one id would silently merge two
 * knowledge points and corrupt progress. Fail loudly instead (§6.4).
 */
function assertNoCollisions(points: readonly KnowledgePoint[], classTitle: string): void {
  const seen = new Map<string, string>();
  for (const point of points) {
    const existing = seen.get(point.id);
    if (existing !== undefined && existing !== point.canonicalKey) {
      throw new ClassFitError(
        `knowledge-point id collision in class "${classTitle}": ` +
          `"${existing}" and "${point.canonicalKey}" both map to ${point.id}. ` +
          `Rename one, or change the id scheme (§6.4) — do not proceed.`,
      );
    }
    seen.set(point.id, point.canonicalKey);
  }
}

function groupByKind(points: readonly KnowledgePoint[]): {
  grammar: KnowledgePoint[];
  sentenceStructure: KnowledgePoint[];
  vocab: KnowledgePoint[];
} {
  const grammar: KnowledgePoint[] = [];
  const sentenceStructure: KnowledgePoint[] = [];
  const vocab: KnowledgePoint[] = [];
  for (const point of points) {
    const bucket: Record<KnowledgeKind, KnowledgePoint[]> = {
      grammar,
      sentence_structure: sentenceStructure,
      vocab,
    };
    bucket[point.kind].push(point);
  }
  return { grammar, sentenceStructure, vocab };
}

/** Fit validated input into a `ClassRecord`. Throws `ClassFitError` on bad input. */
export function fitClass(input: RawClassInput, context: FitContext): ClassRecord {
  const parsed = rawClassInputSchema.safeParse(input);
  if (!parsed.success) {
    throw new ClassFitError(
      `class material did not fit the schema: ${parsed.error.issues
        .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
        .join("; ")}`,
    );
  }

  const data = parsed.data;
  const points = data.points.map((raw) => toKnowledgePoint(raw, data.target_language));
  assertNoCollisions(points, data.title);

  // An exact duplicate (same canonical key) is the same knowledge point, listed
  // twice in the source material. Keep one; progress must not be split (§19.4).
  const deduped: KnowledgePoint[] = [];
  const seenIds = new Set<string>();
  for (const point of points) {
    if (seenIds.has(point.id)) {
      continue;
    }
    seenIds.add(point.id);
    deduped.push(point);
  }

  const grouped = groupByKind(deduped);

  return {
    schemaVersion: CLASS_SCHEMA_VERSION,
    id: data.id ?? classIdOf(data.title, data.target_language),
    ownerLearnerId: context.ownerLearnerId,
    title: data.title,
    sourceLanguage: data.source_language,
    targetLanguage: data.target_language,
    importedAt: context.nowIso,
    origin: data.origin as ClassOrigin,
    grammar: grouped.grammar,
    sentenceStructure: grouped.sentenceStructure,
    vocab: grouped.vocab,
  };
}

/**
 * Match a re-fit onto the existing class: same ids stay, genuinely new points
 * are added, and points that disappeared are retired rather than deleted —
 * progress rows reference them (§6.4). Never reassigns an id.
 */
export function reconcileClass(
  existing: ClassRecord,
  incoming: ClassRecord,
  nowIso: string,
): { readonly klass: ClassRecord; readonly summary: ReconcileSummary } {
  const existingById = new Map<string, KnowledgePoint>();
  for (const point of [
    ...existing.grammar,
    ...existing.sentenceStructure,
    ...existing.vocab,
  ]) {
    existingById.set(point.id, point);
  }

  const incomingIds = new Set<string>();
  let added = 0;
  let revived = 0;
  let unchanged = 0;

  const merged: KnowledgePoint[] = [];
  for (const point of [
    ...incoming.grammar,
    ...incoming.sentenceStructure,
    ...incoming.vocab,
  ]) {
    incomingIds.add(point.id);
    const previous = existingById.get(point.id);
    if (previous === undefined) {
      added += 1;
      merged.push(point);
      continue;
    }
    if (previous.retiredAt !== null) {
      revived += 1;
    } else {
      unchanged += 1;
    }
    merged.push({ ...point, retiredAt: null });
  }

  let retired = 0;
  for (const point of existingById.values()) {
    if (incomingIds.has(point.id)) {
      continue;
    }
    if (point.retiredAt === null) {
      retired += 1;
    } else {
      unchanged += 1;
    }
    merged.push({ ...point, retiredAt: point.retiredAt ?? nowIso });
  }

  const grouped = groupByKind(merged);
  return {
    klass: {
      ...incoming,
      // The first import wins on provenance so a re-import cannot rewrite it.
      schemaVersion: CLASS_SCHEMA_VERSION,
      id: existing.id,
      ownerLearnerId: existing.ownerLearnerId,
      importedAt: existing.importedAt,
      grammar: grouped.grammar,
      sentenceStructure: grouped.sentenceStructure,
      vocab: grouped.vocab,
    },
    summary: { added, retired, revived, unchanged },
  };
}
