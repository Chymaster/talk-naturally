/**
 * SQLite storage adapter — the single v1 engine (MVP.md design/20-architecture.md §1, MVP.md §8.1).
 *
 * Uses Node's built-in `node:sqlite` (still flagged experimental by Node), so
 * the PoC needs no native build step. This is the only place SQL exists; the
 * core sees `StoragePort` (design/20-architecture.md §2).
 *
 * Idempotency of progress is enforced by the `progress_writes` primary key on
 * (learner, turn, knowledge point) (design/30-domain-model.md §2). Cross-learner access is impossible
 * by construction: every statement filters on `learner_id` (design/30-domain-model.md §7).
 */
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { allKnowledgePoints, CLASS_SCHEMA_VERSION, type ClassRecord } from "../core/domain/knowledge.js";
import type { ProgressDelta, UserProgress } from "../core/domain/progress.js";
import {
 ONBOARDING_STEPS,
 type LearnerSettings,
 type OnboardingStep,
} from "../core/domain/settings.js";
import type {
 AppliedDeltas,
 AccessRequest,
 ChannelKind,
 ScheduleRecord,
 StoragePort,
 StoredMessage,
 TurnRecord,
} from "../core/ports/storage.js";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS learners (
 learner_id TEXT PRIMARY KEY,
 created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS channel_links (
 channel TEXT NOT NULL,
 channel_user_id TEXT NOT NULL,
 learner_id TEXT NOT NULL,
 PRIMARY KEY (channel, channel_user_id)
);

CREATE TABLE IF NOT EXISTS access_requests (
 channel TEXT NOT NULL,
 channel_user_id TEXT NOT NULL,
 status TEXT NOT NULL,
 display_name TEXT,
 requested_at TEXT NOT NULL,
 decided_at TEXT,
 learner_id TEXT,
 PRIMARY KEY (channel, channel_user_id)
);

CREATE TABLE IF NOT EXISTS classes (
 learner_id TEXT NOT NULL,
 class_id TEXT NOT NULL,
 payload TEXT NOT NULL,
 PRIMARY KEY (learner_id, class_id)
);

CREATE TABLE IF NOT EXISTS learner_settings (
 learner_id TEXT PRIMARY KEY,
 target_language TEXT,
 level TEXT,
 class_id TEXT,
 known_through_unit INTEGER NOT NULL DEFAULT 0,
 included_levels TEXT NOT NULL DEFAULT '[]',
 onboarding_step TEXT NOT NULL DEFAULT 'language',
 updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS schema_meta (
 key TEXT PRIMARY KEY,
 value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS progress (
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

CREATE TABLE IF NOT EXISTS progress_writes (
 learner_id TEXT NOT NULL,
 turn_id TEXT NOT NULL,
 knowledge_point_id TEXT NOT NULL,
 at TEXT NOT NULL,
 PRIMARY KEY (learner_id, turn_id, knowledge_point_id)
);

CREATE TABLE IF NOT EXISTS messages (
 message_id TEXT PRIMARY KEY,
 learner_id TEXT NOT NULL,
 class_id TEXT NOT NULL,
 role TEXT NOT NULL,
 content TEXT NOT NULL,
 at TEXT NOT NULL,
 turn_id TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS messages_by_learner ON messages (learner_id, class_id, at);

CREATE TABLE IF NOT EXISTS turns (
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

CREATE TABLE IF NOT EXISTS schedules (
 learner_id TEXT PRIMARY KEY,
 hour_local INTEGER NOT NULL,
 enabled INTEGER NOT NULL,
 last_session_at TEXT
);
`;

type Row = Record<string, unknown>;

function text(row: Row, key: string): string {
 return String(row[key] ?? "");
}

function numberOrNull(row: Row, key: string): number | null {
 const value = row[key];
 return typeof value === "number" ? value : null;
}

function stringOrNull(row: Row, key: string): string | null {
 const value = row[key];
 return typeof value === "string" ? value : null;
}

/** A malformed status degrades to `pending` (deny by default), never a crash. */
function toAccessStatus(raw: string): AccessRequest["status"] {
 return raw === "approved" || raw === "denied" ? raw : "pending";
}

function toAccessRequest(row: Row): AccessRequest {
 return {
 channel: text(row, "channel"),
 channelUserId: text(row, "channel_user_id"),
 status: toAccessStatus(text(row, "status")),
 displayName: stringOrNull(row, "display_name"),
 requestedAt: text(row, "requested_at"),
 decidedAt: stringOrNull(row, "decided_at"),
 learnerId: stringOrNull(row, "learner_id"),
 };
}

/** Key under which the persisted class-payload version is recorded (design/60-ingestion.md §1). */
const CLASS_SCHEMA_VERSION_KEY = "class_schema_version";

/**
 * The three grouping keys of a class dataset (design/30-domain-model.md §1).
 * Persisted payloads use `sentenceStructure`; the domain kind is
 * `sentence_structure`, so accept both while normalizing.
 */
const KNOWLEDGE_GROUP_KEYS = [
 "grammar",
 "sentenceStructure",
 "sentence_structure",
 "vocab",
] as const;

/**
 * Bring one persisted class payload up to the current schema: v2 added
 * `level` to a class and `unit`/`unitOrder` to every knowledge point
 * (design/30-domain-model.md §1). Only keys that are missing are defaulted, so
 * values already present are never rewritten (design/70-stack.md §5).
 */
function normalizeClassPayload(payload: string): Record<string, unknown> {
 const klass = JSON.parse(payload) as Record<string, unknown>;
 klass.schemaVersion = CLASS_SCHEMA_VERSION;
 if (!("level" in klass)) {
 klass.level = null;
 }
 for (const key of KNOWLEDGE_GROUP_KEYS) {
 const points = klass[key];
 if (!Array.isArray(points)) {
 continue;
 }
 for (const point of points) {
 if (point === null || typeof point !== "object") {
 continue;
 }
 const record = point as Record<string, unknown>;
 if (!("unit" in record)) {
 record.unit = "";
 }
 if (!("unitOrder" in record)) {
 record.unitOrder = 0;
 }
 }
 }
 return klass;
}

/** `included_levels` is a JSON array string; a malformed value degrades to no levels, never a crash. */
function parseIncludedLevels(raw: string): readonly string[] {
 try {
 const parsed = JSON.parse(raw) as unknown;
 return Array.isArray(parsed)
 ? parsed.filter((entry): entry is string => typeof entry === "string")
 : [];
 } catch {
 return [];
 }
}

function toOnboardingStep(raw: string): OnboardingStep {
 return (ONBOARDING_STEPS as readonly string[]).includes(raw)
 ? (raw as OnboardingStep)
 : "language";
}

export class SqliteStorage implements StoragePort {
 readonly #db: DatabaseSync;
 readonly #path: string;

 constructor(path: string) {
 this.#path = path;
 if (path !== ":memory:") {
 mkdirSync(dirname(path), { recursive: true });
 }
 this.#db = new DatabaseSync(path);
 this.#db.exec("PRAGMA journal_mode = WAL;");
 this.#db.exec("PRAGMA foreign_keys = ON;");
 // The admin host is a second process on the same file (design/74-access.md §4),
 // so a writer waits for the other instead of failing with SQLITE_BUSY.
 this.#db.exec("PRAGMA busy_timeout = 5000;");
 this.#db.exec(SCHEMA);
 this.#migrateClassSchema();
 this.#backfillAccessRequests();
 }

 close(): void {
 this.#db.close();
 }

 get path(): string {
 return this.#path;
 }

 /**
  * v1 → v2 class-schema migration (design/60-ingestion.md §1, design/70-stack.md §5).
  *
  * Runs on every open, inside one transaction. When the recorded version is
  * already current it returns immediately, so it is idempotent and safe on a
  * fresh or already-v2 database. Only the `classes` payloads are rewritten;
  * progress, messages, turns and schedules are never touched
  * (design/70-stack.md §5 "migrations are tested").
  */
 #migrateClassSchema(): void {
 const stored = this.#db
 .prepare("SELECT value FROM schema_meta WHERE key = ?")
 .get(CLASS_SCHEMA_VERSION_KEY) as Row | undefined;
 if (stored !== undefined && Number(text(stored, "value")) >= CLASS_SCHEMA_VERSION) {
 return;
 }

 const rows = this.#db
 .prepare("SELECT learner_id, class_id, payload FROM classes")
 .all() as Row[];
 const update = this.#db.prepare(
 "UPDATE classes SET payload = ? WHERE learner_id = ? AND class_id = ?",
 );
 const writeVersion = this.#db.prepare(
 `INSERT INTO schema_meta (key, value) VALUES (?, ?)
 ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
 );

 this.#db.exec("BEGIN");
 try {
 for (const row of rows) {
 update.run(
 JSON.stringify(normalizeClassPayload(text(row, "payload"))),
 text(row, "learner_id"),
 text(row, "class_id"),
 );
 }
 writeVersion.run(CLASS_SCHEMA_VERSION_KEY, String(CLASS_SCHEMA_VERSION));
 this.#db.exec("COMMIT");
 } catch (error) {
 this.#db.exec("ROLLBACK");
 throw error;
 }
 }

 /**
  * Grandfather every already-linked learner as approved
  * (design/74-access.md §8), so the approval gate does not lock out learners who
  * were using the bot before it existed. Idempotent: `INSERT OR IGNORE` is keyed
  * by (channel, channel_user_id), so a real decision is never overwritten.
  */
 #backfillAccessRequests(): void {
 this.#db
 .prepare(
 `INSERT OR IGNORE INTO access_requests
 (channel, channel_user_id, status, display_name, requested_at, decided_at, learner_id)
 SELECT links.channel, links.channel_user_id, 'approved', NULL,
 COALESCE(learners.created_at, ?), NULL, links.learner_id
 FROM channel_links links
 LEFT JOIN learners ON learners.learner_id = links.learner_id`,
 )
 .run(new Date().toISOString());
 }

 async createLearner(): Promise<string> {
 const learnerId = `lrn_${globalThis.crypto.randomUUID()}`;
 this.#db
 .prepare("INSERT INTO learners (learner_id, created_at) VALUES (?, ?)")
 .run(learnerId, new Date().toISOString());
 return learnerId;
 }

 async findLearnerId(channel: ChannelKind, channelUserId: string): Promise<string | null> {
 const row = this.#db
 .prepare(
 "SELECT learner_id FROM channel_links WHERE channel = ? AND channel_user_id = ?",
 )
 .get(channel, channelUserId) as Row | undefined;
 return row === undefined ? null : text(row, "learner_id");
 }

 async findChannelUserId(learnerId: string, channel: ChannelKind): Promise<string | null> {
 const row = this.#db
 .prepare(
 "SELECT channel_user_id FROM channel_links WHERE learner_id = ? AND channel = ? LIMIT 1",
 )
 .get(learnerId, channel) as Row | undefined;
 return row === undefined ? null : text(row, "channel_user_id");
 }

 async linkChannel(
 channel: ChannelKind,
 channelUserId: string,
 learnerId: string,
 ): Promise<void> {
 this.#db
 .prepare(
 `INSERT INTO channel_links (channel, channel_user_id, learner_id) VALUES (?, ?, ?)
 ON CONFLICT (channel, channel_user_id) DO UPDATE SET learner_id = excluded.learner_id`,
 )
 .run(channel, channelUserId, learnerId);
 }

 // --- access approval (design/74-access.md §2–§4) ---
 async requestAccess(
 channel: ChannelKind,
 channelUserId: string,
 displayName: string | null,
 ): Promise<AccessRequest> {
 this.#db
 .prepare(
 `INSERT INTO access_requests
 (channel, channel_user_id, status, display_name, requested_at, decided_at, learner_id)
 VALUES (?, ?, 'pending', ?, ?, NULL, NULL)
 ON CONFLICT (channel, channel_user_id) DO NOTHING`,
 )
 .run(channel, channelUserId, displayName, new Date().toISOString());
 const created = await this.getAccessRequest(channel, channelUserId);
 if (created === null) {
 throw new Error(`access request for ${channel}:${channelUserId} disappeared after insert`);
 }
 return created;
 }

 async getAccessRequest(
 channel: ChannelKind,
 channelUserId: string,
 ): Promise<AccessRequest | null> {
 const row = this.#db
 .prepare(
 "SELECT channel, channel_user_id, status, display_name, requested_at, decided_at, learner_id FROM access_requests WHERE channel = ? AND channel_user_id = ?",
 )
 .get(channel, channelUserId) as Row | undefined;
 return row === undefined ? null : toAccessRequest(row);
 }

 async listAccessRequests(): Promise<readonly AccessRequest[]> {
 const rows = this.#db
 .prepare(
 "SELECT channel, channel_user_id, status, display_name, requested_at, decided_at, learner_id FROM access_requests ORDER BY requested_at, channel, channel_user_id",
 )
 .all() as Row[];
 return rows.map(toAccessRequest);
 }

 async decideAccess(
 channel: ChannelKind,
 channelUserId: string,
 decision: "approved" | "denied",
 ): Promise<AccessRequest | null> {
 const existing = await this.getAccessRequest(channel, channelUserId);
 if (existing === null) {
 return null;
 }
 const decidedAt = new Date().toISOString();
 if (decision === "approved") {
 // Reuse the learner kept on a revoked record so progress survives
 // (design/74-access.md §7).
 const learnerId = existing.learnerId ?? (await this.createLearner());
 await this.linkChannel(channel, channelUserId, learnerId);
 this.#db
 .prepare(
 "UPDATE access_requests SET status = 'approved', decided_at = ?, learner_id = ? WHERE channel = ? AND channel_user_id = ?",
 )
 .run(decidedAt, learnerId, channel, channelUserId);
 } else {
 await this.unlinkChannel(channel, channelUserId);
 this.#db
 .prepare(
 "UPDATE access_requests SET status = 'denied', decided_at = ? WHERE channel = ? AND channel_user_id = ?",
 )
 .run(decidedAt, channel, channelUserId);
 }
 return this.getAccessRequest(channel, channelUserId);
 }

 async isLearnerApproved(learnerId: string): Promise<boolean> {
 const row = this.#db
 .prepare("SELECT 1 AS present FROM channel_links WHERE learner_id = ? LIMIT 1")
 .get(learnerId) as Row | undefined;
 return row !== undefined;
 }

 /** Remove the channel link on revocation; the learner and its progress stay (design/74-access.md §7). */
 private async unlinkChannel(channel: ChannelKind, channelUserId: string): Promise<void> {
 this.#db
 .prepare("DELETE FROM channel_links WHERE channel = ? AND channel_user_id = ?")
 .run(channel, channelUserId);
 }

 async saveClass(learnerId: string, klass: ClassRecord): Promise<void> {
 if (klass.ownerLearnerId !== null && klass.ownerLearnerId !== learnerId) {
 throw new Error(
 `refusing to write class ${klass.id} owned by ${klass.ownerLearnerId} under learner ${learnerId} (design/30-domain-model.md §7)`,
 );
 }
 this.#db
 .prepare(
 `INSERT INTO classes (learner_id, class_id, payload) VALUES (?, ?, ?)
 ON CONFLICT (learner_id, class_id) DO UPDATE SET payload = excluded.payload`,
 )
 .run(learnerId, klass.id, JSON.stringify(klass));
 }

 async getClass(learnerId: string, classId: string): Promise<ClassRecord | null> {
 const row = this.#db
 .prepare("SELECT payload FROM classes WHERE learner_id = ? AND class_id = ?")
 .get(learnerId, classId) as Row | undefined;
 if (row === undefined) {
 return null;
 }
 return JSON.parse(text(row, "payload")) as ClassRecord;
 }

 async listClasses(learnerId: string): Promise<readonly ClassRecord[]> {
 const rows = this.#db
 .prepare("SELECT payload FROM classes WHERE learner_id = ? ORDER BY class_id")
 .all(learnerId) as Row[];
 return rows.map((row) => JSON.parse(text(row, "payload")) as ClassRecord);
 }

 // Every statement filters on learner_id, so settings cannot leak across
 // learners (design/30-domain-model.md §7, §8).
 async getLearnerSettings(learnerId: string): Promise<LearnerSettings | null> {
 const row = this.#db
 .prepare("SELECT * FROM learner_settings WHERE learner_id = ?")
 .get(learnerId) as Row | undefined;
 if (row === undefined) {
 return null;
 }
 return {
 learnerId,
 targetLanguage: stringOrNull(row, "target_language"),
 level: stringOrNull(row, "level"),
 classId: stringOrNull(row, "class_id"),
 knownThroughUnit: numberOrNull(row, "known_through_unit") ?? 0,
 includedLevels: parseIncludedLevels(text(row, "included_levels")),
 onboardingStep: toOnboardingStep(text(row, "onboarding_step")),
 updatedAt: text(row, "updated_at"),
 };
 }

 async setLearnerSettings(learnerId: string, settings: LearnerSettings): Promise<void> {
 this.#db
 .prepare(
 `INSERT INTO learner_settings (
 learner_id, target_language, level, class_id, known_through_unit,
 included_levels, onboarding_step, updated_at
 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
 ON CONFLICT (learner_id) DO UPDATE SET
 target_language = excluded.target_language,
 level = excluded.level,
 class_id = excluded.class_id,
 known_through_unit = excluded.known_through_unit,
 included_levels = excluded.included_levels,
 onboarding_step = excluded.onboarding_step,
 updated_at = excluded.updated_at`,
 )
 .run(
 learnerId,
 settings.targetLanguage,
 settings.level,
 settings.classId,
 settings.knownThroughUnit,
 JSON.stringify(settings.includedLevels),
 settings.onboardingStep,
 settings.updatedAt,
 );
 }

 async getProgress(learnerId: string, classId: string): Promise<readonly UserProgress[]> {
 const klass = await this.getClass(learnerId, classId);
 if (klass === null) {
 return [];
 }
 const ids = new Set(allKnowledgePoints(klass).map((point) => point.id));
 const rows = this.#db
 .prepare("SELECT * FROM progress WHERE learner_id = ?")
 .all(learnerId) as Row[];
 return rows
 .filter((row) => ids.has(text(row, "knowledge_point_id")))
 .map((row) => this.#toProgress(learnerId, row));
 }

 #toProgress(learnerId: string, row: Row): UserProgress {
 return {
 learnerId,
 knowledgePointId: text(row, "knowledge_point_id"),
 timesSeen: numberOrNull(row, "times_seen") ?? 0,
 timesUsed: numberOrNull(row, "times_used") ?? 0,
 timesUsedWithHelp: numberOrNull(row, "times_used_with_help") ?? 0,
 timesWrong: numberOrNull(row, "times_wrong") ?? 0,
 lastSeenAt: stringOrNull(row, "last_seen_at"),
 lastWrongAt: stringOrNull(row, "last_wrong_at"),
 notes: text(row, "notes"),
 };
 }

 async applyProgressDeltas(
 learnerId: string,
 turnId: string,
 deltas: readonly ProgressDelta[],
 ): Promise<AppliedDeltas> {
 const upsert = this.#db.prepare(
 `INSERT INTO progress (
 learner_id, knowledge_point_id, times_seen, times_used, times_used_with_help,
 times_wrong, last_seen_at, last_wrong_at, notes
 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, '')
 ON CONFLICT (learner_id, knowledge_point_id) DO UPDATE SET
 times_seen = times_seen + excluded.times_seen,
 times_used = times_used + excluded.times_used,
 times_used_with_help = times_used_with_help + excluded.times_used_with_help,
 times_wrong = times_wrong + excluded.times_wrong,
 last_seen_at = COALESCE(excluded.last_seen_at, last_seen_at),
 last_wrong_at = COALESCE(excluded.last_wrong_at, last_wrong_at)`,
 );
 const claim = this.#db.prepare(
 `INSERT OR IGNORE INTO progress_writes (learner_id, turn_id, knowledge_point_id, at)
 VALUES (?, ?, ?, ?)`,
 );

 const applied: ProgressDelta[] = [];
 const skipped: string[] = [];
 this.#db.exec("BEGIN");
 try {
 for (const delta of deltas) {
 const claimResult = claim.run(
 learnerId,
 turnId,
 delta.knowledgePointId,
 delta.lastSeenAt ?? "",
 );
 if (Number(claimResult.changes) === 0) {
 // Already counted for this (turn, point) — a replay must not double-count (design/30-domain-model.md §2).
 skipped.push(delta.knowledgePointId);
 continue;
 }
 upsert.run(
 learnerId,
 delta.knowledgePointId,
 delta.seen,
 delta.used,
 delta.usedWithHelp,
 delta.wrong,
 delta.lastSeenAt,
 delta.lastWrongAt,
 );
 applied.push(delta);
 }
 this.#db.exec("COMMIT");
 } catch (error) {
 this.#db.exec("ROLLBACK");
 throw error;
 }
 return { applied, skipped };
 }

 async appendMessage(learnerId: string, message: Omit<StoredMessage, "id">): Promise<void> {
 this.#db
 .prepare(
 `INSERT INTO messages (message_id, learner_id, class_id, role, content, at, turn_id)
 VALUES (?, ?, ?, ?, ?, ?, ?)`,
 )
 .run(
 `msg_${globalThis.crypto.randomUUID()}`,
 learnerId,
 message.classId,
 message.role,
 message.content,
 message.at,
 message.turnId,
 );
 }

 async recentMessages(
 learnerId: string,
 classId: string,
 limit: number,
 ): Promise<readonly StoredMessage[]> {
 const rows = this.#db
 .prepare(
 `SELECT * FROM messages WHERE learner_id = ? AND class_id = ?
 ORDER BY at DESC, rowid DESC LIMIT ?`,
 )
 .all(learnerId, classId, Math.max(0, limit)) as Row[];
 return rows.reverse().map((row) => ({
 id: text(row, "message_id"),
 learnerId,
 classId: text(row, "class_id"),
 role: text(row, "role") === "learner" ? "learner" : "agent",
 content: text(row, "content"),
 at: text(row, "at"),
 turnId: text(row, "turn_id"),
 }));
 }

 async recordTurn(learnerId: string, turn: TurnRecord): Promise<void> {
 this.#db
 .prepare(
 `INSERT INTO turns (learner_id, turn_id, class_id, incoming, reply, branch, target_ids, steering_reason, created_at)
 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
 ON CONFLICT (learner_id, turn_id) DO NOTHING`,
 )
 .run(
 learnerId,
 turn.turnId,
 turn.classId,
 turn.incoming,
 turn.reply,
 turn.branch,
 JSON.stringify(turn.targetIds),
 turn.steeringReason,
 turn.createdAt,
 );
 }

 async getSchedule(learnerId: string): Promise<ScheduleRecord | null> {
 const row = this.#db
 .prepare("SELECT * FROM schedules WHERE learner_id = ?")
 .get(learnerId) as Row | undefined;
 if (row === undefined) {
 return null;
 }
 return {
 learnerId,
 hourLocal: numberOrNull(row, "hour_local") ?? 9,
 enabled: (numberOrNull(row, "enabled") ?? 1) === 1,
 lastSessionAt: stringOrNull(row, "last_session_at"),
 };
 }

 async setSchedule(learnerId: string, schedule: ScheduleRecord): Promise<void> {
 this.#db
 .prepare(
 `INSERT INTO schedules (learner_id, hour_local, enabled, last_session_at) VALUES (?, ?, ?, ?)
 ON CONFLICT (learner_id) DO UPDATE SET
 hour_local = excluded.hour_local,
 enabled = excluded.enabled,
 last_session_at = excluded.last_session_at`,
 )
 .run(
 learnerId,
 schedule.hourLocal,
 schedule.enabled ? 1 : 0,
 schedule.lastSessionAt,
 );
 }

 async listSchedules(): Promise<readonly ScheduleRecord[]> {
 const rows = this.#db.prepare("SELECT * FROM schedules").all() as Row[];
 return rows.map((row) => ({
 learnerId: text(row, "learner_id"),
 hourLocal: numberOrNull(row, "hour_local") ?? 9,
 enabled: (numberOrNull(row, "enabled") ?? 1) === 1,
 lastSessionAt: stringOrNull(row, "last_session_at"),
 }));
 }
}
