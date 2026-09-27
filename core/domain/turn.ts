/**
 * The turn's structured contracts — design/50-orchestration.md §4.
 *
 * A turn is split so the model never has to change language inside one message:
 * `TurnDecision` classifies the learner's message and carries the progress
 * signals; `AnswerResult` is the source-language answer to a question; and
 * `ContinuationResult` is the target-language continuation. Untrusted model
 * output is untrusted, so each schema is a gate (design/20-architecture.md §5).
 */
import { z } from "zod";

/** Authored branch set — the model selects among these, never invents one (design/50-orchestration.md §3). */
export const turnBranchSchema = z.enum([
 "attempt_judged",
 "question",
 "kp_question",
 "drift",
]);
export type TurnBranch = z.infer<typeof turnBranchSchema>;

export const knowledgeOutcomeSchema = z.enum([
 "used",
 "used_with_help",
 "wrong",
 "seen",
]);
export type KnowledgeOutcome = z.infer<typeof knowledgeOutcomeSchema>;

/** Small, inline, attached to the moment — never a wall of corrections (design/20-architecture.md §4). */
export const correctionSchema = z.object({
 span: z.string().min(1),
 fix: z.string().min(1),
 reason: z.string().min(1),
});
export type Correction = z.infer<typeof correctionSchema>;

export const turnSignalSchema = z.object({
 /** Must be an id from the target list the core supplied, or it is dropped (design/30-domain-model.md §2). */
 knowledge_point_id: z.string().min(1),
 outcome: knowledgeOutcomeSchema,
 evidence: z.string().default(""),
});
export type TurnSignal = z.infer<typeof turnSignalSchema>;

/**
 * What the classify call returns. It carries no learner-facing prose
 * (design/50-orchestration.md §3.4): the branch, the progress signals, the
 * corrections the continuation should weave in, and whether the learner
 * answered the question on the table.
 */
export const turnDecisionSchema = z.object({
 branch: turnBranchSchema,
 corrections: z.array(correctionSchema).max(2).default([]),
 signals: z.array(turnSignalSchema).max(8).default([]),
 /**
 * A clear attempt at the question the app last asked counts as answered, even
 * when the language is wrong. Defaults to true so a model that omits the field
 * never blocks the learner behind a question it cannot see.
 */
 answered_previous_question: z.boolean().default(true),
});
export type TurnDecision = z.infer<typeof turnDecisionSchema>;

/** The answer call writes one message, in the class's source language (§3.5). */
export const answerResultSchema = z.object({
 reply: z.string().min(1).max(1200),
});
export type AnswerResult = z.infer<typeof answerResultSchema>;

/**
 * The continue call writes the next conversational turn, in the class's target
 * language. The two fields are kept apart so the app can put the question last
 * and derive the pending question from it (§3.5).
 */
export const continuationResultSchema = z.object({
 feedback: z.string().max(600).default(""),
 question: z.string().min(1).max(400),
});
export type ContinuationResult = z.infer<typeof continuationResultSchema>;

/** Maximum corrections per turn, enforced by the schema above (design/20-architecture.md §4). */
export const MAX_CORRECTIONS_PER_TURN = 2;

/** Cap on targets the model may attribute a signal to (40-steering "a small list"). */
export const MAX_TARGETS_PER_TURN = 5;

/**
 * JSON Schemas handed to the model adapter for structured output
 * (design/20-architecture.md §5). Kept next to the zod schemas so the two cannot
 * drift silently.
 */
export const TURN_DECISION_JSON_SCHEMA: Record<string, unknown> = {
 type: "object",
 additionalProperties: false,
 required: ["branch", "corrections", "signals", "answered_previous_question"],
 properties: {
 branch: {
 type: "string",
 enum: ["attempt_judged", "question", "kp_question", "drift"],
 description:
 "How the learner's message was classified. Pick exactly one; do not invent a branch.",
 },
 corrections: {
 type: "array",
 maxItems: MAX_CORRECTIONS_PER_TURN,
 description: "Inline corrections attached to the moment. Empty when nothing is wrong.",
 items: {
 type: "object",
 additionalProperties: false,
 required: ["span", "fix", "reason"],
 properties: {
 span: { type: "string", description: "The learner's original wording." },
 fix: { type: "string", description: "The corrected wording." },
 reason: { type: "string", description: "One short reason." },
 },
 },
 },
 signals: {
 type: "array",
 maxItems: 8,
 description:
 "Progress signals. Use only knowledge_point_id values from the provided target list; otherwise omit the signal.",
 items: {
 type: "object",
 additionalProperties: false,
 required: ["knowledge_point_id", "outcome", "evidence"],
 properties: {
 knowledge_point_id: { type: "string" },
 outcome: {
 type: "string",
 enum: ["used", "used_with_help", "wrong", "seen"],
 },
 evidence: {
 type: "string",
 description: "The learner's words that justify this signal.",
 },
 },
 },
 },
 answered_previous_question: {
 type: "boolean",
 description:
 "True when this message is a clear attempt to answer the question you last asked the learner — a wrong attempt still counts. False when the learner asked something instead, said they did not understand, asked you to repeat or explain, or changed the subject. True when you have not asked a question yet.",
 },
 },
};

export const ANSWER_JSON_SCHEMA: Record<string, unknown> = {
 type: "object",
 additionalProperties: false,
 required: ["reply"],
 properties: {
 reply: {
 type: "string",
 description:
 "The answer to the learner's question, written only in the class's source language. No question back, no target-language text.",
 },
 },
};

export const CONTINUATION_JSON_SCHEMA: Record<string, unknown> = {
 type: "object",
 additionalProperties: false,
 required: ["feedback", "question"],
 properties: {
 feedback: {
 type: "string",
 description:
 "One or two short sentences in the class's target language reacting to the learner's answer, with any corrections woven in. Empty when nothing needs saying.",
 },
 question: {
 type: "string",
 description:
 "The next thing to ask or prompt the learner, written only in the class's target language.",
 },
 },
};

/**
 * The last question the app asked, so the graph can repeat it instead of moving
 * on (design/50-orchestration.md §3.5). Every composed reply ends with the
 * current question, so the question is the last question sentence of the most
 * recent agent message. Returns "" when the app has not asked anything yet.
 */
export function pendingQuestionOf(
 messages: readonly { readonly role: string; readonly content: string }[],
): string {
 for (let index = messages.length - 1; index >= 0; index -= 1) {
 const message = messages[index];
 if (message === undefined || message.role !== "agent") {
 continue;
 }
 const paragraphs = message.content
 .split(/\n\s*\n/u)
 .map((paragraph) => paragraph.trim())
 .filter((paragraph) => paragraph.length > 0);
 const last = paragraphs[paragraphs.length - 1];
 if (last === undefined) {
 continue;
 }
 const sentences = last
 .split(/(?<=[.!?])\s+/u)
 .map((sentence) => sentence.trim())
 .filter((sentence) => sentence.length > 0);
 const question = [...sentences].reverse().find((sentence) => sentence.includes("?"));
 return question ?? last;
 }
 return "";
}
