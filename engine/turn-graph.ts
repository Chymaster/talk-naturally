/**
 * The per-message workflow — AGENT.md §18.2.
 *
 * A message is not handled by one monolithic system prompt. It enters a graph:
 * assemble context and targets, ask the model to decide, validate the untrusted
 * output, then route on the branch the model chose (attempt / question /
 * knowledge-point question / drift). The branch *set* is authored in
 * `core/prompts/turn.ts`; the model only picks among them.
 *
 * The core owns target selection and progress; the model owns phrasing (§6.3).
 */
import { Annotation, END, START, StateGraph } from "@langchain/langgraph";
import { mapTurnResultToDeltas } from "../core/progress/apply.js";
import {
  TURN_RESULT_JSON_SCHEMA,
  turnResultSchema,
  type TurnResult,
  type TurnSignal,
} from "../core/domain/turn.js";
import type { UserProgress } from "../core/domain/progress.js";
import type { ChatMessage } from "../core/ports/model.js";
import { TURN_PROMPT_VERSION, buildTurnSystemPrompt } from "../core/prompts/turn.js";
import { explainTarget, selectTargets } from "../core/steering/select-targets.js";
import type { ClassRecord } from "../core/domain/knowledge.js";
import {
  NO_CLASS_REPLY,
  TURN_FAILED_REPLY,
  type EngineDeps,
  type HandleTurnInput,
  type TurnOutcome,
} from "./types.js";

const MAX_OUTPUT_TOKENS = 700;

/**
 * Per-turn scratchpad. Every field is last-write-wins: nothing here is durable
 * state — the durable state is in storage behind the storage port (§3).
 */
const TurnState = Annotation.Root({
  // --- input ---
  learnerId: Annotation<string>({ reducer: (_previous, next) => next, default: () => "" }),
  classId: Annotation<string>({ reducer: (_previous, next) => next, default: () => "" }),
  incoming: Annotation<string>({ reducer: (_previous, next) => next, default: () => "" }),
  // --- assembled context ---
  turnId: Annotation<string>({ reducer: (_previous, next) => next, default: () => "" }),
  startedAt: Annotation<string>({ reducer: (_previous, next) => next, default: () => "" }),
  klass: Annotation<ClassRecord | null>({
    reducer: (_previous, next) => next,
    default: () => null,
  }),
  systemPrompt: Annotation<string>({ reducer: (_previous, next) => next, default: () => "" }),
  history: Annotation<ChatMessage[]>({
    reducer: (_previous, next) => next,
    default: () => [],
  }),
  targetIds: Annotation<string[]>({ reducer: (_previous, next) => next, default: () => [] }),
  progressByPoint: Annotation<Record<string, UserProgress>>({
    reducer: (_previous, next) => next,
    default: () => ({}),
  }),
  steeringSummary: Annotation<string>({ reducer: (_previous, next) => next, default: () => "" }),
  // --- model call ---
  parsedTurn: Annotation<unknown>({ reducer: (_previous, next) => next, default: () => null }),
  modelId: Annotation<string>({ reducer: (_previous, next) => next, default: () => "" }),
  usage: Annotation<{ inputTokens: number | null; outputTokens: number | null }>({
    reducer: (_previous, next) => next,
    default: () => ({ inputTokens: null, outputTokens: null }),
  }),
  modelError: Annotation<string | null>({
    reducer: (_previous, next) => next,
    default: () => null,
  }),
  // --- validation ---
  turnResult: Annotation<TurnResult | null>({
    reducer: (_previous, next) => next,
    default: () => null,
  }),
  validationError: Annotation<string | null>({
    reducer: (_previous, next) => next,
    default: () => null,
  }),
  // --- branch handling ---
  handledAs: Annotation<string>({ reducer: (_previous, next) => next, default: () => "unhandled" }),
  unattributed: Annotation<readonly TurnSignal[]>({
    reducer: (_previous, next) => next,
    default: () => [],
  }),
  appliedDeltas: Annotation<number>({ reducer: (_previous, next) => next, default: () => 0 }),
  // --- output ---
  reply: Annotation<string>({ reducer: (_previous, next) => next, default: () => "" }),
});

type TurnStateType = typeof TurnState.State;

