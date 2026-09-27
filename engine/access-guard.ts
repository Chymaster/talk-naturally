/**
 * Engine access guard — design/74-access.md §5.
 *
 * The adapter gate answers an unapproved learner before the engine (design/74-access.md §3),
 * but the scheduler and any future host call the engine directly. This decorator
 * is the mechanical guarantee behind the rule: **no workflow runs, and no model
 * call is made, for a learner whose access is not approved.** It checks the
 * storage port and returns a deterministic outcome without delegating.
 *
 * It wraps the engine in the server composition root; the dev CLI host stays
 * unguarded because it is an operator tool, not a channel (design/70-stack.md §2).
 */
import type { IdPort } from "../core/ports/config.js";
import type { StoragePort } from "../core/ports/storage.js";
import {
 commandOutcome,
 type ConversationEngine,
 type FitDocumentInput,
 type HandleTurnInput,
 type SettingsCommandInput,
 type StartConversationInput,
 type StartSessionInput,
 type TurnOutcome,
} from "./types.js";

/** The deterministic, model-free outcome an unapproved learner gets from the engine. */
export const ACCESS_BLOCKED_REPLY =
 "Your access is not active, so I cannot start a lesson yet. Please contact the operator if you think that is a mistake.";

export function guardEngine(
 engine: ConversationEngine,
 storage: StoragePort,
 ids: IdPort,
): ConversationEngine {
 async function isApproved(learnerId: string): Promise<boolean> {
 return storage.isLearnerApproved(learnerId);
 }

 function blockedOutcome(): TurnOutcome {
 return commandOutcome(ACCESS_BLOCKED_REPLY, "not_approved", "blocked", ids.newId(), "");
 }

 return {
 async handleTurn(input: HandleTurnInput): Promise<TurnOutcome> {
 if (!(await isApproved(input.learnerId))) {
 return blockedOutcome();
 }
 return engine.handleTurn(input);
 },

 async startSession(input: StartSessionInput): Promise<TurnOutcome> {
 if (!(await isApproved(input.learnerId))) {
 return blockedOutcome();
 }
 return engine.startSession(input);
 },

 async startConversation(input: StartConversationInput): Promise<TurnOutcome> {
 if (!(await isApproved(input.learnerId))) {
 return blockedOutcome();
 }
 return engine.startConversation(input);
 },

 async handleSettingsCommand(input: SettingsCommandInput): Promise<TurnOutcome> {
 if (!(await isApproved(input.learnerId))) {
 return blockedOutcome();
 }
 return engine.handleSettingsCommand(input);
 },

 async fitDocument(input: FitDocumentInput): Promise<TurnOutcome> {
 if (!(await isApproved(input.learnerId))) {
 return blockedOutcome();
 }
 return engine.fitDocument(input);
 },

 async getSettings(learnerId: string) {
 if (!(await isApproved(learnerId))) {
 return null;
 }
 return engine.getSettings(learnerId);
 },
 };
}
