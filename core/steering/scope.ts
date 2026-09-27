/**
 * Steering scope — design/40-steering.md §2.
 *
 * The learner studies one level but may keep earlier levels in scope for review.
 * This resolves the candidate pool from that choice: the primary level's points
 * plus the included previous levels' points, deduped by knowledge-point id so a
 * point present in two levels stays one point with one set of counters
 * (design/30-domain-model.md §5).
 *
 * Only the primary level's at-or-above-cursor points may be taught as new
 * material. Unseen points elsewhere are background: still rankable once a
 * counter exists, but never introduced as new (design/40-steering.md §3).
 */
import { activeKnowledgePoints, type ClassRecord, type KnowledgePoint } from "../domain/knowledge.js";
import { highestUnitOrder } from "../domain/settings.js";

export interface ScopeLevel {
 readonly klass: ClassRecord;
 /** True for the level the learner is currently studying; false for an included earlier level. */
 readonly primary: boolean;
 /** Assumed-known cursor for this level; only meaningful when `primary` (design/30-domain-model.md §8). */
 readonly knownThroughUnit: number;
}

export interface ScopeCandidate {
 readonly point: KnowledgePoint;
 /** The class the point was read from. */
 readonly klass: ClassRecord;
 readonly primary: boolean;
 /** True when the point may be taught as new material on this turn. */
 readonly teachable: boolean;
}

export interface Scope {
 readonly candidates: readonly ScopeCandidate[];
 /** Level tags in scope, lowest first, for logs and prompts. */
 readonly levels: readonly string[];
}

export function resolveScope(levels: readonly ScopeLevel[]): Scope {
 const byId = new Map<string, ScopeCandidate>();

 for (const level of levels) {
 // The cursor only applies to material that declares units; otherwise there is
 // no chapter to be past (design/30-domain-model.md §8).
 const hasUnits = highestUnitOrder(level.klass) > 0;
 for (const point of activeKnowledgePoints(level.klass)) {
 const teachable =
 level.primary && (!hasUnits || point.unitOrder >= level.knownThroughUnit);
 const existing = byId.get(point.id);
 // One point, one candidate. The primary copy wins, so its unit and
 // teachability are the ones that count.
 if (existing === undefined || (!existing.primary && level.primary)) {
 byId.set(point.id, { point, klass: level.klass, primary: level.primary, teachable });
 }
 }
 }

 return {
 candidates: [...byId.values()],
 levels: levels.map((level) => level.klass.level ?? level.klass.title),
 };
}

/** The scope of a single class: primary, no cursor, no review pool. */
export function singleClassScope(klass: ClassRecord): Scope {
 return resolveScope([{ klass, primary: true, knownThroughUnit: 0 }]);
}
