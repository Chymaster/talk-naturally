/**
 * Storage port — design/20-architecture.md §2, design/30-domain-model.md §7.
 *
 * Every method takes the `learnerId` as a required first argument, so a
 * forgotten filter fails loudly instead of leaking another learner's rows
 * (design/30-domain-model.md §7 "impossible by construction"). The core talks only to this interface;
 * a driver (a database, or an in-memory map) implements it outside the core.
 */
import type { ClassRecord } from "../domain/knowledge.js";
import type { ProgressDelta, UserProgress } from "../domain/progress.js";
import type { LearnerSettings } from "../domain/settings.js";

/**
 * A channel label, opaque to the core (design/20-architecture.md §2).
 *
 * Intentionally `string`: the concrete channel list lives in the frontends, so
 * adding a channel never touches the domain. A channel identity is a credential,
 * not a password (design/30-domain-model.md §7).
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
 /** Why these targets were selected — must be answerable from a log line (40-steering). */
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
 * (turn, knowledge point) pair was already counted (design/30-domain-model.md §2).
 */
export interface AppliedDeltas {
 readonly applied: readonly ProgressDelta[];
 readonly skipped: readonly string[];
}

/**
 * Whether a channel identity may reach the engine (design/74-access.md §2).
 * `denied` covers both a declined request and a later revocation.
 */
export type AccessStatus = "pending" | "approved" | "denied";

/**
 * One channel identity's access request (design/74-access.md §2). The record is
 * keyed by (channel, channelUserId) and exists before any learner does, so a
 * scanner that finds the bot cannot create learner rows.
 */
export interface AccessRequest {
 readonly channel: ChannelKind;
 readonly channelUserId: string;
 readonly status: AccessStatus;
 /**
  * A mutable label for the human operator deciding access. It is never identity,
  * never a key, and never used for access control (design/74-access.md §6).
  */
 readonly displayName: string | null;
 readonly requestedAt: string;
 readonly decidedAt: string | null;
 /** Set on approval; kept across a revoke so re-approval restores the learner. */
 readonly learnerId: string | null;
}

export interface StoragePort {
 // --- identity and channel links (design/30-domain-model.md §6) ---
 createLearner(): Promise<string>;
 findLearnerId(channel: ChannelKind, channelUserId: string): Promise<string | null>;
 /** Reverse lookup, used by the server to deliver a scheduler-started session. */
 findChannelUserId(learnerId: string, channel: ChannelKind): Promise<string | null>;
 linkChannel(
 channel: ChannelKind,
 channelUserId: string,
 learnerId: string,
 ): Promise<void>;

 // --- access approval (design/74-access.md §2–§4) ---
 /** Create the pending request on first contact; an existing request is returned unchanged. */
 requestAccess(
 channel: ChannelKind,
 channelUserId: string,
 displayName: string | null,
 ): Promise<AccessRequest>;
 getAccessRequest(channel: ChannelKind, channelUserId: string): Promise<AccessRequest | null>;
 /** Every known identity, whatever its status; the admin host renders this. */
 listAccessRequests(): Promise<readonly AccessRequest[]>;
 /**
  * Approve or deny. Approving creates and links a learner when none exists, and
  * reuses the learner kept on a revoked record; denying drops the channel link
  * but keeps the learner and its progress (design/74-access.md §2, §7).
  * Returns null when no request exists for the identity.
  */
 decideAccess(
 channel: ChannelKind,
 channelUserId: string,
 decision: "approved" | "denied",
 ): Promise<AccessRequest | null>;
 /**
  * True while the learner has an approved channel link. The engine guard reads
  * this before any workflow runs (design/74-access.md §5).
  */
 isLearnerApproved(learnerId: string): Promise<boolean>;

 // --- classes (design/30-domain-model.md §1) ---
 /** Insert or reconcile a class for its owner. Progress for stable ids is untouched (design/30-domain-model.md §4). */
 saveClass(learnerId: string, klass: ClassRecord): Promise<void>;
 getClass(learnerId: string, classId: string): Promise<ClassRecord | null>;
 listClasses(learnerId: string): Promise<readonly ClassRecord[]>;

 // --- learner settings (design/30-domain-model.md §8) ---
 getLearnerSettings(learnerId: string): Promise<LearnerSettings | null>;
 setLearnerSettings(learnerId: string, settings: LearnerSettings): Promise<void>;

 // --- progress (design/30-domain-model.md §1, design/30-domain-model.md §2) ---
 getProgress(learnerId: string, classId: string): Promise<readonly UserProgress[]>;
 /** Idempotent per (learner, turn, knowledge point). */
 applyProgressDeltas(
 learnerId: string,
 turnId: string,
 deltas: readonly ProgressDelta[],
 ): Promise<AppliedDeltas>;

 // --- conversation (design/50-orchestration.md §2) ---
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

 // --- schedule (design/50-orchestration.md §2) ---
 getSchedule(learnerId: string): Promise<ScheduleRecord | null>;
 setSchedule(learnerId: string, schedule: ScheduleRecord): Promise<void>;
 listSchedules(): Promise<readonly ScheduleRecord[]>;
}
