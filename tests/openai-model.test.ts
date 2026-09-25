/**
 * The remote adapter owns the network: schema enforcement when the model
 * supports it, a defensive parse when it does not, and wrapped failures that
 * never leak a raw provider error (AGENT.md §8, §11).
 */
import { describe, expect, it, vi } from "vitest";
import { OpenAICompatibleModel, parseLooseJson } from "../adapters/openai-model.js";
import type { ModelSettings } from "../core/ports/config.js";
import { CONSERVATIVE_CAPABILITIES, ModelUnavailableError } from "../core/ports/model.js";
import type { StructuredRequest } from "../core/ports/model.js";
import { DEFAULT_MODEL_CAPABILITIES } from "../hosts/config.js";

const REQUEST: StructuredRequest = {
  system: "You are a tutor.",
  messages: [{ role: "user", content: "Hallo" }],
  schemaName: "TurnResult",
  schema: { type: "object", properties: { reply: { type: "string" } } },
  maxOutputTokens: 100,
};

const VALID = '{"branch":"drift","reply":"hi","corrections":[],"signals":[]}';

function settings(overrides: Partial<ModelSettings> = {}): ModelSettings {
  return {
    baseUrl: "https://example.test/v1",
    modelId: "test-model",
    apiKey: "sk-test",
    source: "deployer",
    capabilities: DEFAULT_MODEL_CAPABILITIES,
    ...overrides,
  };
}

function ok(content: string): Response {
  return new Response(
    JSON.stringify({
      model: "test-model",
      choices: [{ message: { content } }],
      usage: { prompt_tokens: 5, completion_tokens: 7 },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

describe("parseLooseJson", () => {
  it("accepts bare JSON", () => {
    expect(parseLooseJson(VALID)).toMatchObject({ branch: "drift" });
  });

  it("accepts JSON wrapped in markdown fences", () => {
    expect(parseLooseJson(`\`\`\`json\n${VALID}\n\`\`\``)).toMatchObject({ branch: "drift" });
  });

  it("recovers JSON from surrounding prose", () => {
    expect(parseLooseJson(`Sure! Here you go: ${VALID} Hope that helps.`)).toMatchObject({
      branch: "drift",
    });
  });

  it("returns null for unrecoverable text", () => {
    expect(parseLooseJson("I cannot help with that.")).toBeNull();
  });
});

describe("OpenAICompatibleModel", () => {
  it("enforces the schema when the model declares structured output", async () => {
    const fetchImpl = vi.fn(async () => ok(VALID));
    const model = new OpenAICompatibleModel({
      settings: settings(),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const completion = await model.complete(REQUEST);
    expect(completion.parsed).toMatchObject({ branch: "drift" });
    expect(completion.usage).toEqual({ inputTokens: 5, outputTokens: 7 });

    const call = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(call[0]).toBe("https://example.test/v1/chat/completions");
    const body = JSON.parse(String(call[1].body)) as Record<string, unknown>;
    const responseFormat = body["response_format"] as {
      type: string;
      json_schema: { name: string };
    };
    expect(responseFormat.type).toBe("json_schema");
    expect(responseFormat.json_schema.name).toBe("TurnResult");
    expect((call[1].headers as Record<string, string>)["authorization"]).toBe("Bearer sk-test");
  });

  it("prompts for JSON and parses defensively when schema enforcement is absent", async () => {
    const fetchImpl = vi.fn(async () => ok(`\`\`\`json\n${VALID}\n\`\`\``));
    const model = new OpenAICompatibleModel({
      settings: settings({ capabilities: CONSERVATIVE_CAPABILITIES }),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const completion = await model.complete(REQUEST);
    expect(completion.parsed).toMatchObject({ branch: "drift" });

    const call = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(String(call[1].body)) as {
      messages: { content: string }[];
      response_format?: unknown;
    };
    expect(body.response_format).toBeUndefined();
    expect(body.messages[0]?.content).toContain("Required output");
    expect(body.messages[0]?.content).toContain("TurnResult");
  });

  it("retries once when the first reply is not JSON", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(ok("I am afraid I cannot do that."))
      .mockResolvedValueOnce(ok(VALID));
    const model = new OpenAICompatibleModel({
      settings: settings({ capabilities: CONSERVATIVE_CAPABILITIES }),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const completion = await model.complete(REQUEST);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(completion.parsed).toMatchObject({ branch: "drift" });
  });

  it("marks server and rate-limit failures retryable, and client errors not", async () => {
    const serverError = new OpenAICompatibleModel({
      settings: settings(),
      fetchImpl: (async () => new Response("boom", { status: 503 })) as unknown as typeof fetch,
    });
    await expect(serverError.complete(REQUEST)).rejects.toMatchObject({ retryable: true });

    const clientError = new OpenAICompatibleModel({
      settings: settings(),
      fetchImpl: (async () => new Response("bad request", { status: 400 })) as unknown as typeof fetch,
    });
    await expect(clientError.complete(REQUEST)).rejects.toMatchObject({ retryable: false });
  });

  it("wraps a transport failure as a retryable model error", async () => {
    const model = new OpenAICompatibleModel({
      settings: settings(),
      fetchImpl: (async () => {
        throw new Error("ECONNRESET");
      }) as unknown as typeof fetch,
    });
    await expect(model.complete(REQUEST)).rejects.toBeInstanceOf(ModelUnavailableError);
    await expect(model.complete(REQUEST)).rejects.toMatchObject({ retryable: true });
  });

  it("fails fast without a key and never calls the network", async () => {
    const fetchImpl = vi.fn(async () => ok(VALID));
    const model = new OpenAICompatibleModel({
      settings: settings({ apiKey: null }),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await expect(model.complete(REQUEST)).rejects.toMatchObject({ retryable: false });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
