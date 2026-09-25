/**
 * The scheduler decides whether a session starts; that decision is a pure
 * function and is tested without a timer (AGENT.md §11, §18.1).
 */
import { describe, expect, it } from "vitest";
import { isSessionDue, startScheduler } from "../hosts/scheduler.js";
import { MemoryStorage } from "../adapters/memory-storage.js";
import { FixedClock } from "../adapters/system-clock.js";
import { SequentialIdPort } from "../adapters/random-ids.js";
import { StaticModelResolver } from "../adapters/model-resolver.js";
import { createScriptedModel } from "../adapters/fake-model.js";
import { createEngine } from "../engine/index.js";
import { importClass } from "../hosts/class-import.js";
import { NOW, rawFixture } from "./fixtures.js";

function schedule(overrides: Partial<Parameters<typeof isSessionDue>[0]> = {}) {
  return { learnerId: "lrn_a", hourLocal: 9, enabled: true, lastSessionAt: null, ...overrides };
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
  it("starts a session, delivers it, and does not repeat on the next tick", async () => {
    const storage = new MemoryStorage();
    const learnerId = await storage.createLearner();
    const imported = await importClass(storage, learnerId, rawFixture, NOW);
    // Use the local hour of the fixed instant so the test is timezone-independent.
    const now = new Date(NOW);
    await storage.setSchedule(learnerId, {
      learnerId,
      hourLocal: now.getHours(),
      enabled: true,
      lastSessionAt: null,
    });

    const engine = createEngine({
      storage,
      models: new StaticModelResolver(
        createScriptedModel([{ reply: "Hallo! Womit fährst du?" }]),
      ),
      clock: new FixedClock(NOW),
      ids: new SequentialIdPort("turn"),
    });

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

    const schedule = await storage.getSchedule(learnerId);
    expect(schedule?.lastSessionAt).not.toBeNull();
    expect(imported.klass.id).toBeTruthy();
  });
});