export function buildTurnGraph(deps: EngineDeps) {
  const { storage, models, clock, ids, logger } = deps;

  const log = (event: Record<string, unknown>): void => {
    logger?.(event);
  };

  // --- 1. assemble: read persisted state, select targets in the core (§6.3) ---
  const assemble = async (state: TurnStateType): Promise<Partial<TurnStateType>> => {
    const klass = await storage.getClass(state.learnerId, state.classId);
    if (klass === null) {
      log({ event: "turn.no_class", learnerId: state.learnerId, classId: state.classId });
      return { klass: null, reply: NO_CLASS_REPLY, handledAs: "no_class" };
    }

    const progress = await storage.getProgress(state.learnerId, klass.id);
    const nowIso = clock.now().toISOString();
    const steering = selectTargets({ klass, progress, nowIso });

    const recent = await storage.recentMessages(state.learnerId, klass.id, 12);
    const history: ChatMessage[] = recent.map((message) => ({
      role: message.role === "learner" ? "user" : "assistant",
      content: message.content,
    }));

    const progressByPoint: Record<string, UserProgress> = {};
    for (const row of progress) {
      progressByPoint[row.knowledgePointId] = row;
    }

    // Every steering decision is explainable from a log line (§6.3, §7.9).
    log({
      event: "turn.targets_selected",
      learnerId: state.learnerId,
      classId: klass.id,
      steering: steering.summary,
      targets: steering.targets.map(explainTarget),
    });

    return {
      turnId: state.turnId === "" ? ids.newId() : state.turnId,
      startedAt: nowIso,
      klass,
      targetIds: steering.targets.map((target) => target.point.id),
      progressByPoint,
      steeringSummary: steering.summary,
      systemPrompt: buildTurnSystemPrompt({
        klass,
        targets: steering.targets,
        progressByPoint,
        steeringSummary: steering.summary,
      }),
      history,
    };
  };

  // --- 2. decide: the model picks the branch and phrases the reply (§18.2) ---
  const decide = async (state: TurnStateType): Promise<Partial<TurnStateType>> => {
    if (state.klass === null) {
      return {};
    }
    try {
      const model = await models.forLearner(state.learnerId);
      const completion = await model.complete({
        system: state.systemPrompt,
        messages: [...state.history, { role: "user", content: state.incoming }],
        schemaName: "TurnResult",
        schema: TURN_RESULT_JSON_SCHEMA,
        maxOutputTokens: MAX_OUTPUT_TOKENS,
      });
      return {
        parsedTurn: completion.parsed,
        modelId: completion.model,
        usage: completion.usage,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // Provider failure must not corrupt session state or lose the message (§8).
      log({ event: "turn.model_error", learnerId: state.learnerId, message });
      return { modelError: message, reply: TURN_FAILED_REPLY };
    }
  };

  // --- 3. validate: untrusted model output is untrusted (§8) ---
  const validate = async (state: TurnStateType): Promise<Partial<TurnStateType>> => {
    if (state.klass === null || state.modelError !== null) {
      return { handledAs: "provider_failed" };
    }
    const result = turnResultSchema.safeParse(state.parsedTurn);
    if (!result.success) {
      const detail = result.error.issues
        .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
        .join("; ");
      log({ event: "turn.invalid_output", learnerId: state.learnerId, detail });
      return { validationError: detail, handledAs: "invalid_output", reply: TURN_FAILED_REPLY };
    }
    return { turnResult: result.data };
  };

  // --- 4. branch handling: the model chose the branch, the graph routes it ---
  const attemptJudged = async (state: TurnStateType): Promise<Partial<TurnStateType>> => {
    const corrections = state.turnResult?.corrections.length ?? 0;
    log({
      event: "turn.branch",
      branch: "attempt_judged",
      corrections,
      signals: state.turnResult?.signals.length ?? 0,
    });
    return { handledAs: corrections > 0 ? "corrected" : "accepted" };
  };

  const correctionBranch = async (): Promise<Partial<TurnStateType>> => ({
    handledAs: "corrected",
  });
  const acceptedBranch = async (): Promise<Partial<TurnStateType>> => ({
    handledAs: "accepted",
  });

  const questionBranch = async (state: TurnStateType): Promise<Partial<TurnStateType>> => {
    log({ event: "turn.branch", branch: "question" });
    return { handledAs: "answered_question" };
  };

  const kpQuestionBranch = async (state: TurnStateType): Promise<Partial<TurnStateType>> => {
    log({ event: "turn.branch", branch: "kp_question" });
    return { handledAs: "answered_knowledge_point_question" };
  };

  /** Drift is handled and softly re-anchored, never clamped (§7.3). */
  const driftBranch = async (state: TurnStateType): Promise<Partial<TurnStateType>> => {
    log({ event: "turn.branch", branch: "drift" });
    return { handledAs: "reanchored_after_drift" };
  };

  const failedBranch = async (state: TurnStateType): Promise<Partial<TurnStateType>> => {
    // Keep the learner's message; leave progress untouched (§8).
    await storage.appendMessage(state.learnerId, {
      learnerId: state.learnerId,
      classId: state.classId,
      role: "learner",
      content: state.incoming,
      at: state.startedAt,
      turnId: state.turnId,
    });
    return {};
  };

  // --- 5. persist: at most one progress update per turn, by id, idempotent (§6.2) ---
  const persist = async (state: TurnStateType): Promise<Partial<TurnStateType>> => {
    const result = state.turnResult;
    if (result === null) {
      return { appliedDeltas: 0 };
    }

    const mapped = mapTurnResultToDeltas(result, state.targetIds, state.startedAt);
    if (mapped.unattributed.length > 0) {
      // Unattributable signals are logged, never guessed onto an id (§6.2).
      log({
        event: "turn.unattributed_signals",
        learnerId: state.learnerId,
        signals: mapped.unattributed.map((signal) => signal.knowledge_point_id),
      });
    }

    const applied = await storage.applyProgressDeltas(
      state.learnerId,
      state.turnId,
      mapped.deltas,
    );

    await storage.appendMessage(state.learnerId, {
      learnerId: state.learnerId,
      classId: state.classId,
      role: "learner",
      content: state.incoming,
      at: state.startedAt,
      turnId: state.turnId,
    });
    await storage.appendMessage(state.learnerId, {
      learnerId: state.learnerId,
      classId: state.classId,
      role: "agent",
      content: result.reply,
      at: state.startedAt,
      turnId: state.turnId,
    });
    await storage.recordTurn(state.learnerId, {
      turnId: state.turnId,
      learnerId: state.learnerId,
      classId: state.classId,
      incoming: state.incoming,
      reply: result.reply,
      branch: result.branch,
      targetIds: state.targetIds,
      steeringReason: state.steeringSummary,
      createdAt: state.startedAt,
    });

    return {
      unattributed: mapped.unattributed,
      appliedDeltas: applied.applied.length,
      reply: result.reply,
    };
  };

  const deliver = async (state: TurnStateType): Promise<Partial<TurnStateType>> => ({
    reply: state.reply === "" ? TURN_FAILED_REPLY : state.reply,
  });

  // --- routing ---
  const routeAfterValidate = (state: TurnStateType): string => {
    if (state.turnResult === null) {
      return "failed";
    }
    switch (state.turnResult.branch) {
      case "attempt_judged":
        return "attempt_judged";
      case "question":
        return "question";
      case "kp_question":
        return "kp_question";
      case "drift":
        return "drift";
    }
  };

  const routeAttempt = (state: TurnStateType): string =>
    state.handledAs === "corrected" ? "attempt_corrected" : "attempt_accepted";

  return new StateGraph(TurnState)
    .addNode("assemble", assemble)
    .addNode("decide", decide)
    .addNode("validate", validate)
    .addNode("attempt_judged", attemptJudged)
    .addNode("attempt_corrected", correctionBranch)
    .addNode("attempt_accepted", acceptedBranch)
    .addNode("question", questionBranch)
    .addNode("kp_question", kpQuestionBranch)
    .addNode("drift", driftBranch)
    .addNode("failed", failedBranch)
    .addNode("persist", persist)
    .addNode("deliver", deliver)
    .addEdge(START, "assemble")
    .addConditionalEdges("assemble", (state: TurnStateType) =>
      state.klass === null ? "no_class" : "decide", {
      no_class: "deliver",
      decide: "decide",
    })
    .addEdge("decide", "validate")
    .addConditionalEdges("validate", routeAfterValidate, {
      attempt_judged: "attempt_judged",
      question: "question",
      kp_question: "kp_question",
      drift: "drift",
      failed: "failed",
    })
    .addConditionalEdges("attempt_judged", routeAttempt, {
      attempt_corrected: "attempt_corrected",
      attempt_accepted: "attempt_accepted",
    })
    .addEdge("attempt_corrected", "persist")
    .addEdge("attempt_accepted", "persist")
    .addEdge("question", "persist")
    .addEdge("kp_question", "persist")
    .addEdge("drift", "persist")
    .addEdge("failed", "deliver")
    .addEdge("persist", "deliver")
    .addEdge("deliver", END)
    .compile();
}

/** The prompt version is part of every turn's provenance (§7.7). */
export const TURN_GRAPH_PROMPT_VERSION = TURN_PROMPT_VERSION;

export type { HandleTurnInput, TurnOutcome };
