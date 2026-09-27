/**
 * Derived progress state — design/30-domain-model.md §1.
 *
 * Counters are the source of truth; everything here is recomputed, so the
 * formula can change without losing history. Nothing in this file is persisted.
 */
import type { UserProgress } from "../domain/progress.js";

/** A point not seen for this long is due for review (design/40-steering.md §4). */
export const DUE_AFTER_MS = 48 * 60 * 60 * 1000;

export interface DerivedProgress {
 /** Never seen, or not seen for a while. */
 readonly due: boolean;
 /** Wrong or helped relative to independent use — a raw count, not a ratio. */
 readonly struggle: number;
 /** In the class but never exposed to this learner. */
 readonly unattempted: boolean;
 /** Seen, but never produced unprompted. */
 readonly consolidating: boolean;
}

export function deriveProgress(
 progress: UserProgress,
 nowIso: string,
): DerivedProgress {
 const unattempted = progress.timesSeen === 0;
 const lastSeenMs = progress.lastSeenAt === null ? null : Date.parse(progress.lastSeenAt);
 const due =
 unattempted ||
 lastSeenMs === null ||
 Number.isNaN(lastSeenMs) ||
 Date.parse(nowIso) - lastSeenMs >= DUE_AFTER_MS;

 return {
 due,
 struggle: progress.timesWrong + progress.timesUsedWithHelp,
 unattempted,
 consolidating: progress.timesSeen > 0 && progress.timesUsed === 0,
 };
}
