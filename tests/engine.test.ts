/**
 * The turn pipeline is tested directly — not through a channel or a host — with
 * a fake model and in-memory storage. No network, no live model (design/70-stack.md §5).
 */
import { describe, expect, it } from "vitest";
import { FakeModelAdapter, createScriptedModel } from "../adapters/fake-model.js";
import { MemoryStorage } from "../adapters/memory-storage.js";
import { StaticModelResolver } from "../adapters/model-resolver.js";
import { SequentialIdPort } from "../adapters/random-ids.js";
import { FixedClock } from "../adapters/system-clock.js";
import { ModelUnavailableError, type ModelPort } from "../core/ports/model.js";
import type { LevelCatalogPort } from "../core/ports/catalog.js";
import { createEngine } from "../engine/index.js";
import { NO_CLASS_REPLY, TURN_FAILED_REPLY } from "../engine/types.js";
import { importClass } from "../hosts/class-import.js";
import { allIds, NOW, onboardedSettings, rawFixture, stubCatalog } from "./fixtures.js";

interface Signal {
 knowledge_point_id: string;
 outcome: "used" | "used_with_help" | "wrong" | "seen";
 evidence: string;
}

function decision(
 signals: Signal[],
 branch: string = "attempt_judged",
 corrections: { span: string; fix: string; reason: string }[] = [],
 answeredPreviousQuestion = true,
): unknown {
 return {
 branch,
 corrections,
 signals,
 answered_previous_question: answeredPreviousQuestion,
 };
}

/** The answer call's reply, written in the class's source language. */
function answerReply(reply = "an answer in the source language"): unknown {
 return { reply };
}

/** The continue call's next target-language turn. */
function continuation(feedback = "", question = "Und wie geht es weiter?"): unknown {
 return { feedback, question };
}

/** Only the classify calls, in order, so multi-call turns stay readable. */
function classifyRequests(model: FakeModelAdapter) {
 return model.requests.filter((request) => request.schemaName === "TurnDecision");
}

async function setup(model: ModelPort, catalog?: LevelCatalogPort) {
 const storage = new MemoryStorage();
 const learnerId = await storage.createLearner();
 const imported = await importClass(storage, learnerId, rawFixture, NOW);
 // Every turn test starts from a set-up learner; onboarding would otherwise
 // answer the message and never call the model (design/60-ingestion.md §3).
 await storage.setLearnerSettings(
 learnerId,
 onboardedSettings(learnerId, {
 level: "A1",
 classId: imported.klass.id,
 knownThroughUnit: 0,
 includedLevels: [],
 }),
 );
 const engine = createEngine({
 storage,
 models: new StaticModelResolver(model),
 clock: new FixedClock(NOW),
 ids: new SequentialIdPort("turn"),
 ...(catalog === undefined ? {} : { catalog }),
 });
 return { storage, learnerId, classId: imported.klass.id, klass: imported.klass, engine };
}

