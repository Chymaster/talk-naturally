/**
 * Upload → fit → preview → confirm — design/60-ingestion.md §5.
 *
 * The pipeline is offline and deterministic: a text document is extracted by an
 * adapter, a fake model proposes content, the core validates it, and nothing is
 * written until the learner confirms. The model never assigns an id.
 */
import { describe, expect, it } from "vitest";
import { FakeModelAdapter, createScriptedModel } from "../adapters/fake-model.js";
import { MemoryStorage } from "../adapters/memory-storage.js";
import { StaticModelResolver } from "../adapters/model-resolver.js";
import { SequentialIdPort } from "../adapters/random-ids.js";
import { FixedClock } from "../adapters/system-clock.js";
import { TextDocumentAdapter } from "../adapters/text-documents.js";
import { blankSettings } from "../core/domain/settings.js";
import { createEngine } from "../engine/index.js";
import { NOW } from "./fixtures.js";

const DOCUMENT = [
 "# Kapitel 1: Reisen",
 "",
 "Mit dem Zug fahren wir nach Berlin.",
 "",
 "## Kapitel 2: Essen",
 "",
 "Ich esse gern Brot.",
].join("\n");

function bytes(text: string): Uint8Array {
 return new TextEncoder().encode(text);
}

/** One distinct point per chunk, so unit assignment is observable. */
function fittingModel(): FakeModelAdapter {
 return new FakeModelAdapter((request) => {
 const first = request.system.includes("Kapitel 1: Reisen");
 return {
 points: [
 {
 kind: first ? "grammar" : "vocab",
 title: first ? "Mit dem Zug fahren" : "das Brot",
 detail: "short explanation",
 raw_source: "",
 },
 ],
 };
 });
}

async function setup(options: {
 language?: string | null;
 model?: FakeModelAdapter;
} = {}) {
 const storage = new MemoryStorage();
 const learnerId = await storage.createLearner();
 await storage.setLearnerSettings(learnerId, {
 ...blankSettings(learnerId),
 targetLanguage: options.language === undefined ? "German" : options.language,
 updatedAt: NOW,
 });
 const model = options.model ?? fittingModel();
 const engine = createEngine({
 storage,
 models: new StaticModelResolver(model),
 clock: new FixedClock(NOW),
 ids: new SequentialIdPort("turn"),
 documents: new TextDocumentAdapter(),
 });
 return { storage, learnerId, model, engine };
}

function upload(learnerId: string, filename = "notes.md", text = DOCUMENT) {
 return {
 learnerId,
 filename,
 mediaType: "text/markdown",
 bytes: bytes(text),
 };
}

describe("upload → fit → confirm (design/60-ingestion.md §5)", () => {
 it("previews the fitted points and writes nothing until confirmed", async () => {
 const { storage, learnerId, model, engine } = await setup();

 const preview = await engine.fitDocument(upload(learnerId));
 expect(preview.handledAs).toBe("fit_preview");
 expect(preview.reply).toContain("found 2 knowledge points");
 expect(preview.reply).toContain("Mit dem Zug fahren");
 expect(preview.reply).toContain('Reply "yes"');

 // One model call per document section, and nothing persisted yet.
 expect(model.requests).toHaveLength(2);
 expect(await storage.listClasses(learnerId)).toHaveLength(0);
 expect(await storage.getProgress(learnerId, "unused")).toHaveLength(0);

 const confirmed = await engine.handleTurn({ learnerId, channel: "cli", text: "yes" });
 expect(confirmed.handledAs).toBe("fit_imported");

 const classes = await storage.listClasses(learnerId);
 expect(classes).toHaveLength(1);
 const klass = classes[0];
 expect(klass?.origin).toBe("personal");
 expect(klass?.level).toBeNull();
 expect(klass?.targetLanguage).toBe("German");
 const points = [...(klass?.grammar ?? []), ...(klass?.vocab ?? [])];
 expect(points).toHaveLength(2);
 // The document's own headings became the units (design/60-ingestion.md §5).
 expect(points.map((point) => point.unit).sort()).toEqual([
 "Kapitel 1: Reisen",
 "Kapitel 2: Essen",
 ]);
 expect(points.map((point) => point.unitOrder).sort((left, right) => left - right)).toEqual([1, 2]);
 // The model proposed content; the core assigned the ids.
 expect(points.every((point) => point.id.startsWith("kp_"))).toBe(true);
 });

 it("discards the preview when the learner says no", async () => {
 const { storage, learnerId, engine } = await setup();

 expect((await engine.fitDocument(upload(learnerId))).handledAs).toBe("fit_preview");
 const discarded = await engine.handleTurn({ learnerId, channel: "cli", text: "no" });
 expect(discarded.handledAs).toBe("fit_discarded");
 expect(await storage.listClasses(learnerId)).toHaveLength(0);

 // A later unrelated message is an ordinary turn again, not a confirmation.
 const ordinary = await engine.handleTurn({ learnerId, channel: "cli", text: "Hallo" });
 expect(ordinary.handledAs).not.toBe("fit_imported");
 });

 it("refuses a format the adapter cannot read, without calling the model", async () => {
 const { storage, learnerId, model, engine } = await setup();

 const outcome = await engine.fitDocument({
 learnerId,
 filename: "slides.pdf",
 mediaType: "application/pdf",
 bytes: bytes("not really a pdf"),
 });
 expect(outcome.handledAs).toBe("fit_unsupported");
 expect(outcome.reply).toContain("pdf");
 expect(model.requests).toHaveLength(0);
 expect(await storage.listClasses(learnerId)).toHaveLength(0);
 });

 it("asks for a language before fitting when the learner has not chosen one", async () => {
 const { learnerId, model, engine } = await setup({ language: null });

 const outcome = await engine.fitDocument(upload(learnerId));
 expect(outcome.handledAs).toBe("fit_no_language");
 expect(model.requests).toHaveLength(0);
 });

 it("rate-limits a second upload from the same learner", async () => {
 const { learnerId, engine } = await setup();

 expect((await engine.fitDocument(upload(learnerId))).handledAs).toBe("fit_preview");
 const second = await engine.fitDocument(upload(learnerId, "more.md"));
 expect(second.handledAs).toBe("fit_rate_limited");
 });

 it("refuses a document longer than one upload may cover, rather than truncating it", async () => {
 const { storage, learnerId, model, engine } = await setup();
 const sections = Array.from(
 { length: 9 },
 (_, index) => `# Teil ${index + 1}\n\nInhalt ${index + 1}.`,
 );

 const outcome = await engine.fitDocument(upload(learnerId, "long.md", sections.join("\n\n")));
 expect(outcome.handledAs).toBe("fit_too_large");
 expect(model.requests).toHaveLength(0);
 expect(await storage.listClasses(learnerId)).toHaveLength(0);
 });

 it("reports no points rather than importing an empty class", async () => {
 const { storage, learnerId, engine } = await setup({
 model: createScriptedModel([{ points: [] }]),
 });

 const outcome = await engine.fitDocument(upload(learnerId, "empty.md", "   \n  "));
 expect(outcome.handledAs).toBe("fit_empty");
 const withText = await engine.fitDocument(upload(learnerId, "blank.md", "hello"));
 expect(withText.handledAs).toBe("fit_no_points");
 expect(await storage.listClasses(learnerId)).toHaveLength(0);
 });
});
