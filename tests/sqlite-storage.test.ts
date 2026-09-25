/**
 * Storage tests run against the real engine, SQLite (AGENT.md §11). The PoC has
 * one dialect and no second one to support (MVP.md §8.1).
 */
import { rmSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { SqliteStorage } from "../adapters/sqlite-storage.js";
import { allIds, makeClass, NOW } from "./fixtures.js";

const created: string[] = [];

function tempPath(): string {
  const path = `./var/test-${globalThis.crypto.randomUUID()}.db`;
  created.push(path);
  return path;
}

afterEach(() => {
  for (const path of created.splice(0)) {
    for (const suffix of ["", "-wal", "-shm"]) {
      rmSync(`${path}${suffix}`, { force: true });
    }
  }
});

describe("SqliteStorage", () => {
  it("links a channel identity to one learner, once", async () => {
    const storage = new SqliteStorage(":memory:");
    const learnerId = await storage.createLearner();
    await storage.linkChannel("discord", "123456789012345678", learnerId);

    expect(await storage.findLearnerId("discord", "123456789012345678")).toBe(learnerId);
    expect(await storage.findLearnerId("discord", "999999999999999999")).toBeNull();
    expect(await storage.findLearnerId("telegram", "123456789012345678")).toBeNull();
    storage.close();
  });

  it("keeps learner data isolated and refuses a mismatched owner", async () => {
    const storage = new SqliteStorage(":memory:");
    const alice = await storage.createLearner();
    const bob = await storage.createLearner();
    const klass = makeClass(alice);

    await storage.saveClass(alice, klass);

    expect(await storage.getClass(alice, klass.id)).not.toBeNull();
    expect(await storage.getClass(bob, klass.id)).toBeNull();
    await expect(storage.saveClass(bob, klass)).rejects.toThrow(/owned by/u);
    storage.close();
  });

  it("survives a restart", async () => {
    const path = tempPath();
    const first = new SqliteStorage(path);
    const learnerId = await first.createLearner();
    await first.linkChannel("discord", "123456789012345678", learnerId);
    const imported = makeClass(learnerId);
    await first.saveClass(learnerId, imported);
    const [grammarId] = allIds(imported) as [string, string, string, string];
    await first.applyProgressDeltas(learnerId, "turn-1", [
      {
        knowledgePointId: grammarId,
        seen: 1,
        used: 1,
        usedWithHelp: 0,
        wrong: 0,
        lastSeenAt: NOW,
        lastWrongAt: null,
      },
    ]);
    first.close();

    const second = new SqliteStorage(path);
    expect(await second.findLearnerId("discord", "123456789012345678")).toBe(learnerId);
    expect(await second.getClass(learnerId, imported.id)).not.toBeNull();
    const progress = await second.getProgress(learnerId, imported.id);
    expect(progress[0]?.timesUsed).toBe(1);
    second.close();
  });

  it("counts a turn once even if it is written twice", async () => {
    const storage = new SqliteStorage(":memory:");
    const learnerId = await storage.createLearner();
    const klass = makeClass(learnerId);
    await storage.saveClass(learnerId, klass);
    const [grammarId] = allIds(klass) as [string, string, string, string];
    const delta = {
      knowledgePointId: grammarId,
      seen: 1,
      used: 0,
      usedWithHelp: 0,
      wrong: 1,
      lastSeenAt: NOW,
      lastWrongAt: NOW,
    };

    const first = await storage.applyProgressDeltas(learnerId, "turn-1", [delta]);
    const replay = await storage.applyProgressDeltas(learnerId, "turn-1", [delta]);
    const otherTurn = await storage.applyProgressDeltas(learnerId, "turn-2", [delta]);

    expect(first.applied).toHaveLength(1);
    expect(replay.skipped).toEqual([grammarId]);
    expect(otherTurn.applied).toHaveLength(1);

    const progress = await storage.getProgress(learnerId, klass.id);
    expect(progress[0]).toMatchObject({ timesWrong: 2, timesSeen: 2, lastWrongAt: NOW });
    storage.close();
  });

  it("returns progress only for the class asked about", async () => {
    const storage = new SqliteStorage(":memory:");
    const learnerId = await storage.createLearner();
    const klass = makeClass(learnerId);
    await storage.saveClass(learnerId, klass);
    const [grammarId] = allIds(klass) as [string, string, string, string];
    await storage.applyProgressDeltas(learnerId, "turn-1", [
      {
        knowledgePointId: grammarId,
        seen: 1,
        used: 0,
        usedWithHelp: 0,
        wrong: 0,
        lastSeenAt: NOW,
        lastWrongAt: null,
      },
    ]);

    expect(await storage.getProgress(learnerId, klass.id)).toHaveLength(1);
    expect(await storage.getProgress(learnerId, "cls_other")).toHaveLength(0);
    storage.close();
  });

  it("stores messages in chronological order and honours the limit", async () => {
    const storage = new SqliteStorage(":memory:");
    const learnerId = await storage.createLearner();
    const klass = makeClass(learnerId);
    await storage.saveClass(learnerId, klass);

    for (let index = 0; index < 3; index += 1) {
      await storage.appendMessage(learnerId, {
        learnerId,
        classId: klass.id,
        role: index % 2 === 0 ? "learner" : "agent",
        content: `message-${index}`,
        at: new Date(Date.parse(NOW) + index * 1000).toISOString(),
        turnId: `turn-${index}`,
      });
    }

    const recent = await storage.recentMessages(learnerId, klass.id, 2);
    expect(recent.map((message) => message.content)).toEqual(["message-1", "message-2"]);
    storage.close();
  });

  it("round-trips a schedule", async () => {
    const storage = new SqliteStorage(":memory:");
    const learnerId = await storage.createLearner();
    await storage.setSchedule(learnerId, {
      learnerId,
      hourLocal: 20,
      enabled: true,
      lastSessionAt: NOW,
    });

    expect(await storage.getSchedule(learnerId)).toMatchObject({ hourLocal: 20, enabled: true });
    expect(await storage.listSchedules()).toHaveLength(1);

    await storage.setSchedule(learnerId, { learnerId, hourLocal: 7, enabled: false, lastSessionAt: null });
    expect(await storage.getSchedule(learnerId)).toMatchObject({ hourLocal: 7, enabled: false });
    storage.close();
  });
});
