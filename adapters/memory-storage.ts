/**
 * In-memory storage adapter — design/70-stack.md §5.
 *
 * Runs the whole turn pipeline with no database and no network, which is how we
 * prove the core boundary (design/20-architecture.md §3). Every method is keyed by `learnerId`, so
 * cross-learner access is impossible by construction (design/30-domain-model.md §7).
 */
import { applyDelta, blankProgress, type ProgressDelta, type UserProgress } from "../core/domain/progress.js";
import { allKnowledgePoints, type ClassRecord } from "../core/domain/knowledge.js";
import type { LearnerSettings } from "../core/domain/settings.js";
import { channelLinkKey } from "../core/identity/identity.js";
import type {
 AppliedDeltas,
 AccessRequest,
 ChannelKind,
 ScheduleRecord,
 StoragePort,
 StoredMessage,
 TurnRecord,
} from "../core/ports/storage.js";

export class MemoryStorage implements StoragePort {
 readonly #learners = new Map<string, string>();
 readonly #links = new Map<string, string>();
 readonly #access = new Map<string, AccessRequest>();
 readonly #classes = new Map<string, Map<string, ClassRecord>>();
 readonly #settings = new Map<string, LearnerSettings>();
 readonly #progress = new Map<string, Map<string, UserProgress>>();
 readonly #progressWrites = new Set<string>();
 readonly #messages = new Map<string, StoredMessage[]>();
 readonly #turns = new Map<string, TurnRecord[]>();
 readonly #schedules = new Map<string, ScheduleRecord>();
 #learnerCounter = 0;
 #messageCounter = 0;

 async createLearner(): Promise<string> {
 this.#learnerCounter += 1;
 const learnerId = `lrn_${this.#learnerCounter}`;
 this.#learners.set(learnerId, new Date(0).toISOString());
 return learnerId;
 }

 async findLearnerId(channel: ChannelKind, channelUserId: string): Promise<string | null> {
 return this.#links.get(channelLinkKey(channel, channelUserId)) ?? null;
 }

 async findChannelUserId(learnerId: string, channel: ChannelKind): Promise<string | null> {
 for (const [key, linkedLearnerId] of this.#links) {
 if (linkedLearnerId !== learnerId) {
 continue;
 }
 const separator = key.indexOf(":");
 if (key.slice(0, separator) === channel) {
 return key.slice(separator + 1);
 }
 }
 return null;
 }

 async linkChannel(
 channel: ChannelKind,
 channelUserId: string,
 learnerId: string,
 ): Promise<void> {
 this.#links.set(channelLinkKey(channel, channelUserId), learnerId);
 }

 // --- access approval (design/74-access.md §2–§4) ---
 async requestAccess(
 channel: ChannelKind,
 channelUserId: string,
 displayName: string | null,
 ): Promise<AccessRequest> {
 const key = channelLinkKey(channel, channelUserId);
 const existing = this.#access.get(key);
 if (existing !== undefined) {
 return existing;
 }
 const created: AccessRequest = {
 channel,
 channelUserId,
 status: "pending",
 displayName,
 requestedAt: new Date().toISOString(),
 decidedAt: null,
 learnerId: null,
 };
 this.#access.set(key, created);
 return created;
 }

 async getAccessRequest(
 channel: ChannelKind,
 channelUserId: string,
 ): Promise<AccessRequest | null> {
 return this.#access.get(channelLinkKey(channel, channelUserId)) ?? null;
 }

