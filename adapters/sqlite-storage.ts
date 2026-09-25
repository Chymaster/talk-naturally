/**
 * SQLite storage adapter — the single v1 engine (MVP.md §2, §8.1).
 *
 * Uses Node's built-in `node:sqlite` (still flagged experimental by Node), so
 * the PoC needs no native build step. This is the only place SQL exists; the
 * core sees `StoragePort` (AGENT.md §3).
 *
 * Idempotency of progress is enforced by the `progress_writes` primary key on
 * (learner, turn, knowledge point) (§6.2). Cross-learner access is impossible
 * by construction: every statement filters on `learner_id` (§6.7).
 */
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { allKnowledgePoints, type ClassRecord } from "../core/domain/knowledge.js";
import type { ProgressDelta, UserProgress } from "../core/domain/progress.js";
import type {
  AppliedDeltas,
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
  channel         TEXT NOT NULL,
  channel_user_id TEXT NOT NULL,
  learner_id      TEXT NOT NULL,
  PRIMARY KEY (channel, channel_user_id)
);

CREATE TABLE IF NOT EXISTS classes (
  learner_id TEXT NOT NULL,
  class_id   TEXT NOT NULL,
  payload    TEXT NOT NULL,
  PRIMARY KEY (learner_id, class_id)
);

CREATE TABLE IF NOT EXISTS progress (
  learner_id          TEXT NOT NULL,
  knowledge_point_id  TEXT NOT NULL,
  times_seen          INTEGER NOT NULL DEFAULT 0,
  times_used          INTEGER NOT NULL DEFAULT 0,
  times_used_with_help INTEGER NOT NULL DEFAULT 0,
  times_wrong         INTEGER NOT NULL DEFAULT 0,
  last_seen_at        TEXT,
  last_wrong_at       TEXT,
  notes               TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (learner_id, knowledge_point_id)
);

CREATE TABLE IF NOT EXISTS progress_writes (
  learner_id         TEXT NOT NULL,
  turn_id            TEXT NOT NULL,
  knowledge_point_id TEXT NOT NULL,
  at                 TEXT NOT NULL,
  PRIMARY KEY (learner_id, turn_id, knowledge_point_id)
);

CREATE TABLE IF NOT EXISTS messages (
  message_id TEXT PRIMARY KEY,
  learner_id TEXT NOT NULL,
  class_id   TEXT NOT NULL,
  role       TEXT NOT NULL,
  content    TEXT NOT NULL,
  at         TEXT NOT NULL,
  turn_id    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS messages_by_learner ON messages (learner_id, class_id, at);

CREATE TABLE IF NOT EXISTS turns (
  learner_id      TEXT NOT NULL,
  turn_id         TEXT NOT NULL,
  class_id        TEXT NOT NULL,
  incoming        TEXT NOT NULL,
  reply           TEXT NOT NULL,
  branch          TEXT NOT NULL,
  target_ids      TEXT NOT NULL,
  steering_reason TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  PRIMARY KEY (learner_id, turn_id)
);

CREATE TABLE IF NOT EXISTS schedules (
  learner_id      TEXT PRIMARY KEY,
  hour_local      INTEGER NOT NULL,
  enabled         INTEGER NOT NULL,
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
    this.#db.exec(SCHEMA);
  }

  close(): void {
    this.#db.close();
  }

  get path(): string {
    return this.#path;
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

  async saveClass(learnerId: string, klass: ClassRecord): Promise<void> {
    if (klass.ownerLearnerId !== null && klass.ownerLearnerId !== learnerId) {
      throw new Error(
        `refusing to write class ${klass.id} owned by ${klass.ownerLearnerId} under learner ${learnerId} (§6.7)`,
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
         times_seen           = times_seen + excluded.times_seen,
         times_used           = times_used + excluded.times_used,
         times_used_with_help = times_used_with_help + excluded.times_used_with_help,
         times_wrong          = times_wrong + excluded.times_wrong,
         last_seen_at         = COALESCE(excluded.last_seen_at, last_seen_at),
         last_wrong_at        = COALESCE(excluded.last_wrong_at, last_wrong_at)`,
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
          // Already counted for this (turn, point) — a replay must not double-count (§6.2).
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
