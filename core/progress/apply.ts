/**
 * The one place a structured turn result becomes counter arithmetic —
 * AGENT.md §6.2 ("Define the mapping in one place and test it").
 *
 * Rules encoded here:
 * - only knowledge-point ids from the turn's target list are attributed; the
 *   rest are reported as unattributed and never fuzzy-matched (§6.2);
 * - several signals for one point in one turn collapse to at most one increment
 *   per counter, so a chatty model cannot double-count;
 * - the caller writes the deltas through an idempotent storage write, so
 *   replaying a turn is safe (§6.2).
 */
import type { TurnResult, TurnSignal } from "../domain/turn.js";
import type { ProgressDelta } from "../domain/progress.js";

export interface MappedProgress {
  readonly deltas: readonly ProgressDelta[];
  readonly unattributed: readonly TurnSignal[];
}

export function mapTurnResultToDeltas(
  result: TurnResult,
  targetIds: readonly string[],
  at: string,
): MappedProgress {
  const targets = new Set(targetIds);
  const attributed = new Map<string, Set<TurnSignal["outcome"]>>();
  const unattributed: TurnSignal[] = [];

  for (const signal of result.signals) {
    if (!targets.has(signal.knowledge_point_id)) {
      unattributed.push(signal);
      continue;
    }
    const outcomes = attributed.get(signal.knowledge_point_id) ?? new Set();
    outcomes.add(signal.outcome);
    attributed.set(signal.knowledge_point_id, outcomes);
  }

  const deltas: ProgressDelta[] = [];
  for (const [knowledgePointId, outcomes] of attributed) {
    // A turn judged wrong is wrong even if the model also claimed "used".
    const wrong = outcomes.has("wrong");
    deltas.push({
      knowledgePointId,
      // Any signal means the point was in play, so it counts as seen exactly once.
      seen: 1,
      used: !wrong && outcomes.has("used") ? 1 : 0,
      usedWithHelp: !wrong && outcomes.has("used_with_help") ? 1 : 0,
      wrong: wrong ? 1 : 0,
      lastSeenAt: at,
      lastWrongAt: wrong ? at : null,
    });
  }

  return { deltas, unattributed };
}
