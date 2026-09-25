/**
 * Engine-layer types. The engine is allowed to know LangGraph; `core/` is not
 * (AGENT.md §2.1, §3).
 */
import type { TurnBranch } from "../core/domain/turn.js";
import type { ModelPort, ModelResolverPort, TokenUsage } from "../core/ports/model.js";
import type { ClockPort, IdPort } from "../core/ports/config.js";
import type { ChannelKind, StoragePort } from "../core/ports/storage.js";

/** Structured event for logs; never contains full conversations at info level (§12.7). */
export type EngineLogger = (event: Record<string, unknown>) => void;

export interface EngineDeps {
  readonly storage: StoragePort;
  /** Which model a learner's turn runs against (MVP.md §3). */
  readonly models: ModelResolverPort;
  readonly clock: ClockPort;
  readonly ids: IdPort;
  readonly logger?: EngineLogger;
}

export interface HandleTurnInput {
  readonly learnerId: string;
  readonly classId: string;
  readonly channel: ChannelKind;
  readonly text: string;
}

export interface StartSessionInput {
  readonly learnerId: string;
  readonly classId: string;
  readonly channel: ChannelKind;
}

export interface TurnOutcome {
  readonly reply: string;
  readonly branch: TurnBranch | "opening" | "failed";
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
 * their progress survive (§8).
 */
export const TURN_FAILED_REPLY =
  "Sorry — I could not reach the language model just now. Your message is saved. Try again in a moment.";

export const NO_CLASS_REPLY =
  "I could not find that class on this server yet. Send me the material you are studying and I will set it up.";

export interface ConversationEngine {
  handleTurn(input: HandleTurnInput): Promise<TurnOutcome>;
  startSession(input: StartSessionInput): Promise<TurnOutcome>;
}

export type { ModelPort, ModelResolverPort, StoragePort, ClockPort, IdPort, TokenUsage };