describe("handleTurn", () => {
 it("persists progress from a judged attempt and reports the branch", async () => {
 const klass = await importClass(new MemoryStorage(), "lrn_x", rawFixture, NOW);
 const [grammarId] = allIds(klass.klass) as [string, string, string, string];
 const model = createScriptedModel([
 decision([{ knowledge_point_id: grammarId, outcome: "used", evidence: "ich fahre" }]),
 continuation("Sehr gut!", "Und wie ist es am Wochenende?"),
 ]);
 const { engine, storage, learnerId, classId } = await setup(model);

 const outcome = await engine.handleTurn({
 learnerId,
 classId,
 channel: "cli",
 text: "Ich fahre mit dem Bus.",
 });

 expect(outcome.branch).toBe("attempt_judged");
 expect(outcome.handledAs).toBe("accepted");
 expect(outcome.appliedDeltas).toBe(1);
 expect(outcome.steeringReason).not.toBe("");
 // The reply is the target-language continuation the second call produced.
 expect(outcome.reply).toBe("Sehr gut!\n\nUnd wie ist es am Wochenende?");

 const progress = await storage.getProgress(learnerId, classId);
 expect(progress).toHaveLength(1);
 expect(progress[0]).toMatchObject({ timesSeen: 1, timesUsed: 1, timesWrong: 0 });
 });

 it("routes a corrected attempt through the correction branch", async () => {
 const klass = await importClass(new MemoryStorage(), "lrn_x", rawFixture, NOW);
 const [grammarId] = allIds(klass.klass) as [string, string, string, string];
 const model = createScriptedModel([
 decision(
 [{ knowledge_point_id: grammarId, outcome: "wrong", evidence: "mit der Bus" }],
 "attempt_judged",
 [{ span: "mit der Bus", fix: "mit dem Bus", reason: "Dativ" }],
 ),
 answerReply('Almost! With "mit" you need "mit dem Bus".'),
 continuation("Versuch es noch einmal!", "Und weiter?"),
 ]);
 const { engine, storage, learnerId, classId } = await setup(model);

 const outcome = await engine.handleTurn({ learnerId, classId, channel: "cli", text: "x" });
 expect(outcome.handledAs).toBe("corrected");
 // The correction is the source-language answer call; the next turn is the
 // target-language continuation.
 expect(outcome.reply).toBe(
 'Almost! With "mit" you need "mit dem Bus".\n\nVersuch es noch einmal!\n\nUnd weiter?',
 );
 const progress = await storage.getProgress(learnerId, classId);
 expect(progress[0]?.timesWrong).toBe(1);
 expect(progress[0]?.timesUsed).toBe(0);
 });

 it("handles drift and re-anchors without progress", async () => {
 const model = createScriptedModel([
 decision([], "drift", [], false),
 answerReply("Fußball ist ein gutes Thema!"),
 ]);
 const { engine, storage, learnerId, classId } = await setup(model);

 const outcome = await engine.handleTurn({ learnerId, classId, channel: "cli", text: "Fußball!" });
 expect(outcome.branch).toBe("drift");
 expect(outcome.handledAs).toBe("reanchored_after_drift");
 expect(outcome.reply).toBe("Fußball ist ein gutes Thema!");
 expect(outcome.appliedDeltas).toBe(0);
 expect(await storage.getProgress(learnerId, classId)).toHaveLength(0);
 });

 it("answers a knowledge-point question and still attributes the interaction", async () => {
 const klass = await importClass(new MemoryStorage(), "lrn_x", rawFixture, NOW);
 const [grammarId] = allIds(klass.klass) as [string, string, string, string];
 const model = createScriptedModel([
 decision(
 [{ knowledge_point_id: grammarId, outcome: "seen", evidence: "warum dativ?" }],
 "kp_question",
 [],
 false,
 ),
 answerReply("Because dative."),
 ]);
 const { engine, storage, learnerId, classId } = await setup(model);

 const outcome = await engine.handleTurn({ learnerId, classId, channel: "cli", text: "Warum Dativ?" });
 expect(outcome.branch).toBe("kp_question");
 expect(outcome.handledAs).toBe("answered_knowledge_point_question");
 // The answer is the source-language message; the app adds no target-language turn.
 expect(outcome.reply).toBe("Because dative.");
 expect(outcome.appliedDeltas).toBe(1);
 const progress = await storage.getProgress(learnerId, classId);
 expect(progress[0]?.timesSeen).toBe(1);
 });

 it("drops a signal for an unknown id instead of attributing it", async () => {
 const model = createScriptedModel([
 decision([{ knowledge_point_id: "kp_0000000000000000", outcome: "used", evidence: "x" }]),
 continuation(),
 ]);
 const { engine, storage, learnerId, classId } = await setup(model);

 const outcome = await engine.handleTurn({ learnerId, classId, channel: "cli", text: "x" });
 expect(outcome.appliedDeltas).toBe(0);
 expect(outcome.unattributedSignals).toBe(1);
 expect(await storage.getProgress(learnerId, classId)).toHaveLength(0);
 });

 it("keeps the learner's message and progress when the provider fails", async () => {
 const model = new FakeModelAdapter(() => {
 throw new ModelUnavailableError("connection reset", true);
 });
 const { engine, storage, learnerId, classId } = await setup(model);

 const outcome = await engine.handleTurn({ learnerId, classId, channel: "cli", text: "Hallo" });
 expect(outcome.branch).toBe("failed");
 expect(outcome.reply).toBe(TURN_FAILED_REPLY);
 expect(await storage.getProgress(learnerId, classId)).toHaveLength(0);
 const messages = await storage.recentMessages(learnerId, classId, 10);
 expect(messages).toHaveLength(1);
 expect(messages[0]?.content).toBe("Hallo");
 });

 it("rejects malformed structured output without writing progress", async () => {
 const model = createScriptedModel([{ branch: "freeform_lecture" }]);
 const { engine, storage, learnerId, classId } = await setup(model);

 const outcome = await engine.handleTurn({ learnerId, classId, channel: "cli", text: "Hallo" });
 expect(outcome.branch).toBe("failed");
 expect(outcome.reply).toBe(TURN_FAILED_REPLY);
 expect(await storage.getProgress(learnerId, classId)).toHaveLength(0);
 expect(await storage.recentMessages(learnerId, classId, 10)).toHaveLength(1);
 });

 it("tells the learner when the class does not exist", async () => {
 const { engine, learnerId } = await setup(createScriptedModel([]));
 const outcome = await engine.handleTurn({
 learnerId,
 classId: "cls_missing",
 channel: "cli",
 text: "hi",
 });
 expect(outcome.reply).toBe(NO_CLASS_REPLY);
 expect(outcome.handledAs).toBe("no_class");
 });

 it("feeds prior messages back into the next turn's context", async () => {
 const klass = await importClass(new MemoryStorage(), "lrn_x", rawFixture, NOW);
 const [grammarId] = allIds(klass.klass) as [string, string, string, string];
 const model = createScriptedModel([
 decision([{ knowledge_point_id: grammarId, outcome: "used", evidence: "a" }]),
 continuation("Sehr gut!", "Womit fährst du zur Arbeit?"),
 decision([{ knowledge_point_id: grammarId, outcome: "used", evidence: "b" }]),
 continuation("Gut!", "Und am Wochenende?"),
 ]);
 const { engine, learnerId, classId } = await setup(model);

 await engine.handleTurn({ learnerId, classId, channel: "cli", text: "first message" });
 await engine.handleTurn({ learnerId, classId, channel: "cli", text: "second message" });

 const secondDecision = classifyRequests(model)[1];
 expect(secondDecision).toBeDefined();
 const contents = secondDecision!.messages.map((message) => message.content);
 expect(contents).toContain("first message");
 expect(contents).toContain("Sehr gut!\n\nWomit fährst du zur Arbeit?");
 // Only the question on the table, not the whole previous reply.
 expect(secondDecision!.system).toContain("Womit fährst du zur Arbeit?");
 expect(secondDecision!.system).not.toContain("Sehr gut!");
 });

 it("does not double-count when the same turn is written twice", async () => {
 const klass = await importClass(new MemoryStorage(), "lrn_x", rawFixture, NOW);
 const [grammarId] = allIds(klass.klass) as [string, string, string, string];
 const { storage, learnerId, classId } = await setup(createScriptedModel([]));
 const delta = {
 knowledgePointId: grammarId,
 seen: 1,
 used: 1,
 usedWithHelp: 0,
 wrong: 0,
 lastSeenAt: NOW,
 lastWrongAt: null,
 };

 const first = await storage.applyProgressDeltas(learnerId, "turn-1", [delta]);
 const replay = await storage.applyProgressDeltas(learnerId, "turn-1", [delta]);

 expect(first.applied).toHaveLength(1);
 expect(replay.applied).toHaveLength(0);
 expect(replay.skipped).toEqual([grammarId]);
 const progress = await storage.getProgress(learnerId, classId);
 expect(progress[0]?.timesUsed).toBe(1);
 });
});

