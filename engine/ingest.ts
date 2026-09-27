/**
 * Uploaded material → personal class — design/60-ingestion.md §5.
 *
 * Extraction is an adapter behind the document port; the fitting prompt and the
 * validation of the model's proposed content live in `core/`; this module
 * orchestrates chunking, the model calls, the preview, and the import. The model
 * proposes content only — `fitClass` assigns every id (design/60-ingestion.md §1).
 *
 * Nothing is written until the learner confirms the preview (design/60-ingestion.md §5).
 * The pending preview and the rate limit live in memory, owned by one engine
 * instance; persisting them is a TODO in design/60-ingestion.md §5.
 */
import type { RawClassInput } from "../core/classes/schema.js";
import { FITTED_JSON_SCHEMA, fittedMaterialSchema } from "../core/domain/fit.js";
import { FIT_PROMPT_VERSION, buildFitSystemPrompt } from "../core/prompts/fit.js";
import type { DocumentSection } from "../core/ports/documents.js";
import { importRawClass } from "./class-import.js";
import type { EngineDeps, FitDocumentInput, TurnOutcome } from "./types.js";
import { commandOutcome } from "./types.js";

/** A big deck costs real money, so an upload is bounded (design/60-ingestion.md §5). */
const MAX_CHUNKS = 8;
const MAX_CHUNK_CHARS = 6000;
/** A pending preview is dropped if the learner does not answer it. */
const PENDING_TTL_MS = 15 * 60 * 1000;
/** Per-learner upload rate limit (design/60-ingestion.md §5). */
const FIT_COOLDOWN_MS = 60 * 1000;

type RawPoint = RawClassInput["points"][number];

interface Chunk {
 readonly unit: string;
 readonly unitOrder: number;
 readonly text: string;
}

interface PendingMaterial {
 readonly raw: RawClassInput;
 readonly filename: string;
 readonly createdAtMs: number;
}

const AFFIRMATIVE = ["yes", "y", "yeah", "yep", "ok", "okay", "sure", "confirm", "save", "add them", "ja"];
const NEGATIVE = ["no", "n", "nope", "cancel", "discard", "drop it", "don't", "dont", "nein"];

export function isAffirmative(text: string): boolean {
 const answer = text.trim().toLowerCase();
 return AFFIRMATIVE.some((word) => answer === word);
}

export function isNegative(text: string): boolean {
 const answer = text.trim().toLowerCase();
 return NEGATIVE.some((word) => answer === word);
}

export interface ChunkPlan {
 readonly chunks: readonly Chunk[];
 /** True when the document is longer than one upload may cover. */
 readonly truncated: boolean;
}

export function chunkSections(sections: readonly DocumentSection[]): ChunkPlan {
 const chunks: Chunk[] = [];
 let order = 0;
 for (const section of sections) {
 order += 1;
 const text = section.text.trim();
 if (text.length === 0) {
 continue;
 }
 for (let index = 0; index < text.length; index += MAX_CHUNK_CHARS) {
 if (chunks.length >= MAX_CHUNKS) {
 return { chunks, truncated: true };
 }
 chunks.push({
 unit: section.title.trim(),
 unitOrder: order,
 text: text.slice(index, index + MAX_CHUNK_CHARS),
 });
 }
 }
 return { chunks, truncated: false };
}

/**
 * The upload pipeline for one engine. The pending preview and the rate limit are
 * per-instance so two engines (or two tests) never share them.
 */
export interface MaterialFitter {
 fitUploadedDocument(deps: EngineDeps, input: FitDocumentInput): Promise<TurnOutcome>;
 /** Import a confirmed preview; null when there is nothing pending. */
 confirmPendingMaterial(deps: EngineDeps, learnerId: string): Promise<TurnOutcome | null>;
 hasPendingConfirmation(learnerId: string, nowMs: number): boolean;
 discardPending(learnerId: string): void;
}

