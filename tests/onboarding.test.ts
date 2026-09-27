/**
 * Onboarding is a pure, offline state machine: deterministic matchers in
 * `core/onboarding/` and a settings-writing engine path that makes zero model
 * calls (design/60-ingestion.md §3, design/70-stack.md §5).
 */
import { describe, expect, it } from "vitest";
import { FakeModelAdapter, createScriptedModel } from "../adapters/fake-model.js";
import { MemoryStorage } from "../adapters/memory-storage.js";
import { StaticModelResolver } from "../adapters/model-resolver.js";
import { SequentialIdPort } from "../adapters/random-ids.js";
import { FixedClock } from "../adapters/system-clock.js";
import {
 isChapterStart,
 matchLanguage,
 matchLevel,
 matchUnit,
} from "../core/onboarding/onboarding.js";
import type { LevelDescriptor } from "../core/ports/catalog.js";
import { ModelUnavailableError } from "../core/ports/model.js";
import { createEngine } from "../engine/index.js";
import { NOW, stubCatalog } from "./fixtures.js";

const LEVELS: readonly LevelDescriptor[] = [
 { language: "German", level: "A1", title: "German A1", units: ["Kapitel 1", "Kapitel 2"] },
 { language: "German", level: "A2", title: "German A2", units: ["Kapitel 1", "Kapitel 3"] },
];

function ordinaryDecision(): unknown {
 return {
 branch: "attempt_judged",
 corrections: [],
 signals: [],
 answered_previous_question: true,
 };
}

function ordinaryContinuation(): unknown {
 return { feedback: "Sehr gut!", question: "Und was machst du sonst?" };
}

describe("onboarding matchers", () => {
 it("matches a language by name or by its German/ISO alias", () => {
 expect(matchLanguage("German", ["German", "French"])).toBe("German");
 expect(matchLanguage("Deutsch", ["German", "French"])).toBe("German");
 expect(matchLanguage("de", ["German", "French"])).toBe("German");
 expect(matchLanguage("Klingon", ["German", "French"])).toBeNull();
 });

 it("matches Chinese by name, pinyin, or Han characters", () => {
 const offered = ["German", "Chinese"];
 expect(matchLanguage("Chinese", offered)).toBe("Chinese");
 expect(matchLanguage("mandarin", offered)).toBe("Chinese");
 expect(matchLanguage("zh", offered)).toBe("Chinese");
 expect(matchLanguage("zhongwen", offered)).toBe("Chinese");
 expect(matchLanguage("中文", offered)).toBe("Chinese");
 expect(matchLanguage("我想学中文", offered)).toBe("Chinese");
 // CJK punctuation is dropped by normalization, so a trailing 。 is harmless.
 expect(matchLanguage("中文。", offered)).toBe("Chinese");
 });

 it("accepts Chinese hints for level and chapter answers", () => {
 expect(matchLevel("不知道", LEVELS)?.level).toBe("A1");
 const three: readonly LevelDescriptor[] = [
 { language: "Chinese", level: "A1", title: "Chinese A1", units: [] },
 { language: "Chinese", level: "A2", title: "Chinese A2", units: [] },
 { language: "Chinese", level: "B1", title: "Chinese B1", units: [] },
 ];
 expect(matchLevel("中级", three)?.level).toBe("A2");
 expect(isChapterStart("从头")).toBe(true);
 const units = [
 { unit: "问候和介绍", unitOrder: 1 },
 { unit: "数字、时间和日期", unitOrder: 2 },
 ];
 expect(matchUnit("2", units)?.unit).toBe("数字、时间和日期");
 expect(matchUnit("数字、时间和日期", units)?.unit).toBe("数字、时间和日期");
 });

 it("does not match a language from inside an unrelated word", () => {
 // Regression: two-letter aliases used to match as substrings, so "denken"
 // resolved to German and "seven" to English (design/60-ingestion.md §3).
 expect(matchLanguage("denken", ["German", "English"])).toBeNull();
 expect(matchLanguage("seven", ["German", "English"])).toBeNull();
 expect(matchLanguage("I am learning German", ["German", "English"])).toBe("German");
 });

 it("matches a level tag case-insensitively", () => {
 expect(matchLevel("A2", LEVELS)?.level).toBe("A2");
 expect(matchLevel("a2", LEVELS)?.level).toBe("A2");
 expect(matchLevel("B2", LEVELS)).toBeNull();
 });

 it('resolves "not sure" to the lowest level offered', () => {
 expect(matchLevel("not sure", LEVELS)?.level).toBe("A1");
 expect(matchLevel("keine Ahnung", LEVELS)?.level).toBe("A1");
 });

 it("treats an empty or start answer as the first chapter and a chapter name as not", () => {
 expect(isChapterStart("")).toBe(true);
 expect(isChapterStart("start")).toBe(true);
 expect(isChapterStart("chapter 4")).toBe(false);
 });

 it('matches "chapter 4" and "4" to the declared unit', () => {
 const units = [
 { unit: "Kapitel 1", unitOrder: 1 },
 { unit: "Kapitel 4", unitOrder: 4 },
 ];
 expect(matchUnit("chapter 4", units)?.unit).toBe("Kapitel 4");
 expect(matchUnit("4", units)?.unit).toBe("Kapitel 4");
 expect(matchUnit("chapter 9", units)).toBeNull();
 });
});

