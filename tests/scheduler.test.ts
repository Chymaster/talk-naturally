/**
 * The scheduler decides whether a session starts; that decision is a pure
 * function and is tested without a timer (design/70-stack.md §5, design/50-orchestration.md §2).
 * A session never opens before onboarding completes (design/60-ingestion.md §3).
 */
import { describe, expect, it } from "vitest";
import { MemoryStorage } from "../adapters/memory-storage.js";
import { createScriptedModel } from "../adapters/fake-model.js";
import { StaticModelResolver } from "../adapters/model-resolver.js";
import { SequentialIdPort } from "../adapters/random-ids.js";
import { FixedClock } from "../adapters/system-clock.js";
import { blankSettings, type LearnerSettings } from "../core/domain/settings.js";
import { createEngine } from "../engine/index.js";
import { importClass } from "../hosts/class-import.js";
import { isSessionDue, startScheduler } from "../hosts/scheduler.js";
import { NOW, rawFixture } from "./fixtures.js";

function schedule(overrides: Partial<Parameters<typeof isSessionDue>[0]> = {}) {
 return { learnerId: "lrn_a", hourLocal: 9, enabled: true, lastSessionAt: null, ...overrides };
}

/** A learner whose onboarding is complete, with one imported class (design/60-ingestion.md §3). */
async function onboardedLearner(storage: MemoryStorage): Promise<string> {
 const learnerId = await storage.createLearner();
 const imported = await importClass(storage, learnerId, rawFixture, NOW);
 const settings: LearnerSettings = {
 ...blankSettings(learnerId),
 targetLanguage: "German",
 level: "A1",
 classId: imported.klass.id,
 onboardingStep: "done",
 updatedAt: NOW,
 };
 await storage.setLearnerSettings(learnerId, settings);
 return learnerId;
}

function fixedEngine(storage: MemoryStorage, outputs: readonly unknown[]) {
 return createEngine({
 storage,
 models: new StaticModelResolver(createScriptedModel(outputs)),
 clock: new FixedClock(NOW),
 ids: new SequentialIdPort("turn"),
 });
}

describe("isSessionDue", () => {
 it("is due at the learner's chosen hour when no session has run", () => {
 expect(isSessionDue(schedule(), new Date("2026-09-25T09:05:00"))).toBe(true);
 });

 it("is not due outside the chosen hour", () => {
 expect(isSessionDue(schedule(), new Date("2026-09-25T10:00:00"))).toBe(false);
 expect(isSessionDue(schedule({ hourLocal: 20 }), new Date("2026-09-25T09:00:00"))).toBe(false);
 });

 it("is not due when the learner disabled it", () => {
 expect(isSessionDue(schedule({ enabled: false }), new Date("2026-09-25T09:00:00"))).toBe(false);
 });

 it("fires at most once per day", () => {
 const alreadyToday = schedule({ lastSessionAt: "2026-09-25T09:02:00" });
 const yesterday = schedule({ lastSessionAt: "2026-09-24T09:02:00" });
 expect(isSessionDue(alreadyToday, new Date("2026-09-25T09:30:00"))).toBe(false);
 expect(isSessionDue(yesterday, new Date("2026-09-25T09:30:00"))).toBe(true);
 });
});

describe("startScheduler.runOnce", () => {
 it("skips a learner who has not onboarded", async () => {
 const storage = new MemoryStorage();
 const learnerId = await storage.createLearner();
 await storage.setLearnerSettings(learnerId, blankSettings(learnerId));
 const now = new Date(NOW);
 await storage.setSchedule(learnerId, {
 learnerId,
 hourLocal: now.getHours(),
 enabled: true,
 lastSessionAt: null,
 });

 const engine = fixedEngine(storage, [{ reply: "should not be sent" }]);
 const delivered: string[] = [];
 const scheduler = startScheduler({
 storage,
 engine,
 clock: new FixedClock(NOW),
 send: async (_learnerId, text) => {
 delivered.push(text);
 return true;
 },
 });

 const started = await scheduler.runOnce(now);
 scheduler.stop();

 expect(started).toBe(0);
 expect(delivered).toEqual([]);
 // The day is not consumed: the session can still open once onboarding completes.
 const record = await storage.getSchedule(learnerId);
 expect(record?.lastSessionAt).toBeNull();
 });

 it("opens for an onboarded learner, delivers it, and does not repeat on the next tick", async () => {
 const storage = new MemoryStorage();
 const learnerId = await onboardedLearner(storage);
 // Use the local hour of the fixed instant so the test is timezone-independent.
 const now = new Date(NOW);
 await storage.setSchedule(learnerId, {
 learnerId,
 hourLocal: now.getHours(),
 enabled: true,
 lastSessionAt: null,
 });

 const engine = fixedEngine(storage, [{ reply: "Hallo! Womit fährst du?" }]);
 const delivered: string[] = [];
 const scheduler = startScheduler({
 storage,
 engine,
 clock: new FixedClock(NOW),
 send: async (_learnerId, text) => {
 delivered.push(text);
 return true;
 },
 });

 const first = await scheduler.runOnce(now);
 const second = await scheduler.runOnce(now);
 scheduler.stop();

 expect(first).toBe(1);
 expect(second).toBe(0);
 expect(delivered).toEqual(["Hallo! Womit fährst du?"]);

 const record = await storage.getSchedule(learnerId);
 expect(record?.lastSessionAt).not.toBeNull();
 });
});
