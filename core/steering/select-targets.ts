/**
 * Target selection — AGENT.md §6.3.
 *
 * The core decides *what* to work on; the model decides *how* to work it into
 * the conversation. This function is pure: no model call, no I/O, no clock
 * beyond the injected `nowIso`, so the weighting can be tuned against recorded
 * sessions and the decision is explainable from a log line (§6.3, §7.9).
 */
import {
  activeKnowledgePoints,
  kindLabel,
  type ClassRecord,
  type KnowledgePoint,
} from "../domain/knowledge.js";
import type { UserProgress } from "../domain/progress.js";
import { MAX_TARGETS_PER_TURN } from "../domain/turn.js";
import { deriveProgress, type DerivedProgress } from "../progress/derive.js";

/** MVP.md §5.4 — integer weights, deterministic, no floats as truth (§6.1). */
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
}

export interface SteeringResult {
  readonly targets: readonly ScoredTarget[];
  /** How many active points were ranked. */
  readonly considered: number;
  /** One-line explanation, logged every turn (§6.3). */
  readonly summary: string;
}

export interface SteeringInput {
  readonly klass: ClassRecord;
  readonly progress: readonly UserProgress[];
  readonly nowIso: string;
  readonly limit?: number;
}

function scorePoint(
  point: KnowledgePoint,
  progress: UserProgress,
  nowIso: string,
): ScoredTarget {
  const derived = deriveProgress(progress, nowIso);
  const reasons: string[] = [];
  let score = 0;

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

  return { point, score, reasons, derived };
}

export function selectTargets(input: SteeringInput): SteeringResult {
  const limit = input.limit ?? DEFAULT_TARGET_LIMIT;
  const progressById = new Map(
    input.progress.map((row) => [row.knowledgePointId, row]),
  );

  const scored = activeKnowledgePoints(input.klass).map((point) =>
    scorePoint(
      point,
      progressById.get(point.id) ?? {
        learnerId: "",
        knowledgePointId: point.id,
        timesSeen: 0,
        timesUsed: 0,
        timesUsedWithHelp: 0,
        timesWrong: 0,
        lastSeenAt: null,
        lastWrongAt: null,
        notes: "",
      },
      input.nowIso,
    ),
  );

  // Deterministic: score desc, then id asc — reproducible across runs (§6.3).
  scored.sort((left, right) => {
    if (right.score !== left.score) {
      return right.score - left.score;
    }
    return left.point.id < right.point.id ? -1 : left.point.id > right.point.id ? 1 : 0;
  });

  const targets = scored.slice(0, Math.max(0, limit));
  const top = targets[0];
  const summary =
    top === undefined
      ? `no active targets in class ${input.klass.id}`
      : `selected ${targets.length}/${scored.length}: ` +
        targets
          .map((target) => `${target.point.id}(${target.score})`)
          .join(" ") +
        ` | top=${kindLabel(top.point.kind)} "${top.point.title}" because ${top.reasons.join(", ")}`;

  return { targets, considered: scored.length, summary };
}

/** Per-point detail for logs and the CLI transcript (§7.9). */
export function explainTarget(target: ScoredTarget): string {
  return `${target.point.id} score=${target.score} [${target.reasons.join(", ")}] "${target.point.title}"`;
}