describe("re-asking the question on the table", () => {
 it("re-asks when the learner asked a knowledge-point question instead of answering", async () => {
 const klass = await importClass(new MemoryStorage(), "lrn_x", rawFixture, NOW);
 const [grammarId] = allIds(klass.klass) as [string, string, string, string];
 const model = createScriptedModel([
 decision([{ knowledge_point_id: grammarId, outcome: "used", evidence: "a" }]),
 continuation("Sehr gut!", "Womit fährst du zur Arbeit?"),
 decision(
 [{ knowledge_point_id: grammarId, outcome: "seen", evidence: "warum dativ?" }],
 "kp_question",
 [],
 false,
 ),
 answerReply("Because dative."),
 ]);
 const { engine, storage, learnerId, classId } = await setup(model);

 await engine.handleTurn({ learnerId, classId, channel: "cli", text: "Ich fahre mit dem Bus." });
 const outcome = await engine.handleTurn({ learnerId, classId, channel: "cli", text: "Warum Dativ?" });

 expect(outcome.branch).toBe("kp_question");
 expect(outcome.handledAs).toBe("reasked_previous_question");
 // The answer is in the source language and the same question is repeated verbatim.
 expect(outcome.reply).toBe("Because dative.\n\nWomit fährst du zur Arbeit?");
 expect(outcome.appliedDeltas).toBe(1);
 const messages = await storage.recentMessages(learnerId, classId, 10);
 expect(messages.map((message) => message.role)).toEqual(["learner", "agent", "learner", "agent"]);
 });

 it("moves on when the learner did answer the previous question", async () => {
 const model = createScriptedModel([
 decision([], "question", [], true),
 answerReply("In English: train."),
 continuation("", "Und du?"),
 ]);
 const { engine, learnerId, classId } = await setup(model);

 const outcome = await engine.handleTurn({
 learnerId,
 classId,
 channel: "cli",
 text: "Wie sagt man train?",
 });

 expect(outcome.handledAs).toBe("answered_question");
 // The learner both asked and answered, so both single-language calls ran.
 expect(outcome.reply).toBe("In English: train.\n\nUnd du?");
 });

 it("counts a wrong but attempted answer as answered, without re-asking", async () => {
 const klass = await importClass(new MemoryStorage(), "lrn_x", rawFixture, NOW);
 const [grammarId] = allIds(klass.klass) as [string, string, string, string];
 const model = createScriptedModel([
 decision(
 [{ knowledge_point_id: grammarId, outcome: "wrong", evidence: "mit der Bus" }],
 "attempt_judged",
 [{ span: "mit der Bus", fix: "mit dem Bus", reason: "Dativ" }],
 true,
 ),
 answerReply('Almost! With "mit" you need "mit dem Bus".'),
 continuation("Versuch es noch einmal!", "Und weiter?"),
 ]);
 const { engine, learnerId, classId } = await setup(model);

 const outcome = await engine.handleTurn({
 learnerId,
 classId,
 channel: "cli",
 text: "Ich fahre mit der Bus.",
 });

 expect(outcome.handledAs).toBe("corrected");
 // Answered, so the conversation moves on even though the correction ran.
 expect(outcome.reply).toContain('Almost! With "mit" you need "mit dem Bus".');
 expect(outcome.reply).toContain("Und weiter?");
 });

 it("re-asks when the model marks the message as not an answer", async () => {
 const klass = await importClass(new MemoryStorage(), "lrn_x", rawFixture, NOW);
 const [grammarId] = allIds(klass.klass) as [string, string, string, string];
 const model = createScriptedModel([
 decision([{ knowledge_point_id: grammarId, outcome: "used", evidence: "a" }]),
 continuation("", "Womit fährst du?"),
 decision([], "attempt_judged", [], false),
 ]);
 const { engine, learnerId, classId } = await setup(model);

 await engine.handleTurn({ learnerId, classId, channel: "cli", text: "Ich fahre mit dem Bus." });
 const outcome = await engine.handleTurn({
 learnerId,
 classId,
 channel: "cli",
 text: "Ich verstehe nicht.",
 });

 expect(outcome.branch).toBe("attempt_judged");
 expect(outcome.handledAs).toBe("reasked_previous_question");
 expect(outcome.reply).toBe("Womit fährst du?");
 });

 it("puts the question on the table into the next turn's prompt", async () => {
 const klass = await importClass(new MemoryStorage(), "lrn_x", rawFixture, NOW);
 const [grammarId] = allIds(klass.klass) as [string, string, string, string];
 const model = createScriptedModel([
 decision([{ knowledge_point_id: grammarId, outcome: "used", evidence: "a" }]),
 continuation("Sehr gut!", "Womit fährst du zur Arbeit?"),
 decision([], "kp_question", [], false),
 answerReply("Because dative."),
 ]);
 const { engine, learnerId, classId } = await setup(model);

 await engine.handleTurn({ learnerId, classId, channel: "cli", text: "Ich fahre mit dem Bus." });
 const outcome = await engine.handleTurn({
 learnerId,
 classId,
 channel: "cli",
 text: "Warum Dativ?",
 });

 const secondDecision = classifyRequests(model)[1];
 expect(secondDecision?.system).toContain("# The question on the table");
 expect(secondDecision?.system).toContain("Womit fährst du zur Arbeit?");
 expect(secondDecision?.system).not.toContain("Sehr gut!");
 expect(outcome.handledAs).toBe("reasked_previous_question");
 });
});

