/**
 * The turn result: the contract between the model and the core (MVP.md §5.1).
 *
 * The model decides *how* to handle a message and returns structured output;
 * the core validates it (§8) and maps it to progress (§6.2). Untrusted model
 * output is untrusted, so this schema is the gate.
 */
import { z } from "zod";

/** Authored branch set — the model selects among these, never invents one (§18.2). */
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

/** Small, inline, attached to the moment — never a wall of corrections (§7.4). */
export const correctionSchema = z.object({
  span: z.string().min(1),
  fix: z.string().min(1),
  reason: z.string().min(1),
});
export type Correction = z.infer<typeof correctionSchema>;

export const turnSignalSchema = z.object({
  /** Must be an id from the target list the core supplied, or it is dropped (§6.2). */
  knowledge_point_id: z.string().min(1),
  outcome: knowledgeOutcomeSchema,
  evidence: z.string().default(""),
});
export type TurnSignal = z.infer<typeof turnSignalSchema>;

export const turnResultSchema = z.object({
  branch: turnBranchSchema,
  /** What the learner sees. */
  reply: z.string().min(1).max(1200),
  corrections: z.array(correctionSchema).max(2).default([]),
  signals: z.array(turnSignalSchema).max(8).default([]),
});
export type TurnResult = z.infer<typeof turnResultSchema>;

/** Maximum corrections per turn, enforced by the schema above (§7.4). */
export const MAX_CORRECTIONS_PER_TURN = 2;

/** Cap on targets the model may attribute a signal to (§6.3 "a small list"). */
export const MAX_TARGETS_PER_TURN = 5;

/**
 * JSON Schema handed to the model adapter for structured output (§8). Kept next
 * to the zod schema and covered by a test so the two cannot drift.
 */
export const TURN_RESULT_JSON_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["branch", "reply", "corrections", "signals"],
  properties: {
    branch: {
      type: "string",
      enum: ["attempt_judged", "question", "kp_question", "drift"],
      description:
        "How the learner's message was classified. Pick exactly one; do not invent a branch.",
    },
    reply: {
      type: "string",
      description:
        "The message the learner sees. Small, inline, natural. Never a lecture.",
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
  },
};