export function createMaterialFitter(): MaterialFitter {
 const pendingByLearner = new Map<string, PendingMaterial>();
 const lastFitAtMs = new Map<string, number>();

 function pending(learnerId: string, nowMs: number): PendingMaterial | null {
 const entry = pendingByLearner.get(learnerId);
 if (entry === undefined) {
 return null;
 }
 if (nowMs - entry.createdAtMs > PENDING_TTL_MS) {
 pendingByLearner.delete(learnerId);
 return null;
 }
 return entry;
 }

 return {
 hasPendingConfirmation(learnerId: string, nowMs: number): boolean {
 return pending(learnerId, nowMs) !== null;
 },

 discardPending(learnerId: string): void {
 pendingByLearner.delete(learnerId);
 },

 async fitUploadedDocument(
 deps: EngineDeps,
 input: FitDocumentInput,
 ): Promise<TurnOutcome> {
 const turnId = deps.ids.newId();
 const nowMs = deps.clock.now().getTime();
 const fail = (reply: string, handledAs: string): TurnOutcome =>
 commandOutcome(reply, handledAs, "failed", turnId, FIT_PROMPT_VERSION);

 const documents = deps.documents;
 if (documents === undefined) {
 return fail("This server cannot read uploaded documents yet.", "fit_unavailable");
 }
 if (!documents.supports(input.mediaType, input.filename)) {
 return fail(
 `I cannot read ${input.filename} yet. Right now I can read .txt and .md; pdf, docx and pptx are not wired up on this server.`,
 "fit_unsupported",
 );
 }

 const lastFit = lastFitAtMs.get(input.learnerId);
 if (lastFit !== undefined && nowMs - lastFit < FIT_COOLDOWN_MS) {
 return fail(
 "I am still working through your last upload — give me a moment before sending another.",
 "fit_rate_limited",
 );
 }

 const settings = await deps.storage.getLearnerSettings(input.learnerId);
 const language = input.language ?? settings?.targetLanguage ?? null;
 if (language === null) {
 return fail(
 "Tell me which language you are learning first — use /language.",
 "fit_no_language",
 );
 }
 const sourceLanguage = input.sourceLanguage ?? "English";

 let extracted;
 try {
 extracted = await documents.extract({
 filename: input.filename,
 mediaType: input.mediaType,
 bytes: input.bytes,
 });
 } catch (error) {
 const message = error instanceof Error ? error.message : String(error);
 deps.logger?.({ event: "fit.extract_failed", learnerId: input.learnerId, message });
 return fail(`I could not read ${input.filename}: ${message}`, "fit_extract_failed");
 }

 const sections: readonly DocumentSection[] =
 extracted.sections.length > 0
 ? extracted.sections
 : [{ title: "", text: extracted.text }];
 // A document over the cap is refused in conversation, never silently
 // truncated (design/60-ingestion.md §5).
 const plan = chunkSections(sections);
 if (plan.truncated) {
 return fail(
 "That document is longer than one upload can cover. Split it and send the parts one at a time — nothing was saved.",
 "fit_too_large",
 );
 }
 const chunks = plan.chunks;
 if (chunks.length === 0) {
 return fail(`I could not find any text in ${input.filename}.`, "fit_empty");
 }

 lastFitAtMs.set(input.learnerId, nowMs);

 const model = await deps.models.forLearner(input.learnerId);
 const points: RawPoint[] = [];
 let inputTokens = 0;
 let outputTokens = 0;
 let fittedChunks = 0;

 for (const chunk of chunks) {
 try {
 const completion = await model.complete({
 system: buildFitSystemPrompt({
 language,
 sourceLanguage,
 unit: chunk.unit,
 text: chunk.text,
 }),
 messages: [
 { role: "user", content: "Extract the knowledge points from this material." },
 ],
 schemaName: "FittedMaterial",
 schema: FITTED_JSON_SCHEMA,
 maxOutputTokens: 1200,
 });
 inputTokens += completion.usage.inputTokens ?? 0;
 outputTokens += completion.usage.outputTokens ?? 0;
 const parsed = fittedMaterialSchema.safeParse(completion.parsed);
 if (!parsed.success) {
 // A partial fit is surfaced, never a crash (design/60-ingestion.md §1).
 deps.logger?.({ event: "fit.invalid_output", learnerId: input.learnerId });
 continue;
 }
 for (const point of parsed.data.points) {
 points.push({
 kind: point.kind,
 title: point.title,
 detail: point.detail,
 raw_source:
 point.raw_source.length > 0
 ? point.raw_source
 : `${input.filename}${chunk.unit.length > 0 ? ` — ${chunk.unit}` : ""}`,
 unit: chunk.unit.length > 0 ? chunk.unit : point.unit,
 unit_order: chunk.unit.length > 0 ? chunk.unitOrder : 0,
 });
 }
 fittedChunks += 1;
 } catch (error) {
 const message = error instanceof Error ? error.message : String(error);
 deps.logger?.({ event: "fit.model_error", learnerId: input.learnerId, message });
 }
 }

 deps.logger?.({
 event: "fit.fitted",
 learnerId: input.learnerId,
 filename: input.filename,
 chunks: fittedChunks,
 points: points.length,
 inputTokens,
 outputTokens,
 });

 if (points.length === 0) {
 return fail(
 `I could not turn ${input.filename} into anything to practise, so nothing was saved.`,
 "fit_no_points",
 );
 }

 const raw: RawClassInput = {
 title: input.title ?? input.filename,
 source_language: sourceLanguage,
 target_language: language,
 origin: "personal",
 points,
 };
 // Nothing is written yet: the learner confirms the preview first
 // (design/60-ingestion.md §5).
 pendingByLearner.set(input.learnerId, {
 raw,
 filename: input.filename,
 createdAtMs: nowMs,
 });

 const preview = points
 .slice(0, 5)
 .map((point) => `- ${point.title}`)
 .join("\n");
 const more = points.length > 5 ? `\n…and ${points.length - 5} more.` : "";
 return commandOutcome(
 `I read ${input.filename} and found ${points.length} knowledge points:\n${preview}${more}\n\n` +
 `Reply "yes" to add them as "${raw.title}", or "no" to discard.`,
 "fit_preview",
 "settings",
 turnId,
 FIT_PROMPT_VERSION,
 );
 },

 async confirmPendingMaterial(
 deps: EngineDeps,
 learnerId: string,
 ): Promise<TurnOutcome | null> {
 const entry = pending(learnerId, deps.clock.now().getTime());
 if (entry === null) {
 return null;
 }
 pendingByLearner.delete(learnerId);
 const imported = await importRawClass(
 deps.storage,
 learnerId,
 entry.raw,
 deps.clock.now().toISOString(),
 );
 deps.logger?.({
 event: "fit.imported",
 learnerId,
 classId: imported.klass.id,
 points: imported.pointCount,
 });
 return commandOutcome(
 `Added "${imported.klass.title}" with ${imported.pointCount} knowledge points. Say /class ${imported.klass.title} to study it.`,
 "fit_imported",
 "settings",
 deps.ids.newId(),
 FIT_PROMPT_VERSION,
 );
 },
 };
}