describe("handleTurn onboarding route", () => {
 it("answers a fresh learner with onboarding and makes no model call", async () => {
 const storage = new MemoryStorage();
 const learnerId = await storage.createLearner();
 const imported = await importClass(storage, learnerId, rawFixture, NOW);
 const model = createScriptedModel([decision([])]);
 const engine = createEngine({
 storage,
 models: new StaticModelResolver(model),
 clock: new FixedClock(NOW),
 ids: new SequentialIdPort("turn"),
 catalog: stubCatalog("German", [{ level: "A1", units: ["Kapitel 1", "Kapitel 2"] }]),
 });

 const outcome = await engine.handleTurn({ learnerId, channel: "cli", text: "" });

 expect(outcome.branch).toBe("onboarding");
 expect(outcome.handledAs.startsWith("onboarding")).toBe(true);
 expect(outcome.reply).toContain("Which language are you learning?");

 // The onboarding route is deterministic: zero model calls and no writes.
 expect(model.requests).toHaveLength(0);
 expect(await storage.getProgress(learnerId, imported.klass.id)).toHaveLength(0);
 expect(storage.turnsOf(learnerId)).toHaveLength(0);
 expect(await storage.recentMessages(learnerId, imported.klass.id, 10)).toHaveLength(0);
 });

 it("does not run onboarding while the learner is already onboarded", async () => {
 const klass = await importClass(new MemoryStorage(), "lrn_x", rawFixture, NOW);
 const [grammarId] = allIds(klass.klass) as [string, string, string, string];
 const model = createScriptedModel([
 decision([{ knowledge_point_id: grammarId, outcome: "used", evidence: "x" }]),
 continuation("", "Und?"),
 ]);
 const catalog = stubCatalog("German", [{ level: "A1", units: ["Kapitel 1"] }]);
 const { engine, learnerId, classId } = await setup(model, catalog);

 const outcome = await engine.handleTurn({ learnerId, classId, channel: "cli", text: "Hallo" });

 // The graph went straight to assembly, not onboarding: one classify call, no opening.
 expect(classifyRequests(model)).toHaveLength(1);
 expect(model.requests.some((request) => request.schemaName === "OpeningMessage")).toBe(false);
 expect(outcome.branch).toBe("attempt_judged");
 expect(outcome.reply).toBe("Und?");
 expect(outcome.handledAs).toBe("accepted");
 });
});

