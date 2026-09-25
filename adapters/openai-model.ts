/**
 * Remote model adapter over any OpenAI-compatible endpoint — AGENT.md §8.
 *
 * Owns every network concern: URL, auth, timeout, retries, and the fallback
 * path for models without schema enforcement. The core only ever sees
 * `ModelPort`.
 *
 * Configuration (base URL, model id, key, capabilities) arrives from the host's
 * composition root. A learner-supplied key, when present, has already been
 * resolved there. This adapter never reads the environment (MVP.md §3).
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

function extractText(payload: unknown): string {
  const choices = (payload as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) {
    return "";
  }
  const message = (choices[0] as { message?: { content?: unknown } }).message;
  const content = message?.content;
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((part) =>
        typeof part === "string" ? part : ((part as { text?: string }).text ?? ""),
      )
      .join("");
  }
  return "";
}

function extractUsage(payload: unknown): { inputTokens: number | null; outputTokens: number | null } {
  const usage = (payload as { usage?: { prompt_tokens?: unknown; completion_tokens?: unknown } }).usage;
  return {
    inputTokens: typeof usage?.prompt_tokens === "number" ? usage.prompt_tokens : null,
    outputTokens: typeof usage?.completion_tokens === "number" ? usage.completion_tokens : null,
  };
}

/**
 * Defensive parse for the fallback path: models without schema enforcement
 * sometimes wrap JSON in prose or fences (§8). Returns null rather than throwing
 * — the core validates and decides (§8 "validation happens in the core").
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
      // Declared, never discovered by failing (§8): no key means unavailable.
      throw new ModelUnavailableError(
        "no model API key is configured for this learner or deployer",
        false,
      );
    }

    const first = await this.#request(request, request.messages);
    if (first.parsed !== null) {
      return first;
    }

    // Bounded repair: exactly one extra call, then let the core reject (§8).
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
    const system =
      request.system + (structured ? "" : schemaAppendix(request));

    const body: Record<string, unknown> = {
      model: this.#settings.modelId,
      messages: [{ role: "system", content: system }, ...messages],
      max_tokens: request.maxOutputTokens,
      temperature: 0.7,
    };
    if (structured) {
      body["response_format"] = {
        type: "json_schema",
        json_schema: {
          name: request.schemaName,
          schema: request.schema,
          strict: true,
        },
      };
    }

    const url = `${this.#settings.baseUrl.replace(/\/+$/u, "")}/chat/completions`;
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
      // Network failure, timeout, DNS: retryable, and never a raw error upstream (§13).
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
    const content = extractText(payload);
    const model =
      (payload as { model?: unknown }).model === undefined
        ? this.#settings.modelId
        : String((payload as { model?: unknown }).model);

    return {
      text: content,
      parsed: parseLooseJson(content),
      model,
      usage: extractUsage(payload),
    };
  }
}
