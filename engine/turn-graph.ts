/**
 * The per-message workflow — design/50-orchestration.md §3.
 *
 * A message is not handled by one monolithic system prompt. It enters a graph:
 * decide whether the learner is set up at all, assemble context and targets,
 * classify the message, then write the learner-facing reply in separate,
 * single-language model calls. Onboarding is a deterministic route that makes no
 * model call (design/60-ingestion.md §3).
 *
 * The core owns target selection and progress; the model owns phrasing
 * (design/40-steering.md §1).
 */
import { Annotation, END, START, StateGraph } from "@langchain/langgraph";
import { mapTurnDecisionToDeltas } from "../core/progress/apply.js";
import {
 ANSWER_JSON_SCHEMA,
 CONTINUATION_JSON_SCHEMA,
 TURN_DECISION_JSON_SCHEMA,
 answerResultSchema,
 continuationResultSchema,
 pendingQuestionOf,
 turnDecisionSchema,
 type TurnDecision,
 type TurnSignal,
} from "../core/domain/turn.js";
import type { UserProgress } from "../core/domain/progress.js";
import type { ChatMessage, TokenUsage } from "../core/ports/model.js";
import {
 TURN_PROMPT_VERSION,
 buildAnswerSystemPrompt,
 buildClassifySystemPrompt,
 buildContinuationSystemPrompt,
} from "../core/prompts/turn.js";
import { explainTarget, selectTargets, type ScoredTarget } from "../core/steering/select-targets.js";
import { assembleScope } from "./scope.js";
import {
 currentUnitOf,
 isOnboarded,
 type LearnerSettings,
} from "../core/domain/settings.js";
import type { ClassRecord } from "../core/domain/knowledge.js";
import {
 NO_CLASS_REPLY,
 TURN_FAILED_REPLY,
 type EngineDeps,
 type HandleTurnInput,
 type TurnOutcome,
} from "./types.js";
import { handleOnboardingTurn } from "./onboarding.js";
import { startSession } from "./session.js";

const MAX_CLASSIFY_TOKENS = 700;
const MAX_ANSWER_TOKENS = 400;
const MAX_CONTINUE_TOKENS = 400;

function addTokens(left: number | null, right: number | null): number | null {
 if (left === null && right === null) {
 return null;
 }
 return (left ?? 0) + (right ?? 0);
}

function addUsage(
 previous: { readonly inputTokens: number | null; readonly outputTokens: number | null },
 next: TokenUsage,
): { inputTokens: number | null; outputTokens: number | null } {
 return {
 inputTokens: addTokens(previous.inputTokens, next.inputTokens),
 outputTokens: addTokens(previous.outputTokens, next.outputTokens),
 };
}

function joinParts(parts: readonly string[]): string {
 return parts
 .map((part) => part.trim())
 .filter((part) => part.length > 0)
 .join("\n\n");
}

/**
 * Per-turn scratchpad. Every field is last-write-wins: nothing here is durable
 * state — the durable state is in storage behind the storage port (design/20-architecture.md §2).
 */
const TurnState = Annotation.Root({
 // --- input ---
 learnerId: Annotation<string>({ reducer: (_previous, next) => next, default: () => "" }),
 classId: Annotation<string>({ reducer: (_previous, next) => next, default: () => "" }),
 incoming: Annotation<string>({ reducer: (_previous, next) => next, default: () => "" }),
 // --- assembled context ---
 turnId: Annotation<string>({ reducer: (_previous, next) => next, default: () => "" }),
 startedAt: Annotation<string>({ reducer: (_previous, next) => next, default: () => "" }),
 settings: Annotation<LearnerSettings | null>({
 reducer: (_previous, next) => next,
 default: () => null,
 }),
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
 targets: Annotation<ScoredTarget[]>({ reducer: (_previous, next) => next, default: () => [] }),
 progressByPoint: Annotation<Record<string, UserProgress>>({
 reducer: (_previous, next) => next,
 default: () => ({}),
 }),
 steeringSummary: Annotation<string>({ reducer: (_previous, next) => next, default: () => "" }),
 chapter: Annotation<string>({ reducer: (_previous, next) => next, default: () => "" }),
 scopeLevels: Annotation<string[]>({ reducer: (_previous, next) => next, default: () => [] }),
 /** The question the learner still has to answer (design/50-orchestration.md §3.5). */
 pendingQuestion: Annotation<string>({ reducer: (_previous, next) => next, default: () => "" }),
 // --- classify call ---
 parsedDecision: Annotation<unknown>({ reducer: (_previous, next) => next, default: () => null }),
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
 decision: Annotation<TurnDecision | null>({
 reducer: (_previous, next) => next,
 default: () => null,
 }),
 validationError: Annotation<string | null>({
 reducer: (_previous, next) => next,
 default: () => null,
 }),
 // --- branch handling ---
 handledAs: Annotation<string>({ reducer: (_previous, next) => next, default: () => "unhandled" }),
 branch: Annotation<string>({ reducer: (_previous, next) => next, default: () => "" }),
 unattributed: Annotation<readonly TurnSignal[]>({
 reducer: (_previous, next) => next,
 default: () => [],
 }),
 appliedDeltas: Annotation<number>({ reducer: (_previous, next) => next, default: () => 0 }),
 // --- prose calls ---
 answerText: Annotation<string>({ reducer: (_previous, next) => next, default: () => "" }),
 continuationText: Annotation<string>({ reducer: (_previous, next) => next, default: () => "" }),
 // --- output ---
 reply: Annotation<string>({ reducer: (_previous, next) => next, default: () => "" }),
});

