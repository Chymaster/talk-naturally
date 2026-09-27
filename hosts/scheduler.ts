/**
 * Session scheduler — design/50-orchestration.md §2.
 *
 * A session is started by the scheduler, not only by the learner. The decision
 * is a pure function of the stored schedule so it can be reasoned about and
 * tested without a timer.
 */
import { isOnboarded } from "../core/domain/settings.js";
import type { ClockPort } from "../core/ports/config.js";
import type { ScheduleRecord, StoragePort } from "../core/ports/storage.js";
import type { ConversationEngine, EngineLogger } from "../engine/types.js";

/** Same calendar day, server local time. */
function sameLocalDay(left: Date, right: Date): boolean {
 return left.toDateString() === right.toDateString();
}

/**
 * Due when the schedule is enabled, the hour matches, and no session has already
 * started today. A learner-chosen cadence is respected because the hour comes
 * from the learner's own schedule record (design/50-orchestration.md §2).
 */
export function isSessionDue(schedule: ScheduleRecord, now: Date): boolean {
 if (!schedule.enabled) {
 return false;
 }
 if (now.getHours() !== schedule.hourLocal) {
 return false;
 }
 if (schedule.lastSessionAt === null) {
 return true;
 }
 const last = new Date(schedule.lastSessionAt);
 if (Number.isNaN(last.getTime())) {
 return true;
 }
 return !sameLocalDay(last, now);
}

export interface SchedulerDeps {
 readonly storage: StoragePort;
 readonly engine: ConversationEngine;
 readonly clock: ClockPort;
 readonly send: (learnerId: string, text: string) => Promise<boolean>;
 readonly logger?: EngineLogger;
 /** How often to check. Defaults to one minute. */
 readonly tickMs?: number;
}

export interface Scheduler {
 stop(): void;
 /** Exposed for tests and for a manual tick. Returns how many sessions started. */
 runOnce(now?: Date): Promise<number>;
}

export function startScheduler(deps: SchedulerDeps): Scheduler {
 const { storage, engine, clock, send, logger } = deps;

 async function runOnce(now: Date = clock.now()): Promise<number> {
 let started = 0;
 for (const schedule of await storage.listSchedules()) {
 if (!isSessionDue(schedule, now)) {
 continue;
 }
 // A session never opens before onboarding completes (design/60-ingestion.md §3):
 // onboarding is the only entry point until a level resolves to a class.
 const settings = await storage.getLearnerSettings(schedule.learnerId);
 if (!isOnboarded(settings)) {
 logger?.({
 event: "scheduler.skipped_unonboarded",
 learnerId: schedule.learnerId,
 });
 continue;
 }
 const outcome = await engine.startSession({
 learnerId: schedule.learnerId,
 channel: "scheduler",
 });
 if (outcome.handledAs === "opened") {
 started += 1;
 await send(schedule.learnerId, outcome.reply);
 logger?.({ event: "scheduler.session_started", learnerId: schedule.learnerId });
 }
 }
 return started;
 }

 const timer = setInterval(() => {
 void runOnce().catch((error: unknown) => {
 logger?.({
 event: "scheduler.tick_failed",
 message: error instanceof Error ? error.message : String(error),
 });
 });
 }, deps.tickMs ?? 60_000);

 return {
 stop(): void {
 clearInterval(timer);
 },
 runOnce,
 };
}
