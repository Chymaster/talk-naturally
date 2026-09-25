/**
 * Model port — AGENT.md §8.
 *
 * The core defines the port; a remote adapter implements it and owns every
 * network concern. The core never sees HTTP, a URL, or a provider type.
 */

export interface ModelCapabilities {
  readonly structuredOutput: boolean;
  readonly toolCalls: boolean;
  readonly streaming: boolean;
  readonly maxContextTokens: number;
}

export type ChatRole = "system" | "user" | "assistant";

export interface ChatMessage {
  readonly role: ChatRole;
  readonly content: string;
}

/**
 * A structured completion request. `schema` is JSON Schema; an adapter that
 * cannot enforce it must prompt for JSON and parse defensively with bounded
 * repair (§8), and the core still validates the result.
 */
export interface StructuredRequest {
  readonly system: string;
  readonly messages: readonly ChatMessage[];
  readonly schemaName: string;
  readonly schema: Record<string, unknown>;
  readonly maxOutputTokens: number;
}

export interface TokenUsage {
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
}

export interface ModelCompletion {
  /** Raw text, kept for logs and for the fallback parse path. */
  readonly text: string;
  /** Parsed structured value when the adapter could parse one, else null. */
  readonly parsed: unknown;
  readonly model: string;
  readonly usage: TokenUsage;
}

/** Provider failure, already wrapped — raw provider errors never reach the core (§13). */
export class ModelUnavailableError extends Error {
  readonly retryable: boolean;

  constructor(message: string, retryable: boolean, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ModelUnavailableError";
    this.retryable = retryable;
  }
}

export interface ModelPort {
  readonly capabilities: ModelCapabilities;
  complete(request: StructuredRequest): Promise<ModelCompletion>;
}

/**
 * Resolves which model a learner's turn runs against (MVP.md §3).
 *
 * The core never learns *why* a learner gets a particular model — a deployer
 * default, a learner-supplied token, or a test fake. Resolution belongs to the
 * host/identity layer; the engine just asks for a port.
 */
export interface ModelResolverPort {
  forLearner(learnerId: string): Promise<ModelPort>;
}

/** Conservative defaults for an endpoint that has not declared its capabilities. */
export const CONSERVATIVE_CAPABILITIES: ModelCapabilities = {
  structuredOutput: false,
  toolCalls: false,
  streaming: false,
  maxContextTokens: 8192,
};
