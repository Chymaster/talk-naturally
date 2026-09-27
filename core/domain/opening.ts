/**
 * The scheduled opening message — design/50-orchestration.md §2.
 *
 * A session starts because the scheduler decided to start one, not because the
 * learner asked. The opening turn has no learner attempt to judge, so it uses a
 * smaller contract than a normal turn.
 */
import { z } from "zod";

export const openingResultSchema = z.object({
 reply: z.string().min(1).max(800),
});
export type OpeningResult = z.infer<typeof openingResultSchema>;

export const OPENING_JSON_SCHEMA: Record<string, unknown> = {
 type: "object",
 additionalProperties: false,
 required: ["reply"],
 properties: {
 reply: {
 type: "string",
 description:
 "The opening chat message: warm, short, and built around the first target. Ends by handing the turn to the learner.",
 },
 },
};
