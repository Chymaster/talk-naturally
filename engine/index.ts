/**
 * Composition helper for the engine.
 *
 * The engine receives its ports here — it never constructs an adapter itself.
 * The host is the only place that decides which implementation to pass in
 * (AGENT.md §3, composition root).
 */
import { TURN_PROMPT_VERSION } from "../core/prompts/turn.js";
import { startSession } from "./session.js";
import { buildTurnGraph } from "./turn-graph.js";
import type {
  ConversationEngine,
  EngineDeps,
  HandleTurnInput,
  StartSessionInput,
  TurnOutcome,
} from "./types.js";

export function createEngine(deps: EngineDeps): ConversationEngine {
  const graph = buildTurnGraph(deps);

  return {
    async handleTurn(input: HandleTurnInput): Promise<TurnOutcome> {
      const final = await graph.invoke({
        learnerId: input.learnerId,
        classId: input.classId,
        incoming: input.text,
        turnId: deps.ids.newId(),
        startedAt: deps.clock.now().toISOString(),
      });

      return {
        reply: final.reply,
        branch: final.turnResult?.branch ?? "failed",
        handledAs: final.handledAs,
        targetIds: final.targetIds,
        steeringReason: final.steeringSummary,
        unattributedSignals: final.unattributed.length,
        appliedDeltas: final.appliedDeltas,
        promptVersion: TURN_PROMPT_VERSION,
        modelId: final.modelId,
        usage: final.usage,
        turnId: final.turnId,
      };
    },

    async startSession(input: StartSessionInput): Promise<TurnOutcome> {
      return startSession(deps, input);
    },
  };
}

export { startSession } from "./session.js";
export { buildTurnGraph, TURN_GRAPH_PROMPT_VERSION } from "./turn-graph.js";
export * from "./types.js";
