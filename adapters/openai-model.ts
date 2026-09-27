/**
 * Remote model adapter — design/20-architecture.md §5.
 *
 * Speaks the OpenAI **Responses API** (`POST {baseUrl}/responses`) rather than
 * the older chat-completions surface. That choice is deliberate and
 * load-bearing: chat completions *rejects* `json_schema`
 * (`"This response_format type is unavailable now"`), while `text.format` on
 * `/responses` enforces it. Structured output is therefore only reachable
 * through this API.
 *
 * Owns every network concern: URL, auth, timeout, retries, and the fallback
 * path for models without schema enforcement. The core only ever sees
 * `ModelPort`.
 *
 * Configuration (base URL, model id, key, capabilities) arrives from the host's
 * composition root. A learner-supplied key, when present, has already been
 * resolved there. This adapter never reads the environment (MVP.md design/20-architecture.md §2).
 */
import type { ModelCapabilities, ModelCompletion, ModelPort, StructuredRequest } from "../core/ports/model.js";
import { ModelUnavailableError } from "../core/ports/model.js";
import type { ModelSettings } from "../core/ports/config.js";

export interface OpenAICompatibleOptions {
 readonly settings: ModelSettings;
 readonly timeoutMs?: number;
 /** Injectable for tests; defaults to global fetch. */
 readonly fetchImpl?: typeof fetch;
 readonly logger?: (event: Record<string, unknown>) => void;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_REPAIR_CHARS = 2000;

/**
 * Reasoning models bill their *thinking* against `max_output_tokens`, so the
 * port's answer budget is not the whole story. Observed against the shipped
 * default: at the engine's 700-token cap the model spent the entire budget
 * reasoning and answered `status: "incomplete"` with no message item at all, so
 * every conversation turn failed. The cap is a ceiling rather than a charge, so
 * raising it costs nothing unless those tokens are actually generated. This is
 * provider semantics, which is exactly why it lives in the adapter (design/20-architecture.md §5).
 *
 * Deliberately generous: it leaves the port's whole answer budget intact no
 * matter how long the model thinks, while the model still stops as soon as it is
 * done. The endpoint's own ceiling is far higher for the shipped default
 * (393K output tokens / 1M context), so this costs nothing but headroom.
 */
export const REASONING_HEADROOM_TOKENS = 8000;

function isRecord(value: unknown): value is Record<string, unknown> {
 return typeof value === "object" && value !== null;
}

/**
 * Pull the assistant text out of a Responses payload. A response is an `output`
 * array of typed items: `reasoning` items are discarded, and the answer lives
 * in a `message` item's `output_text` content parts.
 */
function extractText(payload: unknown): string {
 if (!isRecord(payload)) {
 return "";
 }
 const output = payload["output"];
 if (!Array.isArray(output)) {
 // Some gateways also expose the flattened convenience field; accept it.
 return typeof payload["output_text"] === "string" ? payload["output_text"] : "";
 }

 const parts: string[] = [];
 for (const item of output) {
 if (!isRecord(item) || item["type"] !== "message") {
 continue;
 }
 const content = item["content"];
 if (!Array.isArray(content)) {
 continue;
 }
 for (const part of content) {
 if (typeof part === "string") {
 parts.push(part);
 continue;
 }
 if (isRecord(part) && part["type"] === "output_text" && typeof part["text"] === "string") {
 parts.push(part["text"]);
 }
 }
 }
 return parts.join("");
}

function extractUsage(payload: unknown): { inputTokens: number | null; outputTokens: number | null } {
 const usage = isRecord(payload) ? payload["usage"] : undefined;
 const shape = isRecord(usage) ? usage : {};
 return {
 inputTokens: typeof shape["input_tokens"] === "number" ? shape["input_tokens"] : null,
 outputTokens: typeof shape["output_tokens"] === "number" ? shape["output_tokens"] : null,
 };
}

/**
 * A reasoning model bills its thinking against `max_output_tokens`. When the
 * budget runs out mid-thought the API answers `status: "incomplete"` with no
 * message item at all — an empty string here would look like a model that
 * simply failed to emit JSON, so name the real cause instead.
 */
function incompleteReason(payload: unknown): string | null {
 if (!isRecord(payload) || payload["status"] !== "incomplete") {
 return null;
 }
 const details = payload["incomplete_details"];
 const suffix = details === undefined || details === null ? "" : `: ${JSON.stringify(details).slice(0, 200)}`;
 return `model response was incomplete${suffix}`;
}

/**
 * Defensive parse for the fallback path: models without schema enforcement
 * sometimes wrap JSON in prose or fences (design/20-architecture.md §5). Returns null rather than throwing
 * — the core validates and decides (design/20-architecture.md §5 "validation happens in the core").
 */
export function parseLooseJson(text: string): unknown {
 const withoutFences = text
 .trim()
 .replace(/^```(?:json)?/iu, "")
 .replace(/```$/u, "")
 .trim();

 const candidates = [withoutFences];
 const start = withoutFences.indexOf("{");
 const end = withoutFences.lastIndexOf("}");
 if (start !== -1 && end > start) {
 candidates.push(withoutFences.slice(start, end + 1));
 }

 for (const candidate of candidates) {
 if (candidate.length === 0) {
 continue;
 }
 try {
 return JSON.parse(candidate) as unknown;
 } catch {
 // try the next candidate
 }
 }
 return null;
}

function schemaAppendix(request: StructuredRequest): string {
 return [
 "",
 "# Required output",
 `Return only a JSON object matching this JSON Schema (name: ${request.schemaName}).`,
 "No markdown fences, no commentary, no text before or after the JSON.",
 JSON.stringify(request.schema),
 ].join("\n");
}

export class OpenAICompatibleModel implements ModelPort {
 readonly capabilities: ModelCapabilities;
 readonly #settings: ModelSettings;
 readonly #timeoutMs: number;
 readonly #fetch: typeof fetch;
 readonly #logger: ((event: Record<string, unknown>) => void) | undefined;

