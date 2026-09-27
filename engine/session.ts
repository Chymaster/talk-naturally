/**
 * Session start — design/50-orchestration.md §2.
 *
 * The scheduler or the learner's `/new` command reads progress, picks the
 * starting point via `select_targets` (40-steering), sends the opening message,
 * then waits for the learner. A single-step flow does not need a graph, but it
 * uses the same ports and the same validation discipline as a turn.
 *
 * A session never opens before onboarding is complete (design/60-ingestion.md §3).
 */
import { openingResultSchema, OPENING_JSON_SCHEMA } from "../core/domain/opening.js";
import { isOnboarded } from "../core/domain/settings.js";
import { pendingQuestionOf } from "../core/domain/turn.js";
import {
 OPENING_PROMPT_VERSION,
 buildOpeningSystemPrompt,
 buildOpeningUserMessage,
} from "../core/prompts/session.js";
import { explainTarget, selectTargets } from "../core/steering/select-targets.js";
import { assembleScope } from "./scope.js";
import { nextOnboardingQuestion } from "./onboarding.js";
import {
 NO_CLASS_REPLY,
 TURN_FAILED_REPLY,
 type EngineDeps,
 type StartConversationInput,
 type StartSessionInput,
 type TurnOutcome,
} from "./types.js";

const MAX_OUTPUT_TOKENS = 300;

const NO_TARGETS_REPLY =
 "There is nothing left to practise in this class right now. Send me new material whenever you like.";

const NEEDS_ONBOARDING_REPLY =
 "We are not set up yet — tell me which language you are learning and we will start there.";

/**
 * The learner commands that start a new conversation
 * (design/50-orchestration.md §2, D-032). `/start` is kept as an alias so the
 * existing Discord slash command and a typed `/start` mean the same thing.
 */
export const NEW_CONVERSATION_COMMANDS = ["/new", "/start"] as const;

/** True when a chat command asks for a new conversation rather than settings. */
export function isNewConversationCommand(text: string): boolean {
 const head = text.trim().split(/\s+/u)[0]?.toLowerCase() ?? "";
 return (NEW_CONVERSATION_COMMANDS as readonly string[]).includes(head);
}

/**
 * The learner's `/new` (alias `/start`) — design/50-orchestration.md §2.
 *
 * This is session start with `reason: new_conversation`: the opening replaces
 * the question on the table instead of repeating it, so it never enters the turn
 * graph and the re-ask rule (D-031) is untouched.
 */
export async function startConversation(
 deps: EngineDeps,
 input: StartConversationInput,
): Promise<TurnOutcome> {
 return startSession(deps, {
 learnerId: input.learnerId,
 ...(input.classId === undefined ? {} : { classId: input.classId }),
 channel: input.channel,
 incoming: input.incoming ?? "/new",
 reason: "new_conversation",
 });
}

export async function startSession(
 deps: EngineDeps,
 input: StartSessionInput,
): Promise<TurnOutcome> {
 const { storage, models, clock, ids, logger } = deps;
 const turnId = ids.newId();
 const nowIso = clock.now().toISOString();
 // A learner-requested new conversation opens differently from a scheduled one
 // (design/50-orchestration.md §2, D-032).
 const newConversation = input.reason === "new_conversation";

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

 const settings = await storage.getLearnerSettings(input.learnerId);
 if (!isOnboarded(settings)) {
 // A session never opens before onboarding is complete: ask the pending
 // question instead (design/50-orchestration.md §2, design/60-ingestion.md §3).
 let reply = NEEDS_ONBOARDING_REPLY;
 if (deps.catalog !== undefined) {
 reply = await nextOnboardingQuestion(
 {
 storage,
 clock,
 catalog: deps.catalog,
 ...(logger === undefined ? {} : { logger }),
 },
 input.learnerId,
 );
 }
 logger?.({ event: "session.needs_onboarding", learnerId: input.learnerId });
 return { ...base, reply, handledAs: "needs_onboarding" };
 }

 const classId = input.classId ?? settings?.classId ?? "";
 const klass = await storage.getClass(input.learnerId, classId);
 if (klass === null) {
 logger?.({ event: "session.no_class", learnerId: input.learnerId, classId });
 return base;
 }

 // The question the learner is leaving behind is the last question the app
 // asked, exactly as the turn graph reads it (design/50-orchestration.md §3.5).
 // Only a new conversation carries it into the opening prompt.
 const previousQuestion = newConversation
 ? pendingQuestionOf(await storage.recentMessages(input.learnerId, klass.id, 12))
 : "";

 if (newConversation) {
 logger?.({
 event: "session.new_conversation",
 learnerId: input.learnerId,
 classId: klass.id,
 replacingQuestion: previousQuestion.length > 0,
 });
 }

 const { scope, progress } = await assembleScope(
 storage,
 input.learnerId,
 klass,
 settings,
 logger,
 );
 const steering = selectTargets({ scope, progress, nowIso });
 const target = steering.targets[0];
 if (target === undefined) {
 return { ...base, reply: NO_TARGETS_REPLY, handledAs: "no_targets", steeringReason: steering.summary };
 }

 logger?.({
 event: "session.targets_selected",
 learnerId: input.learnerId,
 classId: klass.id,
 scope: scope.levels.join("+"),
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
 system: buildOpeningSystemPrompt({
 klass,
 target,
 ...(newConversation ? { learnerRequested: true, previousQuestion } : {}),
 }),
 messages: [{ role: "user", content: buildOpeningUserMessage(newConversation) }],
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
 incoming: input.incoming ?? (newConversation ? "/new" : "(scheduled session start)"),
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