describe("startSession", () => {
 it("opens with a message built around a selected target", async () => {
 const model = new FakeModelAdapter((request) => {
 if (request.schemaName !== "OpeningMessage") {
 throw new Error(`unexpected schema ${request.schemaName}`);
 }
 expect(request.system).toContain("id: kp_");
 return { reply: "Hallo! Womit fährst du zur Arbeit?" };
 });
 const { engine, storage, learnerId, classId } = await setup(model);
 await storage.setSchedule(learnerId, {
 learnerId,
 hourLocal: 9,
 enabled: true,
 lastSessionAt: null,
 });

 const outcome = await engine.startSession({ learnerId, classId, channel: "cli" });
 expect(outcome.handledAs).toBe("opened");
 expect(outcome.reply).toContain("Womit");
 expect(outcome.targetIds).toHaveLength(1);

 const messages = await storage.recentMessages(learnerId, classId, 10);
 expect(messages).toHaveLength(1);
 expect(messages[0]?.role).toBe("agent");

 const schedule = await storage.getSchedule(learnerId);
 expect(schedule?.lastSessionAt).toBe(NOW);
 });
});

describe("startConversation", () => {
 it("asks a new question instead of repeating the one on the table", async () => {
 const replies = [
 "Hallo! Womit fährst du zur Arbeit?",
 "Hallo! Was machst du am Wochenende?",
 ];
 let call = 0;
 const model = new FakeModelAdapter((request) => {
 if (request.schemaName !== "OpeningMessage") {
 throw new Error(`unexpected schema ${request.schemaName}`);
 }
 return { reply: replies[call++] ?? "Hallo!" };
 });
 const { engine, storage, learnerId, classId } = await setup(model);

 await engine.startSession({ learnerId, classId, channel: "cli" });
 const outcome = await engine.startConversation({ learnerId, classId, channel: "cli" });

 expect(outcome.handledAs).toBe("opened");
 expect(outcome.branch).toBe("opening");
 expect(outcome.reply).toBe("Hallo! Was machst du am Wochenende?");

 // The learner asked for this one, and the opening must not repeat the last
 // question (design/50-orchestration.md §2).
 const prompt = model.requests[1]?.system ?? "";
 expect(prompt).toContain("asked to start a new conversation");
 expect(prompt).not.toContain("did not ask for it");
 expect(prompt).toContain("# The question they are leaving behind");
 expect(prompt).toContain("Do not repeat or rephrase");
 expect(prompt).toContain("Womit fährst du zur Arbeit?");
 expect(model.requests[1]?.messages.at(-1)?.content).toBe("Start the new conversation now.");

 const turn = storage.turnsOf(learnerId).at(-1);
 expect(turn?.incoming).toBe("/new");
 expect(turn?.branch).toBe("opening");
 const messages = await storage.recentMessages(learnerId, classId, 10);
 expect(messages.at(-1)?.content).toBe("Hallo! Was machst du am Wochenende?");
 });

 it("is reachable as the typed /new and /start commands", async () => {
 const model = new FakeModelAdapter(() => ({ reply: "Hallo!" }));
 const { engine, learnerId, classId } = await setup(model);

 const viaNew = await engine.handleSettingsCommand({ learnerId, channel: "cli", text: "/new" });
 expect(viaNew.handledAs).toBe("opened");
 expect(viaNew.branch).toBe("opening");

 const viaStart = await engine.handleSettingsCommand({ learnerId, channel: "cli", text: "/start" });
 expect(viaStart.handledAs).toBe("opened");

 expect(model.requests).toHaveLength(2);
 expect(model.requests.every((request) => request.schemaName === "OpeningMessage")).toBe(true);
 });

 it("asks the onboarding question instead of opening before setup is complete", async () => {
 const storage = new MemoryStorage();
 const learnerId = await storage.createLearner();
 const model = createScriptedModel([]);
 const engine = createEngine({
 storage,
 models: new StaticModelResolver(model),
 clock: new FixedClock(NOW),
 ids: new SequentialIdPort("turn"),
 catalog: stubCatalog("German", [{ level: "A1", units: ["Kapitel 1"] }]),
 });

 const outcome = await engine.startConversation({ learnerId, channel: "cli" });
 expect(outcome.handledAs).toBe("needs_onboarding");
 expect(outcome.reply).toContain("Which language are you learning?");
 expect(model.requests).toHaveLength(0);
 });
});
