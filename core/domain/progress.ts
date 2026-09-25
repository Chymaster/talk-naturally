/**
 * Per-learner, per-knowledge-point progress — AGENT.md §6.1/§6.2.
 *
 * Only countable facts are stored. Mastery, confidence, and "next review" are
 * derived (§6.1) — see `core/progress/derive.ts`.
 */

export interface UserProgress {
  readonly learnerId: string;
  readonly knowledgePointId: string;
  /** Introduced, or the model used it in a reply ("read"). */
  readonly timesSeen: number;
  /** The learner produced it themselves, unassisted. */
  readonly timesUsed: number;
  /** The learner produced it after a hint or correction. */
  readonly timesUsedWithHelp: number;
  /** Attempts judged incorrect. */
  readonly timesWrong: number;
  readonly lastSeenAt: string | null;
  readonly lastWrongAt: string | null;
  /** Short learner-specific observation. A hint, never the model. */
  readonly notes: string;
}

export function blankProgress(
  learnerId: string,
  knowledgePointId: string,
): UserProgress {
  return {
    learnerId,
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

/**
 * A counter change to apply, produced by `core/progress/apply.ts` — the single
 * place where a structured turn result becomes counter arithmetic (§6.2).
 */
export interface ProgressDelta {
  readonly knowledgePointId: string;
  readonly seen: number;
  readonly used: number;
  readonly usedWithHelp: number;
  readonly wrong: number;
  readonly lastSeenAt: string | null;
  readonly lastWrongAt: string | null;
}

export function emptyDelta(knowledgePointId: string): ProgressDelta {
  return {
    knowledgePointId,
    seen: 0,
    used: 0,
    usedWithHelp: 0,
    wrong: 0,
    lastSeenAt: null,
    lastWrongAt: null,
  };
}

export function applyDelta(
  progress: UserProgress,
  delta: ProgressDelta,
  at: string,
): UserProgress {
  return {
    ...progress,
    timesSeen: progress.timesSeen + delta.seen,
    timesUsed: progress.timesUsed + delta.used,
    timesUsedWithHelp: progress.timesUsedWithHelp + delta.usedWithHelp,
    timesWrong: progress.timesWrong + delta.wrong,
    lastSeenAt: delta.lastSeenAt ?? progress.lastSeenAt,
    lastWrongAt: delta.lastWrongAt ?? progress.lastWrongAt,
    notes: progress.notes,
  };
}

/** Total counters — used by tests and the CLI transcript. */
export function progressTotals(rows: readonly UserProgress[]): {
  seen: number;
  used: number;
  usedWithHelp: number;
  wrong: number;
} {
  return rows.reduce(
    (acc, row) => ({
      seen: acc.seen + row.timesSeen,
      used: acc.used + row.timesUsed,
      usedWithHelp: acc.usedWithHelp + row.timesUsedWithHelp,
      wrong: acc.wrong + row.timesWrong,
    }),
    { seen: 0, used: 0, usedWithHelp: 0, wrong: 0 },
  );
}
