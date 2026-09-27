/**
 * Local OpenAI-compatible provider stub — a development tool.
 *
 * Lets the whole stack be deployed and exercised locally with no API key and no
 * third party: point `TALK_MODEL_BASE_URL` at it and the *real* remote adapter
 * runs over real HTTP, including schema enforcement, the JSON fallback path, and
 * parsing.
 *
 *   pnpm stub:model                                   # listens on :8787
 *   TALK_MODEL_BASE_URL=http://127.0.0.1:8787/v1 \
 *   TALK_MODEL_API_KEY=stub pnpm demo:cli --live
 *
 * It answers with a schema-valid response, attributing `used` to the first
 * target id it can find in the prompt, so progress actually moves.
 *
 * This is NOT part of the product: it is a fake provider, and it is not used by
 * any test (the test suite uses `adapters/fake-model.ts` in-process instead).
 */
import { createServer } from "node:http";

const port = Number(process.env["STUB_PORT"] ?? 8787);

interface ChatBody {
  readonly model?: string;
  readonly messages?: readonly { readonly role?: string; readonly content?: string }[];
  readonly response_format?: { readonly json_schema?: { readonly name?: string } };
}

function detectSchemaName(body: ChatBody): string {
  const fromResponseFormat = body.response_format?.json_schema?.name;
  if (typeof fromResponseFormat === "string" && fromResponseFormat.length > 0) {
    return fromResponseFormat;
  }
  // The fallback path has no response_format; the adapter puts the name in the
  // system prompt instead.
  const system = body.messages?.[0]?.content ?? "";
  return /name:\s*([A-Za-z]+)/u.exec(system)?.[1] ?? "TurnDecision";
}

function firstTargetId(body: ChatBody): string | null {
  const system = body.messages?.[0]?.content ?? "";
  return /id:\s*(kp_[0-9a-f]{16})/u.exec(system)?.[1] ?? null;
}

function completionFor(schemaName: string, targetId: string | null): string {
  if (schemaName === "OpeningMessage") {
    return JSON.stringify({ reply: "Hallo! Womit fährst du heute zur Arbeit?" });
  }
  if (schemaName === "AnswerQuestion") {
    return JSON.stringify({ reply: "In English you would say: by bus." });
  }
  if (schemaName === "ContinueConversation") {
    return JSON.stringify({ feedback: "Sehr gut!", question: "Und wie ist es am Wochenende?" });
  }
  // TurnDecision (and any unknown schema): classify as an attempt and attribute
  // `used` to the first target, so progress actually moves.
  return JSON.stringify({
    branch: "attempt_judged",
    corrections: [],
    signals:
      targetId === null
        ? []
        : [{ knowledge_point_id: targetId, outcome: "used", evidence: "(stub provider)" }],
    answered_previous_question: true,
  });
}

const server = createServer((request, response) => {
  if (request.method !== "POST" || !(request.url ?? "").endsWith("/chat/completions")) {
    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "not found" }));
    return;
  }

  let raw = "";
  request.on("data", (chunk) => {
    raw += String(chunk);
  });
  request.on("end", () => {
    let body: ChatBody;
    try {
      body = JSON.parse(raw) as ChatBody;
    } catch {
      response.writeHead(400, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "invalid json" }));
      return;
    }

    const schemaName = detectSchemaName(body);
    console.log(
      JSON.stringify({
        event: "stub.request",
        model: body.model,
        schemaName,
        enforcedSchema: body.response_format !== undefined,
        messages: body.messages?.length ?? 0,
        hasAuthorization: request.headers.authorization !== undefined,
      }),
    );

    const payload = {
      id: "stub-completion",
      model: body.model ?? "stub-model",
      choices: [{ index: 0, message: { role: "assistant", content: completionFor(schemaName, firstTargetId(body)) } }],
      usage: { prompt_tokens: 42, completion_tokens: 17 },
    };
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(payload));
  });
});

server.listen(port, "127.0.0.1", () => {
  console.log(JSON.stringify({ event: "stub.listening", url: `http://127.0.0.1:${port}/v1` }));
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
  });
}
