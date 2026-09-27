/**
 * Storage tests run against the real engine, SQLite (design/70-stack.md §5). The PoC has
 * one dialect and no second one to support (MVP.md MVP.md §8.1).
 */
import { rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { SqliteStorage } from "../adapters/sqlite-storage.js";
import { CLASS_SCHEMA_VERSION } from "../core/domain/knowledge.js";
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

 it("migrates a v1 class payload to schema 2 without touching learner history", async () => {
 const path = tempPath();
 const learnerId = "lrn_v1";
 const classId = "cls_v1";
 // v1 shape: no class `level`, and no `unit`/`unitOrder` on any point.
 const v1Class = {
 schemaVersion: 1,
 id: classId,
 ownerLearnerId: learnerId,
 title: "Legacy Chapter",
 sourceLanguage: "English",
 targetLanguage: "German",
 importedAt: NOW,
 origin: "imported",
 grammar: [
 {
 id: "kp_grammar",
 kind: "grammar",
 title: "Dativ",
 detail: "dative",
 rawSource: "t1",
 canonicalKey: "grammar|Dativ",
 retiredAt: null,
 },
 ],
 sentenceStructure: [
 {
 id: "kp_sentence",
 kind: "sentence_structure",
 title: "Womit fährst du?",
 detail: "question",
 rawSource: "t2",
 canonicalKey: "sentence_structure|Womit fährst du?",
 retiredAt: null,
 },
 ],
 vocab: [
 {
 id: "kp_vocab",
 kind: "vocab",
 title: "der Bus",
 detail: "bus",
 rawSource: "t3",
 canonicalKey: "vocab|der Bus",
 retiredAt: null,
 },
 ],
 };

 const v1 = new DatabaseSync(path);
 v1.exec(`
CREATE TABLE classes (
 learner_id TEXT NOT NULL,
 class_id TEXT NOT NULL,
 payload TEXT NOT NULL,
 PRIMARY KEY (learner_id, class_id)
);
CREATE TABLE progress (
 learner_id TEXT NOT NULL,
 knowledge_point_id TEXT NOT NULL,
 times_seen INTEGER NOT NULL DEFAULT 0,
 times_used INTEGER NOT NULL DEFAULT 0,
 times_used_with_help INTEGER NOT NULL DEFAULT 0,
 times_wrong INTEGER NOT NULL DEFAULT 0,
 last_seen_at TEXT,
 last_wrong_at TEXT,
 notes TEXT NOT NULL DEFAULT '',
 PRIMARY KEY (learner_id, knowledge_point_id)
);
CREATE TABLE messages (
 message_id TEXT PRIMARY KEY,
 learner_id TEXT NOT NULL,
 class_id TEXT NOT NULL,
 role TEXT NOT NULL,
 content TEXT NOT NULL,
 at TEXT NOT NULL,
 turn_id TEXT NOT NULL
);
CREATE TABLE turns (
 learner_id TEXT NOT NULL,
 turn_id TEXT NOT NULL,
 class_id TEXT NOT NULL,
 incoming TEXT NOT NULL,
 reply TEXT NOT NULL,
 branch TEXT NOT NULL,
 target_ids TEXT NOT NULL,
 steering_reason TEXT NOT NULL,
 created_at TEXT NOT NULL,
 PRIMARY KEY (learner_id, turn_id)
);
CREATE TABLE schedules (
 learner_id TEXT PRIMARY KEY,
 hour_local INTEGER NOT NULL,
 enabled INTEGER NOT NULL,
 last_session_at TEXT
);
`);
 v1.prepare("INSERT INTO classes (learner_id, class_id, payload) VALUES (?, ?, ?)").run(
 learnerId,
 classId,
 JSON.stringify(v1Class),
 );
 v1.prepare(
 `INSERT INTO progress (
 learner_id, knowledge_point_id, times_seen, times_used, times_used_with_help,
 times_wrong, last_seen_at, last_wrong_at, notes
 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
 ).run(learnerId, "kp_grammar", 3, 1, 0, 2, NOW, NOW, "needs work");
 v1.prepare(
 `INSERT INTO messages (message_id, learner_id, class_id, role, content, at, turn_id)
 VALUES (?, ?, ?, ?, ?, ?, ?)`,
 ).run("msg_v1", learnerId, classId, "learner", "hallo", NOW, "turn_v1");
 v1.prepare(
 `INSERT INTO turns (learner_id, turn_id, class_id, incoming, reply, branch, target_ids, steering_reason, created_at)
 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
 ).run(learnerId, "turn_v1", classId, "hallo", "Hallo!", "practice", "[]", "first unattempted", NOW);
 v1.prepare("INSERT INTO schedules (learner_id, hour_local, enabled, last_session_at) VALUES (?, ?, ?, ?)").run(
 learnerId,
 20,
 1,
 NOW,
 );
 v1.close();

 const storage = new SqliteStorage(path);
 const klass = await storage.getClass(learnerId, classId);
 expect(klass?.schemaVersion).toBe(CLASS_SCHEMA_VERSION);
 expect(klass?.level).toBeNull();
 const points = [...(klass?.grammar ?? []), ...(klass?.sentenceStructure ?? []), ...(klass?.vocab ?? [])];
 expect(points).toHaveLength(3);
 for (const point of points) {
 expect(point.unit).toBe("");
 expect(point.unitOrder).toBe(0);
 }

 const progress = await storage.getProgress(learnerId, classId);
 expect(progress).toHaveLength(1);
 expect(progress[0]).toMatchObject({
 knowledgePointId: "kp_grammar",
 timesSeen: 3,
 timesUsed: 1,
 timesWrong: 2,
 notes: "needs work",
 });
 const messages = await storage.recentMessages(learnerId, classId, 10);
 expect(messages.map((message) => message.content)).toEqual(["hallo"]);
 expect(await storage.getSchedule(learnerId)).toMatchObject({ hourLocal: 20, enabled: true });
 storage.close();

 // Idempotent: reopening an already-migrated database changes nothing.
 const reopened = new SqliteStorage(path);
 const again = await reopened.getClass(learnerId, classId);
 expect(again?.schemaVersion).toBe(CLASS_SCHEMA_VERSION);
 expect(again?.vocab[0]).toMatchObject({ unit: "", unitOrder: 0 });
 reopened.close();

 // Turns and the recorded version survived the migration.
 const raw = new DatabaseSync(path);
 const turn = raw
 .prepare("SELECT incoming, reply FROM turns WHERE learner_id = ?")
 .get(learnerId) as Record<string, unknown> | undefined;
 expect(turn).toMatchObject({ incoming: "hallo", reply: "Hallo!" });
 const version = raw
 .prepare("SELECT value FROM schema_meta WHERE key = 'class_schema_version'")
 .get() as Record<string, unknown> | undefined;
 expect(version?.value).toBe(String(CLASS_SCHEMA_VERSION));
 raw.close();
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