 async listAccessRequests(): Promise<readonly AccessRequest[]> {
 return [...this.#access.values()];
 }

 async decideAccess(
 channel: ChannelKind,
 channelUserId: string,
 decision: "approved" | "denied",
 ): Promise<AccessRequest | null> {
 const key = channelLinkKey(channel, channelUserId);
 const existing = this.#access.get(key);
 if (existing === undefined) {
 return null;
 }
 let updated: AccessRequest;
 if (decision === "approved") {
 const learnerId = existing.learnerId ?? (await this.createLearner());
 this.#links.set(key, learnerId);
 updated = {
 ...existing,
 status: "approved",
 decidedAt: new Date().toISOString(),
 learnerId,
 };
 } else {
 // Revocation keeps the learner and its progress; only the link goes
 // (design/74-access.md §7).
 this.#links.delete(key);
 updated = { ...existing, status: "denied", decidedAt: new Date().toISOString() };
 }
 this.#access.set(key, updated);
 return updated;
 }

 async isLearnerApproved(learnerId: string): Promise<boolean> {
 return [...this.#links.values()].includes(learnerId);
 }

 async saveClass(learnerId: string, klass: ClassRecord): Promise<void> {
 if (klass.ownerLearnerId !== null && klass.ownerLearnerId !== learnerId) {
 throw new Error(
 `refusing to write class ${klass.id} owned by ${klass.ownerLearnerId} under learner ${learnerId} (design/30-domain-model.md §7)`,
 );
 }
 const owned = this.#classes.get(learnerId) ?? new Map<string, ClassRecord>();
 owned.set(klass.id, klass);
 this.#classes.set(learnerId, owned);
 }

 async getClass(learnerId: string, classId: string): Promise<ClassRecord | null> {
 return this.#classes.get(learnerId)?.get(classId) ?? null;
 }

 async listClasses(learnerId: string): Promise<readonly ClassRecord[]> {
 return [...(this.#classes.get(learnerId)?.values() ?? [])];
 }

 // Settings live in one map keyed by learnerId, so one learner can never read
 // another's row (design/30-domain-model.md §7, §8).
 async getLearnerSettings(learnerId: string): Promise<LearnerSettings | null> {
 return this.#settings.get(learnerId) ?? null;
 }

 async setLearnerSettings(learnerId: string, settings: LearnerSettings): Promise<void> {
 this.#settings.set(learnerId, settings);
 }

 async getProgress(learnerId: string, classId: string): Promise<readonly UserProgress[]> {
 const klass = await this.getClass(learnerId, classId);
 if (klass === null) {
 return [];
 }
 const ids = new Set(allKnowledgePoints(klass).map((point) => point.id));
 const rows = this.#progress.get(learnerId);
 return [...(rows?.values() ?? [])].filter((row) => ids.has(row.knowledgePointId));
 }

 async applyProgressDeltas(
 learnerId: string,
 turnId: string,
 deltas: readonly ProgressDelta[],
 ): Promise<AppliedDeltas> {
 const rows = this.#progress.get(learnerId) ?? new Map<string, UserProgress>();
 this.#progress.set(learnerId, rows);

 const applied: ProgressDelta[] = [];
 const skipped: string[] = [];
 for (const delta of deltas) {
 const writeKey = `${turnId}\u0000${delta.knowledgePointId}`;
 if (this.#progressWrites.has(writeKey)) {
 skipped.push(delta.knowledgePointId);
 continue;
 }
 this.#progressWrites.add(writeKey);
 const current = rows.get(delta.knowledgePointId) ?? blankProgress(learnerId, delta.knowledgePointId);
 rows.set(delta.knowledgePointId, applyDelta(current, delta, ""));
 applied.push(delta);
 }
 return { applied, skipped };
 }

 async appendMessage(learnerId: string, message: Omit<StoredMessage, "id">): Promise<void> {
 this.#messageCounter += 1;
 const list = this.#messages.get(learnerId) ?? [];
 list.push({ ...message, id: `msg_${this.#messageCounter}` });
 this.#messages.set(learnerId, list);
 }

 async recentMessages(
 learnerId: string,
 classId: string,
 limit: number,
 ): Promise<readonly StoredMessage[]> {
 const list = (this.#messages.get(learnerId) ?? []).filter(
 (message) => message.classId === classId,
 );
 return list.slice(Math.max(0, list.length - limit));
 }

 async recordTurn(learnerId: string, turn: TurnRecord): Promise<void> {
 const list = this.#turns.get(learnerId) ?? [];
 list.push(turn);
 this.#turns.set(learnerId, list);
 }

 async getSchedule(learnerId: string): Promise<ScheduleRecord | null> {
 return this.#schedules.get(learnerId) ?? null;
 }

 async setSchedule(learnerId: string, schedule: ScheduleRecord): Promise<void> {
 this.#schedules.set(learnerId, schedule);
 }

 async listSchedules(): Promise<readonly ScheduleRecord[]> {
 return [...this.#schedules.values()];
 }

 // --- test helpers (not part of the port) ---

 turnsOf(learnerId: string): readonly TurnRecord[] {
 return this.#turns.get(learnerId) ?? [];
 }

 learnerCount(): number {
 return this.#learners.size;
 }
}
