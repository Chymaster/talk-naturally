/**
 * Target selection — design/40-steering.md.
 *
 * The core decides *what* to work on; the model decides *how* to work it into
 * the conversation. This function is pure: no model call, no I/O, no clock
 * beyond the injected `nowIso`, so the weighting can be tuned against recorded
 * sessions and the decision is explainable from a log line (40-steering, design/20-architecture.md §4).
 *
 * The candidate pool is a resolved `Scope` — the primary level plus any included
 * previous levels (design/40-steering.md §3) — and ties break on unit order, so
 * new material arrives in chapter order rather than id-hash order.
 */
import { kindLabel, type ClassRecord, type KnowledgePoint } from "../domain/knowledge.js";
import type { UserProgress } from "../domain/progress.js";
import { MAX_TARGETS_PER_TURN } from "../domain/turn.js";
import { deriveProgress, type DerivedProgress } from "../progress/derive.js";
import { resolveScope, type Scope, type ScopeCandidate } from "./scope.js";

/** design/40-steering.md §4 — integer weights, deterministic, no floats as truth (design/30-domain-model.md §1). */
export const STEERING_WEIGHTS = {
 due: 3,
 struggle: 2,
 unattempted: 1,
 consolidating: 1,
} as const;

export const DEFAULT_TARGET_LIMIT = MAX_TARGETS_PER_TURN;

export interface ScoredTarget {
 readonly point: KnowledgePoint;
 readonly score: number;
 readonly reasons: readonly string[];
 readonly derived: DerivedProgress;
 /** True when the point may be taught as new material this turn (design/40-steering.md §3). */
 readonly teachable: boolean;
 /** True when the point comes from the level the learner is currently studying. */
 readonly primary: boolean;
}

export interface SteeringResult {
 readonly targets: readonly ScoredTarget[];
 /** How many active points were ranked. */
 readonly considered: number;
 /** One-line explanation, logged every turn (40-steering). */
 readonly summary: string;
}

export interface SteeringInput {
 /** A single class when there is no cross-level scope (tests, CLI). */
 readonly klass?: ClassRecord;
 /** The resolved pool: the primary level plus included previous levels (design/40-steering.md §3). */
 readonly scope?: Scope;
 readonly progress: readonly UserProgress[];
 readonly nowIso: string;
 readonly limit?: number;
}

function blankProgress(knowledgePointId: string): UserProgress {
 return {
 learnerId: "",
 knowledgePointId,
 timesSeen: 0,
 timesUsed: 0,
 timesUsedWithHelp: 0,
 timesWrong: 0,
 lastSeenAt: null,
 lastWrongAt: null,
 notes: "",
 };
}

function scopeOf(input: SteeringInput): Scope {
 if (input.scope !== undefined) {
 return input.scope;
 }
 if (input.klass === undefined) {
 throw new Error("selectTargets needs either a scope or a klass (design/40-steering.md §3)");
 }
 return resolveScope([{ klass: input.klass, primary: true, knownThroughUnit: 0 }]);
}

function scorePoint(
 candidate: ScopeCandidate,
 progress: UserProgress,
 nowIso: string,
): ScoredTarget {
 const derived = deriveProgress(progress, nowIso);
 const reasons: string[] = [];
 let score = 0;

 // Unseen material outside the primary level, or below the learner's chapter
 // cursor, is background: reviewable once it has a counter, never introduced as
 // new (design/40-steering.md §3).
 const background = !candidate.teachable && progress.timesSeen === 0;

 if (background) {
 reasons.push("background(not being taught yet)");
 } else {
 if (derived.due) {
 score += STEERING_WEIGHTS.due;
 reasons.push(
 progress.timesSeen === 0 ? "due(never seen)" : "due(not seen recently)",
 );
 }
 if (derived.struggle > 0) {
 score += STEERING_WEIGHTS.struggle * derived.struggle;
 reasons.push(`struggle(${derived.struggle})`);
 }
 if (derived.unattempted) {
 score += STEERING_WEIGHTS.unattempted;
 reasons.push("new");
 }
 if (derived.consolidating) {
 score += STEERING_WEIGHTS.consolidating;
 reasons.push("consolidating");
 }
 if (reasons.length === 0) {
 reasons.push("low-priority(recently used)");
 }
 }

 return {
 point: candidate.point,
 score,
 reasons,
 derived,
 teachable: candidate.teachable,
 primary: candidate.primary,
 };
}

export function selectTargets(input: SteeringInput): SteeringResult {
 const limit = input.limit ?? DEFAULT_TARGET_LIMIT;
 const scope = scopeOf(input);
 const progressById = new Map(
 input.progress.map((row) => [row.knowledgePointId, row]),
 );

 const scored = scope.candidates.map((candidate) =>
 scorePoint(
 candidate,
 progressById.get(candidate.point.id) ?? blankProgress(candidate.point.id),
 input.nowIso,
 ),
 );

 // Deterministic: score desc, then chapter order, then id — reproducible across
 // runs, and new material is introduced chapter by chapter (40-steering).
 scored.sort((left, right) => {
 if (right.score !== left.score) {
 return right.score - left.score;
 }
 if (left.point.unitOrder !== right.point.unitOrder) {
 return left.point.unitOrder - right.point.unitOrder;
 }
 return left.point.id < right.point.id ? -1 : left.point.id > right.point.id ? 1 : 0;
 });

 const targets = scored.slice(0, Math.max(0, limit));
 const top = targets[0];
 const scopeLabel =
 input.klass?.id ?? (scope.levels.length > 0 ? scope.levels.join("+") : "scope");
 const summary =
 top === undefined
 ? `no active targets in ${scopeLabel}`
 : `selected ${targets.length}/${scored.length} in ${scopeLabel}: ` +
 targets
 .map((target) => `${target.point.id}(${target.score})`)
 .join(" ") +
 ` | top=${kindLabel(top.point.kind)} "${top.point.title}" because ${top.reasons.join(", ")}`;

 return { targets, considered: scored.length, summary };
}

/** Per-point detail for logs and the CLI transcript (design/20-architecture.md §4). */
export function explainTarget(target: ScoredTarget): string {
 return `${target.point.id} score=${target.score} [${target.reasons.join(", ")}] "${target.point.title}"`;
}
