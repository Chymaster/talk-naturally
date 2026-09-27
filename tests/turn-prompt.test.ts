/**
 * The turn prompts' language split (design/50-orchestration.md §3.5).
 *
 * A question is answered by its own source-language call, and the target-language
 * turn is written by another call, so the model never has to switch language
 * mid-message. Prompts are versioned behavior artifacts
 * (design/20-architecture.md §4), so the rule is asserted here rather than left
 * to a live model call. Offline: no network, no database.
 */
import { describe, expect, it } from "vitest";
import {
  buildAnswerSystemPrompt,
  buildClassifySystemPrompt,
  buildContinuationSystemPrompt,
} from "../core/prompts/turn.js";
import { makeClass } from "./fixtures.js";

const klass = makeClass();

function classify(
  overrides: Partial<Parameters<typeof buildClassifySystemPrompt>[0]> = {},
): string {
  return buildClassifySystemPrompt({
    klass,
    targets: [],
    progressByPoint: {},
    steeringSummary: "test steering",
    ...overrides,
  });
}

describe("classify prompt", () => {
  it("asks for a decision only, never for learner-facing prose", () => {
    const prompt = classify();
    expect(prompt).toContain("you do not write the learner's next message");
    expect(prompt).toContain("answered_previous_question");
    expect(prompt).not.toContain('"feedback"');
  });

  it("includes the question on the table when there is one", () => {
    const prompt = classify({ pendingQuestion: "Womit fährst du zur Arbeit?" });
    expect(prompt).toContain("# The question on the table");
    expect(prompt).toContain("Womit fährst du zur Arbeit?");
  });

  it("omits the question block when the app has not spoken yet", () => {
    expect(classify()).not.toContain("# The question on the table");
  });
});

describe("answer prompt", () => {
  it("answers a question only in the class's source language", () => {
    const prompt = buildAnswerSystemPrompt({
      klass,
      branch: "kp_question",
      incoming: "Warum Dativ?",
    });
    expect(prompt).toContain("Write only in English. Never write German.");
    expect(prompt).toContain("Warum Dativ?");
  });

  it("handles drift only in the class's target language", () => {
    const prompt = buildAnswerSystemPrompt({
      klass,
      branch: "drift",
      incoming: "Am Wochenende spiele ich Fußball.",
    });
    expect(prompt).toContain("Write only in German. Never write English.");
    expect(prompt).toContain("changed the subject");
  });

  it("explains a correction in the source language, not the target", () => {
    const prompt = buildAnswerSystemPrompt({
      klass,
      branch: "attempt_judged",
      incoming: "Ich fahre mit der Bus.",
      corrections: [{ span: "mit der Bus", fix: "mit dem Bus", reason: "Dativ" }],
    });
    expect(prompt).toContain("Write only in English. Never write German.");
    expect(prompt).toContain("got something wrong");
    expect(prompt).toContain('the learner wrote "mit der Bus"');
    expect(prompt).toContain('the fix is "mit dem Bus"');
  });
});

describe("continuation prompt", () => {
  it("writes the whole next turn only in the class's target language", () => {
    const prompt = buildContinuationSystemPrompt({
      klass,
      targets: [],
      progressByPoint: {},
      steeringSummary: "test steering",
      incoming: "Ich fahre mit dem Bus.",
      pendingQuestion: "Womit fährst du zur Arbeit?",
    });
    expect(prompt).toContain("Write only in German; never write English.");
    expect(prompt).toContain("Womit fährst du zur Arbeit?");
    expect(prompt).toContain('"feedback"');
    expect(prompt).toContain('"question"');
    // The correction already came from the answer call, in the source language.
    expect(prompt).toContain("Do not repeat it");
    expect(prompt).not.toContain("Corrections to weave in");
  });
});
