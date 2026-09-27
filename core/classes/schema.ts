/**
 * The one import schema — design/60-ingestion.md §1.
 *
 * Every source (built-in, imported, personal, model-fitted) is fitted into this
 * shape; there is no per-source shape. Field names are snake_case to match the
 * source material format; the domain types in `core/domain` are camelCase.
 */
import { z } from "zod";

export const rawKnowledgePointSchema = z.object({
 kind: z.enum(["grammar", "sentence_structure", "vocab"]),
 title: z.string().min(1),
 detail: z.string().default(""),
 raw_source: z.string().default(""),
 /** Chapter/unit label from the source material; "" when the material has no units (design/30-domain-model.md §1). */
 unit: z.string().default(""),
 /** Position of that unit within the level; 0 when the material has no units. */
 unit_order: z.number().int().min(0).default(0),
});

export const rawClassInputSchema = z.object({
 /** Optional: derived from title + target language when absent (design/30-domain-model.md §4). */
 id: z.string().min(1).optional(),
 title: z.string().min(1),
 source_language: z.string().min(1),
 target_language: z.string().min(1),
 /** CEFR level tag ("A1"–"C2"); null for material that does not declare one (design/30-domain-model.md §1). */
 level: z.string().min(1).nullable().default(null),
 origin: z.enum(["imported", "builtin", "personal"]).default("imported"),
 points: z.array(rawKnowledgePointSchema).min(1),
});

/** What a caller may pass in (defaults optional). */
export type RawClassInput = z.input<typeof rawClassInputSchema>;
/** What the schema produces after defaults. */
export type RawClassInputParsed = z.output<typeof rawClassInputSchema>;
