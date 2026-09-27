/**
 * Composition helper for the engine.
 *
 * The engine receives its ports here — it never constructs an adapter itself.
 * The host is the only place that decides which implementation to pass in
 * (design/20-architecture.md §2, composition root).
 */
import { TURN_PROMPT_VERSION } from "../core/prompts/turn.js";
import { OPENING_PROMPT_VERSION } from "../core/prompts/session.js";
import { FIT_PROMPT_VERSION } from "../core/prompts/fit.js";
import { startSession, startConversation, isNewConversationCommand } from "./session.js";
import { buildTurnGraph } from "./turn-graph.js";
import { handleSettingsCommand as runSettingsCommand } from "./settings.js";
import { createMaterialFitter, isAffirmative, isNegative } from "./ingest.js";
import {
 commandOutcome,
 type ConversationEngine,
 type EngineDeps,
 type FitDocumentInput,
 type HandleTurnInput,
 type SettingsCommandInput,
 type StartConversationInput,
 type StartSessionInput,
 type TurnOutcome,
} from "./types.js";

export function createEngine(deps: EngineDeps): ConversationEngine {
 const graph = buildTurnGraph(deps);
 // The upload preview and its rate limit belong to this engine instance
 // (design/60-ingestion.md §5).
 const fitter = createMaterialFitter();

 return {
 async handleTurn(input: HandleTurnInput): Promise<TurnOutcome> {
 // A pending upload is confirmed or discarded in conversation before any turn
 // runs (design/60-ingestion.md §5).
 const hasPending = fitter.hasPendingConfirmation(
 input.learnerId,
 deps.clock.now().getTime(),
 );
 if (hasPending && isAffirmative(input.text)) {
 const confirmed = await fitter.confirmPendingMaterial(deps, input.learnerId);
 if (confirmed !== null) {
 return confirmed;
 }
 }
 if (hasPending && isNegative(input.text)) {
 fitter.discardPending(input.learnerId);
 return commandOutcome(
 "Okay — I discarded that upload. Nothing was saved.",
 "fit_discarded",
 "settings",
 deps.ids.newId(),
 FIT_PROMPT_VERSION,
 );
 }

 const final = await graph.invoke({
 learnerId: input.learnerId,
 classId: input.classId ?? "",
 incoming: input.text,
 turnId: deps.ids.newId(),
 startedAt: deps.clock.now().toISOString(),
 });

 const branch = final.branch.length > 0 ? final.branch : final.decision?.branch ?? "failed";

 return {
 reply: final.reply,
 branch: branch as TurnOutcome["branch"],
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

 async startConversation(input: StartConversationInput): Promise<TurnOutcome> {
 return startConversation(deps, input);
 },

 async handleSettingsCommand(input: SettingsCommandInput): Promise<TurnOutcome> {
 // `/new` and `/start` are the learner's new-conversation entry point, not a
 // settings change: they run before the settings dispatcher so every channel's
 // one text-command path reaches them (design/50-orchestration.md §2).
 if (isNewConversationCommand(input.text)) {
 return startConversation(deps, {
 learnerId: input.learnerId,
 channel: input.channel,
 incoming: input.text.trim(),
 });
 }
 const turnId = deps.ids.newId();
 if (deps.catalog === undefined) {
 return commandOutcome(
 "This server has no built-in material configured yet. Ask the operator to add it.",
 "settings_unavailable",
 "settings",
 turnId,
 TURN_PROMPT_VERSION,
 );
 }
 const outcome = await runSettingsCommand(
 {
 storage: deps.storage,
 clock: deps.clock,
 catalog: deps.catalog,
 ...(deps.logger === undefined ? {} : { logger: deps.logger }),
 },
 input.learnerId,
 input.text,
 );
 return commandOutcome(
 outcome.reply,
 outcome.handledAs,
 "settings",
 turnId,
 TURN_PROMPT_VERSION,
 );
 },

 async fitDocument(input: FitDocumentInput): Promise<TurnOutcome> {
 return fitter.fitUploadedDocument(deps, input);
 },

 async getSettings(learnerId: string) {
 return deps.storage.getLearnerSettings(learnerId);
 },
 };
}

export { startSession } from "./session.js";
export { startConversation, isNewConversationCommand, NEW_CONVERSATION_COMMANDS } from "./session.js";
export { buildTurnGraph, TURN_GRAPH_PROMPT_VERSION } from "./turn-graph.js";
export { OPENING_PROMPT_VERSION };
export * from "./types.js";
