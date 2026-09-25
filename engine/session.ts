/**
 * Scheduler-started session — AGENT.md §18.1.
 *
 * The scheduler reads progress, picks the starting point via `select_targets`
 * (§6.3), sends the opening message, then waits for the learner. A single-step
 * flow does not need a graph, but it uses the same ports and the same
 * validation discipline as a turn.
 */
import { openingResultSchema, OPENING_JSON_SCHEMA } from "../core/domain/opening.js";
import {
  OPENING_PROMPT_VERSION,
  buildOpeningSystemPrompt,
  buildOpeningUserMessage,
} from "../core/prompts/session.js";
import { explainTarget, selectTargets } from "../core/steering/select-targets.js";
import {
  NO_CLASS_REPLY,
  TURN_FAILED_REPLY,
  type EngineDeps,
  type StartSessionInput,
  type TurnOutcome,
} from "./types.js";

const MAX_OUTPUT_TOKENS = 300;

const NO_TARGETS_REPLY =
  "There is nothing left to practise in this class right now. Send me new material whenever you like.";

export async function startSession(
  deps: EngineDeps,
  input: StartSessionInput,
): Promise<TurnOutcome> {
  const { storage, models, clock, ids, logger } = deps;
  const turnId = ids.newId();
  const nowIso = clock.now().toISOString();

  const base: TurnOutcome = {
    reply: NO_CLASS_REPLY,
    branch: "opening",
    handledAs: "no_class",
    targetIds: [],
    steeringReason: "",
    unattributedSignals: 0,
    appliedDeltas: 0,
    promptVersion: OPENING_PROMPT_VERSION,
    modelId: "",
    usage: { inputTokens: null, outputTokens: null },
    turnId,
  };

  const klass = await storage.getClass(input.learnerId, input.classId);
  if (klass === null) {
    logger?.({ event: "session.no_class", learnerId: input.learnerId, classId: input.classId });
    return base;
  }

  const progress = await storage.getProgress(input.learnerId, klass.id);
  const steering = selectTargets({ klass, progress, nowIso });
  const target = steering.targets[0];
  if (target === undefined) {
    return { ...base, reply: NO_TARGETS_REPLY, handledAs: "no_targets", steeringReason: steering.summary };
  }

  logger?.({
    event: "session.targets_selected",
    learnerId: input.learnerId,
    classId: klass.id,
    steering: steering.summary,
    chosen: explainTarget(target),
  });

  let reply = TURN_FAILED_REPLY;
  let handledAs = "provider_failed";
  let modelId = "";
  let usage = { inputTokens: null as number | null, outputTokens: null as number | null };

  try {
    const model = await models.forLearner(input.learnerId);
    const completion = await model.complete({
      system: buildOpeningSystemPrompt({ klass, target }),
      messages: [{ role: "user", content: buildOpeningUserMessage() }],
      schemaName: "OpeningMessage",
      schema: OPENING_JSON_SCHEMA,
      maxOutputTokens: MAX_OUTPUT_TOKENS,
    });
    modelId = completion.model;
    usage = completion.usage;
    const parsed = openingResultSchema.safeParse(completion.parsed);
    if (parsed.success) {
      reply = parsed.data.reply;
      handledAs = "opened";
    } else {
      logger?.({ event: "session.invalid_output", learnerId: input.learnerId });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger?.({ event: "session.model_error", learnerId: input.learnerId, message });
  }

  if (handledAs === "opened") {
    await storage.appendMessage(input.learnerId, {
      learnerId: input.learnerId,
      classId: klass.id,
      role: "agent",
      content: reply,
      at: nowIso,
      turnId,
    });
    await storage.recordTurn(input.learnerId, {
      turnId,
      learnerId: input.learnerId,
      classId: klass.id,
      incoming: "(scheduled session start)",
      reply,
      branch: "opening",
      targetIds: [target.point.id],
      steeringReason: steering.summary,
      createdAt: nowIso,
    });
    const schedule = await storage.getSchedule(input.learnerId);
    if (schedule !== null) {
      await storage.setSchedule(input.learnerId, { ...schedule, lastSessionAt: nowIso });
    }
  }

  return {
    reply,
    branch: handledAs === "opened" ? "opening" : "failed",
    handledAs,
    targetIds: [target.point.id],
    steeringReason: steering.summary,
    unattributedSignals: 0,
    appliedDeltas: 0,
    promptVersion: OPENING_PROMPT_VERSION,
    modelId,
    usage,
    turnId,
  };
}
