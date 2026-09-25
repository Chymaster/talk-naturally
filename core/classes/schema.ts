/**
 * The one import schema — AGENT.md §19.1.
 *
 * Every source (built-in, imported, personal) is fitted into this shape; there
 * is no per-source shape. Field names are snake_case to match the source
 * material format; the domain types in `core/domain` are camelCase.
 */
import { z } from "zod";

export const rawKnowledgePointSchema = z.object({
  kind: z.enum(["grammar", "sentence_structure", "vocab"]),
  title: z.string().min(1),
  detail: z.string().default(""),
  raw_source: z.string().default(""),
});

export const rawClassInputSchema = z.object({
  /** Optional: derived from title + target language when absent (§6.4). */
  id: z.string().min(1).optional(),
  title: z.string().min(1),
  source_language: z.string().min(1),
  target_language: z.string().min(1),
  origin: z.enum(["imported", "builtin", "personal"]).default("imported"),
  points: z.array(rawKnowledgePointSchema).min(1),
});

/** What a caller may pass in (defaults optional). */
export type RawClassInput = z.input<typeof rawClassInputSchema>;
/** What the schema produces after defaults. */
export type RawClassInputParsed = z.output<typeof rawClassInputSchema>;
