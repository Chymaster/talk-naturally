/**
 * The turn pipeline is tested directly — not through a channel or a host — with
 * a fake model and in-memory storage. No network, no live model (AGENT.md §11).
 */
import { describe, expect, it } from "vitest";
import { FakeModelAdapter, createScriptedModel } from "../adapters/fake-model.js";
import { MemoryStorage } from "../adapters/memory-storage.js";
import { StaticModelResolver } from "../adapters/model-resolver.js";
import { SequentialIdPort } from "../adapters/random-ids.js";
import { FixedClock } from "../adapters/system-clock.js";
import { ModelUnavailableError, type ModelPort } from "../core/ports/model.js";
import { createEngine } from "../engine/index.js";
import { NO_CLASS_REPLY, TURN_FAILED_REPLY } from "../engine/types.js";
import { importClass } from "../hosts/class-import.js";
import { allIds, NOW, rawFixture } from "./fixtures.js";

interface Signal {
  knowledge_point_id: string;
  outcome: "used" | "used_with_help" | "wrong" | "seen";
  evidence: string;
}

function turnReply(
  signals: Signal[],
  branch: string = "attempt_judged",
  corrections: { span: string; fix: string; reason: string }[] = [],
): unknown {
  return { branch, reply: `reply:${branch}`, corrections, signals };
}

async function setup(model: ModelPort) {
  const storage = new MemoryStorage();
  const learnerId = await storage.createLearner();
  const imported = await importClass(storage, learnerId, rawFixture, NOW);
  const engine = createEngine({
    storage,
    models: new StaticModelResolver(model),
    clock: new FixedClock(NOW),
    ids: new SequentialIdPort("turn"),
  });
  return { storage, learnerId, classId: imported.klass.id, klass: imported.klass, engine };
}

describe("handleTurn", () => {
  it("persists progress from a judged attempt and reports the branch", async () => {
    const klass = await importClass(new MemoryStorage(), "lrn_x", rawFixture, NOW);
    const [grammarId] = allIds(klass.klass) as [string, string, string, string];
    const model = createScriptedModel([
      turnReply([{ knowledge_point_id: grammarId, outcome: "used", evidence: "ich fahre" }]),
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

    const progress = await storage.getProgress(learnerId, classId);
    expect(progress).toHaveLength(1);
    expect(progress[0]).toMatchObject({ timesSeen: 1, timesUsed: 1, timesWrong: 0 });
  });

  it("routes a corrected attempt through the correction branch", async () => {
    const klass = await importClass(new MemoryStorage(), "lrn_x", rawFixture, NOW);
    const [grammarId] = allIds(klass.klass) as [string, string, string, string];
    const model = createScriptedModel([
      turnReply(
        [{ knowledge_point_id: grammarId, outcome: "wrong", evidence: "mit der Bus" }],
        "attempt_judged",
        [{ span: "mit der Bus", fix: "mit dem Bus", reason: "Dativ" }],
      ),
    ]);
    const { engine, storage, learnerId, classId } = await setup(model);

    const outcome = await engine.handleTurn({ learnerId, classId, channel: "cli", text: "x" });
    expect(outcome.handledAs).toBe("corrected");
    const progress = await storage.getProgress(learnerId, classId);
    expect(progress[0]?.timesWrong).toBe(1);
    expect(progress[0]?.timesUsed).toBe(0);
  });

  it("handles drift and re-anchors without progress", async () => {
    const model = createScriptedModel([turnReply([], "drift")]);
    const { engine, storage, learnerId, classId } = await setup(model);

    const outcome = await engine.handleTurn({ learnerId, classId, channel: "cli", text: "Fußball!" });
    expect(outcome.branch).toBe("drift");
    expect(outcome.handledAs).toBe("reanchored_after_drift");
    expect(outcome.appliedDeltas).toBe(0);
    expect(await storage.getProgress(learnerId, classId)).toHaveLength(0);
  });

  it("answers a knowledge-point question and still attributes the interaction", async () => {
    const klass = await importClass(new MemoryStorage(), "lrn_x", rawFixture, NOW);
    const [grammarId] = allIds(klass.klass) as [string, string, string, string];
    const model = createScriptedModel([
      turnReply([{ knowledge_point_id: grammarId, outcome: "seen", evidence: "warum dativ?" }], "kp_question"),
    ]);
    const { engine, storage, learnerId, classId } = await setup(model);

    const outcome = await engine.handleTurn({ learnerId, classId, channel: "cli", text: "Warum Dativ?" });
    expect(outcome.branch).toBe("kp_question");
    expect(outcome.appliedDeltas).toBe(1);
    const progress = await storage.getProgress(learnerId, classId);
    expect(progress[0]?.timesSeen).toBe(1);
  });

  it("drops a signal for an unknown id instead of attributing it", async () => {
    const model = createScriptedModel([
      turnReply([{ knowledge_point_id: "kp_0000000000000000", outcome: "used", evidence: "x" }]),
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
    const model = createScriptedModel([{ branch: "attempt_judged" }]);
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
      turnReply([{ knowledge_point_id: grammarId, outcome: "used", evidence: "a" }]),
      turnReply([{ knowledge_point_id: grammarId, outcome: "used", evidence: "b" }]),
    ]);
    const { engine, learnerId, classId } = await setup(model);

    await engine.handleTurn({ learnerId, classId, channel: "cli", text: "first message" });
    await engine.handleTurn({ learnerId, classId, channel: "cli", text: "second message" });

    const secondRequest = model.requests[1];
    expect(secondRequest).toBeDefined();
    const contents = secondRequest!.messages.map((message) => message.content);
    expect(contents).toContain("first message");
    expect(contents).toContain("reply:attempt_judged");
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
