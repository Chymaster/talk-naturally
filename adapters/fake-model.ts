/**
 * Fake model adapter — AGENT.md §8/§11.
 *
 * The default test path: no network, no live model, fully deterministic. Two
 * flavours are provided: a scripted adapter for precise test assertions, and an
 * "auto tutor" adapter that makes the CLI demo loop turn without a provider.
 */
import type {
  ModelCapabilities,
  ModelCompletion,
  ModelPort,
  StructuredRequest,
} from "../core/ports/model.js";
import { ModelUnavailableError } from "../core/ports/model.js";

export const FAKE_CAPABILITIES: ModelCapabilities = {
  structuredOutput: true,
  toolCalls: false,
  streaming: false,
  maxContextTokens: 16000,
};

export type FakeResponder = (request: StructuredRequest) => unknown;

export class FakeModelAdapter implements ModelPort {
  readonly capabilities: ModelCapabilities;
  /** Every request the engine made, for assertions. */
  readonly requests: StructuredRequest[] = [];
  readonly #responder: FakeResponder;
  readonly #modelId: string;

  constructor(
    responder: FakeResponder,
    modelId = "fake-model",
    capabilities: ModelCapabilities = FAKE_CAPABILITIES,
  ) {
    this.#responder = responder;
    this.#modelId = modelId;
    this.capabilities = capabilities;
  }

  async complete(request: StructuredRequest): Promise<ModelCompletion> {
    this.requests.push(request);
    const parsed = this.#responder(request);
    return {
      text: JSON.stringify(parsed),
      parsed,
      model: this.#modelId,
      usage: { inputTokens: null, outputTokens: null },
    };
  }
}

/** Replays a fixed list of structured outputs, one per call. */
export function createScriptedModel(
  outputs: readonly unknown[],
  modelId = "fake-scripted",
): FakeModelAdapter {
  let index = 0;
  return new FakeModelAdapter(() => {
    const output = outputs[index];
    index += 1;
    if (output === undefined) {
      throw new ModelUnavailableError("fake script exhausted", false);
    }
    return output;
  }, modelId);
}

const TARGET_ID_PATTERN = /id:\s*(kp_[0-9a-f]{16})/gu;
const TARGET_TITLE_PATTERN = /title:\s*(.+)$/gmu;

function targetIdsFrom(request: StructuredRequest): string[] {
  return [...request.system.matchAll(TARGET_ID_PATTERN)].map((match) => match[1] ?? "");
}

function firstTitleFrom(request: StructuredRequest): string | null {
  for (const match of request.system.matchAll(TARGET_TITLE_PATTERN)) {
    const title = (match[1] ?? "").trim();
    if (title.length > 0) {
      return title;
    }
  }
  return null;
}

function latestUserMessage(request: StructuredRequest): string {
  for (let index = request.messages.length - 1; index >= 0; index -= 1) {
    const message = request.messages[index];
    if (message !== undefined && message.role === "user") {
      return message.content;
    }
  }
  return "";
}

/**
 * A tiny deterministic stand-in for a tutor, so the CLI demo runs with no
 * provider and no key. Deliberately simple: the real behavior comes from the
 * configured model.
 *
 * It exercises all four authored branches so the demo transcript shows the
 * routing, not just the happy path.
 */
export function createAutoTutorModel(): FakeModelAdapter {
  return new FakeModelAdapter((request) => {
    if (request.schemaName === "OpeningMessage") {
      return { reply: "Hallo! Schön, dass du da bist. Wie kommst du heute zur Arbeit?" };
    }

    const first = targetIdsFrom(request)[0];
    const title = firstTitleFrom(request) ?? "das";
    const text = latestUserMessage(request);
    const signal = (outcome: string) =>
      first === undefined
        ? []
        : [{ knowledge_point_id: first, outcome, evidence: text }];

    // Drift: off-topic, handled warmly and re-anchored, never clamped (§7.3).
    if (/fußball|wetter|urlaub|serie|kino/iu.test(text)) {
      return {
        branch: "drift",
        reply: "Fußball ist ein gutes Thema! Und wie kommst du normalerweise zum Stadion?",
        corrections: [],
        signals: [],
      };
    }

    // A learner attempt: judge it, correct only what matters (§7.4).
    if (/\bich\s+(gehe|fahre|steige|komme|nehme)\b/iu.test(text)) {
      if (/mit der (bus|bahn|fahrrad|zug)|mit dem (bahn|fahrrad)\b/iu.test(text)) {
        return {
          branch: "attempt_judged",
          reply: `Fast! Bei „${title}“ brauchst du den Dativ: „mit dem Bus“.`,
          corrections: [
            {
              span: "mit der Bus",
              fix: "mit dem Bus",
              reason: "„mit“ verlangt den Dativ, und „Bus“ ist maskulin.",
            },
          ],
          signals: signal("wrong"),
        };
      }
      return {
        branch: "attempt_judged",
        reply: "Sehr gut! Und wie ist es am Wochenende?",
        corrections: [],
        signals: signal("used"),
      };
    }

    // A language question, answered briefly then handed back.
    if (/\?|wie sagt man|was bedeutet|warum|womit|welche|dativ/iu.test(text)) {
      return {
        branch: "kp_question",
        reply: `„${title}“ — das ist wichtig für diese Lektion. Und wie würdest du das sagen?`,
        corrections: [],
        signals: signal("seen"),
      };
    }

    return {
      branch: "attempt_judged",
      reply: "Gut! Erzähl mir mehr davon.",
      corrections: [],
      signals: signal("used"),
    };
  }, "fake-auto-tutor");
}
