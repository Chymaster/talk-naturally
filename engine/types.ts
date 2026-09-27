/**
 * Engine-layer types. The engine is allowed to know LangGraph; `core/` is not
 * (design/10-overview.md MVP.md §3.1, design/20-architecture.md §2).
 */
import type { TurnBranch } from "../core/domain/turn.js";
import type { LearnerSettings } from "../core/domain/settings.js";
import type { ModelPort, ModelResolverPort, TokenUsage } from "../core/ports/model.js";
import type { ClockPort, IdPort } from "../core/ports/config.js";
import type { LevelCatalogPort } from "../core/ports/catalog.js";
import type { DocumentPort } from "../core/ports/documents.js";
import type { ChannelKind, StoragePort } from "../core/ports/storage.js";

/** Structured event for logs; never contains full conversations at info level (AGENT.md §4.7). */
export type EngineLogger = (event: Record<string, unknown>) => void;

export interface EngineDeps {
 readonly storage: StoragePort;
 /** Which model a learner's turn runs against (MVP.md design/20-architecture.md §2). */
 readonly models: ModelResolverPort;
 readonly clock: ClockPort;
 readonly ids: IdPort;
 /** Built-in level catalog; required for onboarding (design/60-ingestion.md §3). */
 readonly catalog?: LevelCatalogPort;
 /** Document extraction for uploaded material (design/60-ingestion.md §5). */
 readonly documents?: DocumentPort;
 readonly logger?: EngineLogger;
}

export interface HandleTurnInput {
 readonly learnerId: string;
 /** Defaults to the class in the learner's settings (design/30-domain-model.md §8). */
 readonly classId?: string;
 readonly channel: ChannelKind;
 readonly text: string;
}

export interface StartSessionInput {
 readonly learnerId: string;
 readonly classId?: string;
 readonly channel: ChannelKind;
 /** What to record as the turn's incoming text. Defaults to a scheduled start. */
 readonly incoming?: string;
 /**
 * Why the session is opening. `new_conversation` is the learner's `/new`
 * command: the opening asks a new question and must not repeat the question on
 * the table (design/50-orchestration.md §2, D-032).
 */
 readonly reason?: "scheduled" | "new_conversation";
}

/** The learner asked to start over with `/new` (alias `/start`). */
export interface StartConversationInput {
 readonly learnerId: string;
 readonly classId?: string;
 readonly channel: ChannelKind;
 /** The exact command text, recorded as the turn's incoming message. */
 readonly incoming?: string;
}

export type OutcomeBranch =
 | TurnBranch
 | "opening"
 | "failed"
 | "onboarding"
 | "settings"
 /** No workflow ran: the learner's access is not approved (design/74-access.md §5). */
 | "blocked";

export interface TurnOutcome {
 readonly reply: string;
 readonly branch: OutcomeBranch;
 /** Finer label for the chosen branch, e.g. "corrected" | "accepted". */
 readonly handledAs: string;
 readonly targetIds: readonly string[];
 readonly steeringReason: string;
 readonly unattributedSignals: number;
 readonly appliedDeltas: number;
 readonly promptVersion: string;
 readonly modelId: string;
 readonly usage: TokenUsage;
 readonly turnId: string;
}

/**
 * What the learner sees when the provider fails. The learner's own message and
 * their progress survive (design/20-architecture.md §5).
 */
export const TURN_FAILED_REPLY =
 "Sorry — I could not reach the language model just now. Your message is saved. Try again in a moment.";

export const NO_CLASS_REPLY =
 "I could not find that class on this server yet. Send me the material you are studying and I will set it up.";

/** Settings commands in chat (design/30-domain-model.md §8). */
export interface SettingsCommandInput {
 readonly learnerId: string;
 readonly text: string;
 readonly channel: ChannelKind;
}

/** Uploaded material fitted into a personal class (design/60-ingestion.md §5). */
export interface FitDocumentInput {
 readonly learnerId: string;
 readonly filename: string;
 readonly mediaType: string;
 readonly bytes: Uint8Array;
 /** Class title; defaults to the filename. */
 readonly title?: string;
 readonly language?: string;
 readonly sourceLanguage?: string;
}

export interface ConversationEngine {
 handleTurn(input: HandleTurnInput): Promise<TurnOutcome>;
 startSession(input: StartSessionInput): Promise<TurnOutcome>;
 /** The learner's `/new` (alias `/start`): end the question on the table, ask a new one (design/50-orchestration.md §2). */
 startConversation(input: StartConversationInput): Promise<TurnOutcome>;
 /** `/settings`, `/level`, `/language`, `/chapter`, `/include`, `/exclude`. */
 handleSettingsCommand(input: SettingsCommandInput): Promise<TurnOutcome>;
 /** Condense an uploaded document into a personal class (design/60-ingestion.md §5). */
 fitDocument(input: FitDocumentInput): Promise<TurnOutcome>;
 /** Current settings, for display and for the scheduler's onboarding gate. */
 getSettings(learnerId: string): Promise<LearnerSettings | null>;
}

/** A `TurnOutcome` for a path that made no model call (onboarding, settings). */
export function commandOutcome(
 reply: string,
 handledAs: string,
 branch: OutcomeBranch,
 turnId: string,
 promptVersion: string,
): TurnOutcome {
 return {
 reply,
 branch,
 handledAs,
 targetIds: [],
 steeringReason: "",
 unattributedSignals: 0,
 appliedDeltas: 0,
 promptVersion,
 modelId: "",
 usage: { inputTokens: null, outputTokens: null },
 turnId,
 };
}

export type { ModelPort, ModelResolverPort, StoragePort, ClockPort, IdPort, TokenUsage };
