/**
 * The remote adapter owns the network: schema enforcement when the model
 * supports it, a defensive parse when it does not, and wrapped failures that
 * never leak a raw provider error (design/20-architecture.md §5, design/70-stack.md §5).
 *
 * The adapter speaks the OpenAI Responses API, so every fixture here is a
 * Responses payload (`output` items), not a chat-completions payload.
 */
import { describe, expect, it, vi } from "vitest";
import { OpenAICompatibleModel, parseLooseJson, REASONING_HEADROOM_TOKENS } from "../adapters/openai-model.js";
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
 id: "resp_test",
 object: "response",
 status: "completed",
 model: "test-model",
 // A reasoning item precedes the answer; the adapter must skip it.
 output: [
 { type: "reasoning", content: [{ type: "reasoning_text", text: "thinking" }] },
 { type: "message", role: "assistant", content: [{ type: "output_text", text: content }] },
 ],
 usage: { input_tokens: 5, output_tokens: 7, total_tokens: 12 },
 }),
 { status: 200, headers: { "content-type": "application/json" } },
 );
}

/** A reasoning model that spent its whole budget thinking: no message item. */
function incomplete(): Response {
 return new Response(
 JSON.stringify({
 id: "resp_test",
 object: "response",
 status: "incomplete",
 incomplete_details: { reason: "max_output_tokens" },
 model: "test-model",
 output: [{ type: "reasoning", content: [] }],
 usage: { input_tokens: 5, output_tokens: 120 },
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
 // Declared explicitly so this test states its own precondition instead of
 // inheriting whatever the shipped default happens to be (hosts/config.ts).
 settings: settings({
 capabilities: { ...DEFAULT_MODEL_CAPABILITIES, structuredOutput: true },
 }),
 fetchImpl: fetchImpl as unknown as typeof fetch,
 });

 const completion = await model.complete(REQUEST);
 expect(completion.parsed).toMatchObject({ branch: "drift" });
 expect(completion.usage).toEqual({ inputTokens: 5, outputTokens: 7 });
 expect(completion.model).toBe("test-model");

 const call = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
 expect(call[0]).toBe("https://example.test/v1/responses");
 const body = JSON.parse(String(call[1].body)) as Record<string, unknown>;
 expect(body["response_format"]).toBeUndefined();
 const format = (body["text"] as { format: { type: string; name: string; strict: boolean } })
 .format;
 expect(format.type).toBe("json_schema");
 expect(format.name).toBe("TurnResult");
 expect(format.strict).toBe(true);
 expect(body["instructions"]).toBe("You are a tutor.");
 expect(body["input"]).toEqual([{ role: "user", content: "Hallo" }]);
 expect(body["max_output_tokens"]).toBe(100 + REASONING_HEADROOM_TOKENS);
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
 instructions: string;
 input: { role: string; content: string }[];
 text?: unknown;
 };
 expect(body.text).toBeUndefined();
 expect(body.instructions).toContain("Required output");
 expect(body.instructions).toContain("TurnResult");
 expect(body.input[0]).toEqual({ role: "user", content: "Hallo" });
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

 it("reports an incomplete reasoning response instead of an empty answer", async () => {
 const model = new OpenAICompatibleModel({
 settings: settings(),
 fetchImpl: (async () => incomplete()) as unknown as typeof fetch,
 });

 // Reasoning consumed the entire output budget: this must be a named failure,
 // never a silent empty completion (design/20-architecture.md §5).
 await expect(model.complete(REQUEST)).rejects.toMatchObject({
 retryable: true,
 message: expect.stringContaining("incomplete") as unknown as string,
 });
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