type TurnStateType = typeof TurnState.State;

export function buildTurnGraph(deps: EngineDeps) {
 const { storage, models, clock, ids, logger, catalog } = deps;

 const log = (event: Record<string, unknown>): void => {
 logger?.(event);
 };

 // --- 0. route: onboarding is deterministic and makes no model call (design/60-ingestion.md §3) ---
 const route = async (state: TurnStateType): Promise<Partial<TurnStateType>> => {
 const settings = await storage.getLearnerSettings(state.learnerId);
 const classId = state.classId.length > 0 ? state.classId : settings?.classId ?? "";
 return { settings, classId };
 };

 const routeSettings = (state: TurnStateType): string =>
 isOnboarded(state.settings) ? "assemble" : "onboarding";

 const onboarding = async (state: TurnStateType): Promise<Partial<TurnStateType>> => {
 const startedAt = state.startedAt === "" ? clock.now().toISOString() : state.startedAt;
 const turnId = state.turnId === "" ? ids.newId() : state.turnId;
 if (catalog === undefined) {
 log({ event: "turn.onboarding_unavailable", learnerId: state.learnerId });
 return {
 reply: "This server has no built-in material configured yet. Ask the operator to set it up.",
 handledAs: "onboarding_unavailable",
 branch: "onboarding",
 startedAt,
 turnId,
 };
 }
 const outcome = await handleOnboardingTurn(
 { storage, clock, catalog, ...(logger === undefined ? {} : { logger }) },
 state.learnerId,
 state.incoming,
 );
 return {
 reply: outcome.reply,
 handledAs: outcome.handledAs,
 branch: "onboarding",
 startedAt,
 turnId,
 };
 };

 /**
 * The learner has just finished setup, so the app asks the first question
 * instead of waiting for them to write (design/50-orchestration.md §2). This
 * reuses the session-start path; onboarding itself stays model-free, and if
 * opening fails the setup confirmation from `onboarding` is kept.
 */
 const open = async (state: TurnStateType): Promise<Partial<TurnStateType>> => {
 const outcome = await startSession(deps, {
 learnerId: state.learnerId,
 channel: "engine",
 incoming: "(first session after onboarding)",
 });
 if (outcome.handledAs !== "opened") {
 log({
 event: "turn.first_question_skipped",
 learnerId: state.learnerId,
 reason: outcome.handledAs,
 });
 return {};
 }
 return {
 reply: outcome.reply,
 handledAs: "onboarding_opened",
 branch: "opening",
 targetIds: [...outcome.targetIds],
 steeringSummary: outcome.steeringReason,
 modelId: outcome.modelId,
 usage: outcome.usage,
 turnId: outcome.turnId,
 };
 };

 const routeAfterOnboarding = (state: TurnStateType): string =>
 state.handledAs === "onboarding_done" ? "open" : "deliver";

 // --- 1. assemble: read persisted state, select targets in the core (design/40-steering.md) ---
 const assemble = async (state: TurnStateType): Promise<Partial<TurnStateType>> => {
 const klass = await storage.getClass(state.learnerId, state.classId);
 if (klass === null) {
 log({ event: "turn.no_class", learnerId: state.learnerId, classId: state.classId });
 return { klass: null, reply: NO_CLASS_REPLY, handledAs: "no_class" };
 }

 // The pool is the primary level plus any included earlier levels (design/40-steering.md §3).
 const { scope, progress: progressRows } = await assembleScope(
 storage,
 state.learnerId,
 klass,
 state.settings,
 logger,
 );

 const nowIso = clock.now().toISOString();
 const steering = selectTargets({ scope, progress: progressRows, nowIso });

 const recent = await storage.recentMessages(state.learnerId, klass.id, 12);
 const history: ChatMessage[] = recent.map((message) => ({
 role: message.role === "learner" ? "user" : "assistant",
 content: message.content,
 }));

 // The question on the table is the last question the app asked
 // (design/50-orchestration.md §3.5).
 const pendingQuestion = pendingQuestionOf(recent);

 const progressByPoint: Record<string, UserProgress> = {};
 for (const row of progressRows) {
 progressByPoint[row.knowledgePointId] = row;
 }

 const chapter = currentUnitOf(klass, progressRows, state.settings?.knownThroughUnit ?? 0);

 // Every steering decision is explainable from a log line (40-steering, design/20-architecture.md §4).
 log({
 event: "turn.targets_selected",
 learnerId: state.learnerId,
 classId: klass.id,
 scope: scope.levels.join("+"),
 chapter: chapter?.unit ?? null,
 steering: steering.summary,
 targets: steering.targets.map(explainTarget),
 });

 return {
 turnId: state.turnId === "" ? ids.newId() : state.turnId,
 startedAt: nowIso,
 klass,
 targetIds: steering.targets.map((target) => target.point.id),
 targets: [...steering.targets],
 progressByPoint,
 steeringSummary: steering.summary,
 chapter: chapter?.unit ?? "",
 scopeLevels: [...scope.levels],
 pendingQuestion,
 systemPrompt: buildClassifySystemPrompt({
 klass,
 targets: steering.targets,
 progressByPoint,
 steeringSummary: steering.summary,
 level: klass.level,
 chapter: chapter?.unit ?? null,
 scopeLevels: scope.levels,
 pendingQuestion,
 }),
 history,
 };
 };

 // --- 2. classify: the model picks the branch and extracts signals, no prose (design/50-orchestration.md §3.4) ---
 const classify = async (state: TurnStateType): Promise<Partial<TurnStateType>> => {
 if (state.klass === null) {
 return {};
 }
 try {
 const model = await models.forLearner(state.learnerId);
 const completion = await model.complete({
 system: state.systemPrompt,
 messages: [...state.history, { role: "user", content: state.incoming }],
 schemaName: "TurnDecision",
 schema: TURN_DECISION_JSON_SCHEMA,
 maxOutputTokens: MAX_CLASSIFY_TOKENS,
 });
 return {
 parsedDecision: completion.parsed,
 modelId: completion.model,
 usage: addUsage(state.usage, completion.usage),
 };
 } catch (error) {
 const message = error instanceof Error ? error.message : String(error);
 // Provider failure must not corrupt session state or lose the message (design/20-architecture.md §5).
 log({ event: "turn.model_error", learnerId: state.learnerId, message });
 return { modelError: message, reply: TURN_FAILED_REPLY };
 }
 };

 // --- 3. validate: untrusted model output is untrusted (design/20-architecture.md §5) ---
 const validate = async (state: TurnStateType): Promise<Partial<TurnStateType>> => {
 if (state.klass === null || state.modelError !== null) {
 return { handledAs: "provider_failed" };
 }
 const result = turnDecisionSchema.safeParse(state.parsedDecision);
 if (!result.success) {
 const detail = result.error.issues
 .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
 .join("; ");
 log({ event: "turn.invalid_output", learnerId: state.learnerId, detail });
 return { validationError: detail, handledAs: "invalid_output", reply: TURN_FAILED_REPLY };
 }
 return { decision: result.data };
 };

 // --- 4. branch handling: the model chose the branch, the graph routes it ---
 const attemptJudged = async (state: TurnStateType): Promise<Partial<TurnStateType>> => {
 const corrections = state.decision?.corrections.length ?? 0;
 log({
 event: "turn.branch",
 branch: "attempt_judged",
 corrections,
 signals: state.decision?.signals.length ?? 0,
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

 /** Drift is handled and softly re-anchored, never clamped (design/20-architecture.md §4). */
 const driftBranch = async (state: TurnStateType): Promise<Partial<TurnStateType>> => {
 log({ event: "turn.branch", branch: "drift" });
 return { handledAs: "reanchored_after_drift" };
 };

 /**
 * The answer call — an answer to a question, an explanation of a correction, or
 * an acknowledgement of drift — written in one language, so the model never has
 * to switch language mid-message (design/50-orchestration.md §3.5).
 */
 const answer = async (state: TurnStateType): Promise<Partial<TurnStateType>> => {
 const klass = state.klass;
 const decision = state.decision;
 if (klass === null || decision === null) {
 return {};
 }
 try {
 const model = await models.forLearner(state.learnerId);
 const completion = await model.complete({
 system: buildAnswerSystemPrompt({
 klass,
 branch: decision.branch,
 incoming: state.incoming,
 corrections: decision.corrections,
 level: klass.level,
 chapter: state.chapter.length > 0 ? state.chapter : null,
 pendingQuestion: state.pendingQuestion,
 }),
 messages: [...state.history, { role: "user", content: state.incoming }],
 schemaName: "AnswerQuestion",
 schema: ANSWER_JSON_SCHEMA,
 maxOutputTokens: MAX_ANSWER_TOKENS,
 });
 const parsed = answerResultSchema.safeParse(completion.parsed);
 if (!parsed.success) {
 log({ event: "turn.answer_invalid", learnerId: state.learnerId, branch: decision.branch });
 return {};
 }
 return {
 answerText: parsed.data.reply,
 modelId: completion.model,
 usage: addUsage(state.usage, completion.usage),
 };
 } catch (error) {
 const message = error instanceof Error ? error.message : String(error);
 log({ event: "turn.answer_failed", learnerId: state.learnerId, message });
 return {};
 }
 };

 /**
 * The single place the graph checks whether the learner answered the question
 * on the table (design/50-orchestration.md §3.5). A clear attempt continues the
 * conversation; anything else repeats the question.
 */
 const answered = async (): Promise<Partial<TurnStateType>> => ({});

 const routeAnswered = (state: TurnStateType): string =>
 state.decision?.answered_previous_question === false ? "reask" : "continue_turn";

 /**
 * The continue call runs only when the learner answered the question on the
 * table, and it writes the whole next turn in the target language
 * (design/50-orchestration.md §3.5).
 */
 const continueTurn = async (state: TurnStateType): Promise<Partial<TurnStateType>> => {
 const klass = state.klass;
 const decision = state.decision;
 if (klass === null || decision === null) {
 return {};
 }
 try {
 const model = await models.forLearner(state.learnerId);
 const completion = await model.complete({
 system: buildContinuationSystemPrompt({
 klass,
 targets: state.targets,
 progressByPoint: state.progressByPoint,
 steeringSummary: state.steeringSummary,
 incoming: state.incoming,
 level: klass.level,
 chapter: state.chapter.length > 0 ? state.chapter : null,
 scopeLevels: state.scopeLevels,
 pendingQuestion: state.pendingQuestion,
 }),
 messages: [...state.history, { role: "user", content: state.incoming }],
 schemaName: "ContinueConversation",
 schema: CONTINUATION_JSON_SCHEMA,
 maxOutputTokens: MAX_CONTINUE_TOKENS,
 });
 const parsed = continuationResultSchema.safeParse(completion.parsed);
 if (!parsed.success) {
 log({ event: "turn.continue_invalid", learnerId: state.learnerId });
 return {};
 }
 return {
 continuationText: joinParts([parsed.data.feedback, parsed.data.question]),
 modelId: completion.model,
 usage: addUsage(state.usage, completion.usage),
 };
 } catch (error) {
 const message = error instanceof Error ? error.message : String(error);
 log({ event: "turn.continue_failed", learnerId: state.learnerId, message });
 return {};
 }
 };

 /**
 * The learner did not answer, so the app repeats the question on the table
 * instead of moving to a new one. The repeat is deterministic, so it is
 * word-for-word (design/50-orchestration.md §3.5).
 */
 const reask = async (state: TurnStateType): Promise<Partial<TurnStateType>> => {
 const question = state.pendingQuestion.trim();
 if (question.length === 0) {
 log({ event: "turn.reask_empty", learnerId: state.learnerId, branch: state.decision?.branch });
 return {};
 }
 log({ event: "turn.branch", branch: state.decision?.branch, reasked: true });
 return { handledAs: "reasked_previous_question", continuationText: question };
 };

 /**
 * Compose the learner-facing message from the single-language parts, with the
 * current question last (design/50-orchestration.md §3.5).
 */
 const compose = async (state: TurnStateType): Promise<Partial<TurnStateType>> => {
 const reply = joinParts([state.answerText, state.continuationText]);
 return { reply: reply.length > 0 ? reply : TURN_FAILED_REPLY };
 };

 const failedBranch = async (state: TurnStateType): Promise<Partial<TurnStateType>> => {
 // Keep the learner's message; leave progress untouched (design/20-architecture.md §5).
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

 // --- 5. persist: at most one progress update per turn, by id, idempotent (design/30-domain-model.md §2) ---
 const persist = async (state: TurnStateType): Promise<Partial<TurnStateType>> => {
 const result = state.decision;
 if (result === null) {
 return { appliedDeltas: 0 };
 }

 const mapped = mapTurnDecisionToDeltas(result, state.targetIds, state.startedAt);
 if (mapped.unattributed.length > 0) {
 // Unattributable signals are logged, never guessed onto an id (design/30-domain-model.md §2).
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

 const reply = state.reply === "" ? TURN_FAILED_REPLY : state.reply;
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
 content: reply,
 at: state.startedAt,
 turnId: state.turnId,
 });
 await storage.recordTurn(state.learnerId, {
 turnId: state.turnId,
 learnerId: state.learnerId,
 classId: state.classId,
 incoming: state.incoming,
 reply,
 branch: result.branch,
 targetIds: state.targetIds,
 steeringReason: state.steeringSummary,
 createdAt: state.startedAt,
 });

 return {
 unattributed: mapped.unattributed,
 appliedDeltas: applied.applied.length,
 reply,
 };
 };

 const deliver = async (state: TurnStateType): Promise<Partial<TurnStateType>> => ({
 reply: state.reply === "" ? TURN_FAILED_REPLY : state.reply,
 });

 // --- routing ---
 const routeAfterValidate = (state: TurnStateType): string => {
 if (state.decision === null) {
 return "failed";
 }
 switch (state.decision.branch) {
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
 .addNode("route", route)
 .addNode("onboarding", onboarding)
 .addNode("open", open)
 .addNode("assemble", assemble)
 .addNode("classify", classify)
 .addNode("validate", validate)
 .addNode("attempt_judged", attemptJudged)
 .addNode("attempt_corrected", correctionBranch)
 .addNode("attempt_accepted", acceptedBranch)
 .addNode("question", questionBranch)
 .addNode("kp_question", kpQuestionBranch)
 .addNode("drift", driftBranch)
 .addNode("answer", answer)
 .addNode("answered", answered)
 .addNode("continue_turn", continueTurn)
 .addNode("reask", reask)
 .addNode("compose", compose)
 .addNode("failed", failedBranch)
 .addNode("persist", persist)
 .addNode("deliver", deliver)
 .addEdge(START, "route")
 .addConditionalEdges("route", routeSettings, {
 onboarding: "onboarding",
 assemble: "assemble",
 })
 .addConditionalEdges("onboarding", routeAfterOnboarding, {
 open: "open",
 deliver: "deliver",
 })
 .addEdge("open", "deliver")
 .addConditionalEdges("assemble", (state: TurnStateType) =>
 state.klass === null ? "no_class" : "classify", {
 no_class: "deliver",
 classify: "classify",
 })
 .addEdge("classify", "validate")
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
 .addEdge("attempt_corrected", "answer")
 .addEdge("attempt_accepted", "answered")
 .addEdge("question", "answer")
 .addEdge("kp_question", "answer")
 .addEdge("drift", "answer")
 .addEdge("answer", "answered")
 .addConditionalEdges("answered", routeAnswered, {
 continue_turn: "continue_turn",
 reask: "reask",
 })
 .addEdge("continue_turn", "compose")
 .addEdge("reask", "compose")
 .addEdge("compose", "persist")
 .addEdge("failed", "deliver")
 .addEdge("persist", "deliver")
 .addEdge("deliver", END)
 .compile();
}

/** The prompt version is part of every turn's provenance (design/20-architecture.md §4). */
export const TURN_GRAPH_PROMPT_VERSION = TURN_PROMPT_VERSION;

export type { HandleTurnInput, TurnOutcome };