describe("onboarding end to end", () => {
 it("asks language, level and chapter, then asks the first question itself", async () => {
 const storage = new MemoryStorage();
 const learnerId = await storage.createLearner();
 const model = createScriptedModel([
 { reply: "Hallo! Womit fährst du zur Arbeit?" },
 ordinaryDecision(),
 ordinaryContinuation(),
 ]);
 const engine = createEngine({
 storage,
 models: new StaticModelResolver(model),
 clock: new FixedClock(NOW),
 ids: new SequentialIdPort("turn"),
 catalog: stubCatalog("German", [
 { level: "A1", units: ["Kapitel 1", "Kapitel 2"] },
 { level: "A2", units: ["Kapitel 1", "Kapitel 3"] },
 ]),
 });
 const turn = (text: string) => engine.handleTurn({ learnerId, channel: "cli", text });

 const language = await turn("");
 expect(language.branch).toBe("onboarding");
 expect(language.handledAs).toBe("onboarding_language");
 expect(language.reply).toContain("Which language are you learning?");
 expect(language.reply).toContain("German");

 const level = await turn("Deutsch");
 expect(level.handledAs).toBe("onboarding_level");
 expect(level.reply).toContain("Which level of German");
 expect(level.reply).toContain("A1");
 expect(level.reply).toContain("A2");

 const chapter = await turn("a2");
 expect(chapter.handledAs).toBe("onboarding_chapter");
 expect(chapter.reply).toContain("Where are you in German A2?");
 expect(chapter.reply).toContain("Kapitel 1");

 // The three deterministic questions made no model call (design/60-ingestion.md §3).
 expect(model.requests).toHaveLength(0);

 // Completing setup starts the first session itself, so the learner is asked
 // the first question instead of having to write first (design/50-orchestration.md §2).
 const done = await turn("start");
 expect(done.handledAs).toBe("onboarding_opened");
 expect(done.branch).toBe("opening");
 expect(done.reply).toBe("Hallo! Womit fährst du zur Arbeit?");
 expect(model.requests).toHaveLength(1);
 expect(model.requests[0]?.schemaName).toBe("OpeningMessage");

 const settings = await engine.getSettings(learnerId);
 expect(settings).toMatchObject({
 targetLanguage: "German",
 level: "A2",
 onboardingStep: "done",
 knownThroughUnit: 0,
 includedLevels: ["A1"],
 });
 expect(settings?.classId).not.toBeNull();
 expect(await storage.getProgress(learnerId, settings?.classId ?? "")).toHaveLength(0);

 // The opening question is persisted, so the learner's reply continues from it.
 const messages = await storage.recentMessages(learnerId, settings?.classId ?? "", 10);
 expect(messages).toHaveLength(1);
 expect(messages[0]?.role).toBe("agent");
 expect(messages[0]?.content).toBe("Hallo! Womit fährst du zur Arbeit?");

 // An ordinary message after setup is a normal turn: one classify call and one
 // target-language continuation, rather than the old single call.
 const ordinary = await turn("Hallo");
 expect(model.requests).toHaveLength(3);
 expect(model.requests.filter((request) => request.schemaName === "TurnDecision")).toHaveLength(1);
 expect(ordinary.branch).toBe("attempt_judged");
 expect(ordinary.handledAs).toBe("accepted");
 expect(ordinary.reply).toBe("Sehr gut!\n\nUnd was machst du sonst?");
 });

 it("lets a named chapter win over a bare start word", async () => {
 const storage = new MemoryStorage();
 const learnerId = await storage.createLearner();
 const engine = createEngine({
 storage,
 models: new StaticModelResolver(createScriptedModel([{ reply: "opening" }])),
 clock: new FixedClock(NOW),
 ids: new SequentialIdPort("turn"),
 catalog: stubCatalog("German", [
 { level: "A1", units: ["Kapitel 1", "Kapitel 2"] },
 ]),
 });
 const turn = (text: string) => engine.handleTurn({ learnerId, channel: "cli", text });

 expect((await turn("German")).handledAs).toBe("onboarding_level");
 expect((await turn("A1")).handledAs).toBe("onboarding_chapter");

 // Regression: "start at chapter 2" used to be read as "start at the
 // beginning", because the start word was checked before the chapter.
 const done = await turn("start at Kapitel 2");
 expect(done.handledAs).toBe("onboarding_opened");
 expect((await engine.getSettings(learnerId))?.knownThroughUnit).toBe(2);
 });

 it("keeps the setup confirmation when the first question cannot be asked", async () => {
 const storage = new MemoryStorage();
 const learnerId = await storage.createLearner();
 const model = new FakeModelAdapter(() => {
 throw new ModelUnavailableError("connection reset", true);
 });
 const engine = createEngine({
 storage,
 models: new StaticModelResolver(model),
 clock: new FixedClock(NOW),
 ids: new SequentialIdPort("turn"),
 catalog: stubCatalog("German", [{ level: "A1", units: ["Kapitel 1"] }]),
 });
 const turn = (text: string) => engine.handleTurn({ learnerId, channel: "cli", text });

 await turn("");
 await turn("German");
 expect((await turn("A1")).handledAs).toBe("onboarding_chapter");

 // Onboarding still completes without a provider: the deterministic setup
 // confirmation is delivered instead of a failure (design/60-ingestion.md §3).
 const done = await turn("start");
 expect(done.handledAs).toBe("onboarding_done");
 expect(done.reply).toContain("You're set up for German A1");

 const classId = (await engine.getSettings(learnerId))?.classId ?? "";
 expect(await storage.recentMessages(learnerId, classId, 10)).toHaveLength(0);
 });

 it("resumes the same question after a restart, because the state is persisted", async () => {
 const storage = new MemoryStorage();
 const learnerId = await storage.createLearner();
 const build = () =>
 createEngine({
 storage,
 models: new StaticModelResolver(createScriptedModel([{ reply: "opening" }])),
 clock: new FixedClock(NOW),
 ids: new SequentialIdPort("turn"),
 catalog: stubCatalog("German", [
 { level: "A1", units: ["Kapitel 1", "Kapitel 2"] },
 ]),
 });

 const first = build();
 expect(
 (await first.handleTurn({ learnerId, channel: "cli", text: "" })).handledAs,
 ).toBe("onboarding_language");
 expect(
 (await first.handleTurn({ learnerId, channel: "cli", text: "German" })).handledAs,
 ).toBe("onboarding_level");

 // A fresh engine over the same storage is a restart: the step must survive.
 const restarted = build();
 const resumed = await restarted.handleTurn({ learnerId, channel: "cli", text: "A1" });
 expect(resumed.handledAs).toBe("onboarding_chapter");
 expect(resumed.reply).toContain("Where are you in German A1?");
 expect(
 (await restarted.handleTurn({ learnerId, channel: "cli", text: "start" })).handledAs,
 ).toBe("onboarding_opened");
 });

 it("asks the pending onboarding question instead of opening a scheduled session", async () => {
 const storage = new MemoryStorage();
 const learnerId = await storage.createLearner();
 const model = createScriptedModel([ordinaryDecision()]);
 const engine = createEngine({
 storage,
 models: new StaticModelResolver(model),
 clock: new FixedClock(NOW),
 ids: new SequentialIdPort("turn"),
 catalog: stubCatalog("German", [{ level: "A1", units: ["Kapitel 1"] }]),
 });

 const outcome = await engine.startSession({ learnerId, channel: "scheduler" });
 expect(outcome.handledAs).toBe("needs_onboarding");
 expect(outcome.reply).toContain("Which language are you learning?");
 // Nothing opened, no model call, and no onboarding state was written or skipped.
 expect(model.requests).toHaveLength(0);
 expect(await engine.getSettings(learnerId)).toBeNull();
 });

 it("onboards a Chinese learner through the deterministic matchers", async () => {
 const storage = new MemoryStorage();
 const learnerId = await storage.createLearner();
 const model = createScriptedModel([{ reply: "你好！你叫什么名字？" }]);
 const engine = createEngine({
 storage,
 models: new StaticModelResolver(model),
 clock: new FixedClock(NOW),
 ids: new SequentialIdPort("turn"),
 catalog: stubCatalog("Chinese", [
 { level: "A1", units: ["问候和介绍", "数字、时间和日期"] },
 ]),
 });
 const turn = (text: string) => engine.handleTurn({ learnerId, channel: "cli", text });

 // A Han sentence containing 中文 resolves to Chinese without a model call.
 expect((await turn("我想学中文")).handledAs).toBe("onboarding_level");
 const chapter = await turn("A1");
 expect(chapter.reply).toContain("Where are you in Chinese A1?");
 expect(chapter.reply).toContain("问候和介绍");
 expect((await turn("从头")).handledAs).toBe("onboarding_opened");
 expect(await engine.getSettings(learnerId)).toMatchObject({
 targetLanguage: "Chinese",
 level: "A1",
 onboardingStep: "done",
 });
 expect(model.requests).toHaveLength(1);
 expect(model.requests[0]?.schemaName).toBe("OpeningMessage");
 });
});
