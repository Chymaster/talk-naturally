/**
 * The fitting contract — design/60-ingestion.md §5.
 *
 * What the model is allowed to propose when condensing uploaded material into
 * knowledge points. It proposes content only: it never supplies an id and never
 * attributes progress (design/60-ingestion.md §1). The core validates every
 * field and assigns ids itself.
 */
import { z } from "zod";

export const fittedPointSchema = z.object({
 kind: z.enum(["grammar", "sentence_structure", "vocab"]),
 title: z.string().min(1).max(120),
 detail: z.string().max(400).default(""),
 unit: z.string().max(80).default(""),
 raw_source: z.string().max(200).default(""),
});

export const fittedMaterialSchema = z.object({
 points: z.array(fittedPointSchema).min(1).max(60),
});

export type FittedMaterial = z.infer<typeof fittedMaterialSchema>;

export const FITTED_JSON_SCHEMA: Record<string, unknown> = {
 type: "object",
 additionalProperties: false,
 required: ["points"],
 properties: {
 points: {
 type: "array",
 minItems: 1,
 maxItems: 60,
 items: {
 type: "object",
 additionalProperties: false,
 required: ["kind", "title"],
 properties: {
 kind: { type: "string", enum: ["grammar", "sentence_structure", "vocab"] },
 title: { type: "string" },
 detail: { type: "string" },
 unit: { type: "string" },
 raw_source: { type: "string" },
 },
 },
 },
 },
};
