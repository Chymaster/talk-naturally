/**
 * Storage port — AGENT.md §3, §6.7.
 *
 * Every method takes the `learnerId` as a required first argument, so a
 * forgotten filter fails loudly instead of leaking another learner's rows
 * (§6.7 "impossible by construction"). The core talks only to this interface;
 * a driver (a database, or an in-memory map) implements it outside the core.
 */
import type { ClassRecord } from "../domain/knowledge.js";
import type { ProgressDelta, UserProgress } from "../domain/progress.js";

/**
 * A channel label, opaque to the core (AGENT.md §3).
 *
 * Intentionally `string`: the concrete channel list lives in the frontends, so
 * adding a channel never touches the domain. A channel identity is a credential,
 * not a password (§6.7).
 */
export type ChannelKind = string;

export interface StoredMessage {
  readonly id: string;
  readonly learnerId: string;
  readonly classId: string;
  readonly role: "learner" | "agent";
  readonly content: string;
  readonly at: string;
  readonly turnId: string;
}

export interface TurnRecord {
  readonly turnId: string;
  readonly learnerId: string;
  readonly classId: string;
  readonly incoming: string;
  readonly reply: string;
  readonly branch: string;
  readonly targetIds: readonly string[];
  /** Why these targets were selected — must be answerable from a log line (§6.3). */
  readonly steeringReason: string;
  readonly createdAt: string;
}

export interface ScheduleRecord {
  readonly learnerId: string;
  /** Hour of day, server local time. */
  readonly hourLocal: number;
  readonly enabled: boolean;
  readonly lastSessionAt: string | null;
}

/**
 * Result of an idempotent progress write. `applied` is empty when the same
 * (turn, knowledge point) pair was already counted (§6.2).
 */
export interface AppliedDeltas {
  readonly applied: readonly ProgressDelta[];
  readonly skipped: readonly string[];
}

export interface StoragePort {
  // --- identity and channel links (§6.6) ---
  createLearner(): Promise<string>;
  findLearnerId(channel: ChannelKind, channelUserId: string): Promise<string | null>;
  /** Reverse lookup, used by the server to deliver a scheduler-started session. */
  findChannelUserId(learnerId: string, channel: ChannelKind): Promise<string | null>;
  linkChannel(
    channel: ChannelKind,
    channelUserId: string,
    learnerId: string,
  ): Promise<void>;

  // --- classes (§6.1) ---
  /** Insert or reconcile a class for its owner. Progress for stable ids is untouched (§6.4). */
  saveClass(learnerId: string, klass: ClassRecord): Promise<void>;
  getClass(learnerId: string, classId: string): Promise<ClassRecord | null>;
  listClasses(learnerId: string): Promise<readonly ClassRecord[]>;

  // --- progress (§6.1, §6.2) ---
  getProgress(learnerId: string, classId: string): Promise<readonly UserProgress[]>;
  /** Idempotent per (learner, turn, knowledge point). */
  applyProgressDeltas(
    learnerId: string,
    turnId: string,
    deltas: readonly ProgressDelta[],
  ): Promise<AppliedDeltas>;

  // --- conversation (§18.1) ---
  appendMessage(
    learnerId: string,
    message: Omit<StoredMessage, "id">,
  ): Promise<void>;
  recentMessages(
    learnerId: string,
    classId: string,
    limit: number,
  ): Promise<readonly StoredMessage[]>;
  recordTurn(learnerId: string, turn: TurnRecord): Promise<void>;

  // --- schedule (§18.1) ---
  getSchedule(learnerId: string): Promise<ScheduleRecord | null>;
  setSchedule(learnerId: string, schedule: ScheduleRecord): Promise<void>;
  listSchedules(): Promise<readonly ScheduleRecord[]>;
}