 constructor(options: OpenAICompatibleOptions) {
 this.#settings = options.settings;
 this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
 this.#fetch = options.fetchImpl ?? globalThis.fetch;
 this.#logger = options.logger;
 this.capabilities = options.settings.capabilities;
 }

 async complete(request: StructuredRequest): Promise<ModelCompletion> {
 if (this.#settings.apiKey === null || this.#settings.apiKey === "") {
 // Declared, never discovered by failing (design/20-architecture.md §5): no key means unavailable.
 throw new ModelUnavailableError(
 "no model API key is configured for this learner or deployer",
 false,
 );
 }

 const first = await this.#request(request, request.messages);
 if (first.parsed !== null) {
 return first;
 }

 // Bounded repair: exactly one extra call, then let the core reject (design/20-architecture.md §5).
 this.#logger?.({ event: "model.repair_attempt", schemaName: request.schemaName });
 const repaired = await this.#request(request, [
 ...request.messages,
 { role: "assistant", content: first.text.slice(0, MAX_REPAIR_CHARS) },
 {
 role: "user",
 content: `That was not valid JSON. Reply with only a JSON object matching the schema named ${request.schemaName}. No prose, no markdown fences.`,
 },
 ]);

 if (repaired.parsed === null) {
 this.#logger?.({ event: "model.repair_failed", schemaName: request.schemaName });
 }
 return repaired;
 }

 async #request(
 request: StructuredRequest,
 messages: StructuredRequest["messages"],
 ): Promise<ModelCompletion> {
 const structured = this.capabilities.structuredOutput;
 const system = request.system + (structured ? "" : schemaAppendix(request));

 const body: Record<string, unknown> = {
 model: this.#settings.modelId,
 instructions: system,
 input: messages.map((message) => ({ role: message.role, content: message.content })),
 // The port states an answer budget; the provider bills reasoning against
 // the same ceiling, so add headroom for the thinking that precedes it.
 max_output_tokens: request.maxOutputTokens + REASONING_HEADROOM_TOKENS,
 temperature: 0.7,
 };
 if (structured) {
 body["text"] = {
 format: {
 type: "json_schema",
 name: request.schemaName,
 schema: request.schema,
 strict: true,
 },
 };
 }

 const url = `${this.#settings.baseUrl.replace(/\/+$/u, "")}/responses`;
 let response: Response;
 try {
 response = await this.#fetch(url, {
 method: "POST",
 headers: {
 "content-type": "application/json",
 authorization: `Bearer ${this.#settings.apiKey ?? ""}`,
 },
 body: JSON.stringify(body),
 signal: AbortSignal.timeout(this.#timeoutMs),
 });
 } catch (error) {
 // Network failure, timeout, DNS: retryable, and never a raw error upstream (AGENT.md §6).
 throw new ModelUnavailableError(
 `model request failed: ${error instanceof Error ? error.message : String(error)}`,
 true,
 { cause: error },
 );
 }

 if (!response.ok) {
 const detail = await response.text().catch(() => "");
 const retryable =
 response.status >= 500 || response.status === 429 || response.status === 408;
 throw new ModelUnavailableError(
 `model provider returned ${response.status}: ${detail.slice(0, 300)}`,
 retryable,
 );
 }

 const payload = (await response.json()) as unknown;

 const incomplete = incompleteReason(payload);
 if (incomplete !== null) {
 throw new ModelUnavailableError(incomplete, true);
 }

 const content = extractText(payload);
 const model =
 isRecord(payload) && payload["model"] !== undefined
 ? String(payload["model"])
 : this.#settings.modelId;

 return {
 text: content,
 parsed: parseLooseJson(content),
 model,
 usage: extractUsage(payload),
 };
 }
}
