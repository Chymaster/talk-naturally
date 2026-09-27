/**
 * Steering is unit-tested in isolation with hand-built progress states — it is
 * the logic that decides what the product actually teaches (design/70-stack.md §5).
 */
import { describe, expect, it } from "vitest";
import { deriveProgress } from "../core/progress/derive.js";
import { selectTargets } from "../core/steering/select-targets.js";
import { allIds, makeClass, makeLevelClass, NOW, progressRow } from "./fixtures.js";

const klass = makeClass();
// allIds() order is grammar, then sentence structure, then vocab.
const [grammarId, structureId, busId, bahnId] = allIds(klass) as [
 string,
 string,
 string,
 string,
];

describe("deriveProgress", () => {
 it("treats a never-seen point as unattempted and due", () => {
 const derived = deriveProgress(progressRow(grammarId), NOW);
 expect(derived.unattempted).toBe(true);
 expect(derived.due).toBe(true);
 expect(derived.consolidating).toBe(false);
 });

 it("makes a point due again after the spacing window", () => {
 const recent = progressRow(busId, { timesSeen: 1, lastSeenAt: "2026-09-25T08:00:00.000Z" });
 const old = progressRow(busId, { timesSeen: 1, lastSeenAt: "2026-09-20T08:00:00.000Z" });
 expect(deriveProgress(recent, NOW).due).toBe(false);
 expect(deriveProgress(old, NOW).due).toBe(true);
 });

 it("counts wrong and helped attempts as struggle", () => {
 const derived = deriveProgress(
 progressRow(busId, { timesSeen: 3, timesWrong: 1, timesUsedWithHelp: 2 }),
 NOW,
 );
 expect(derived.struggle).toBe(3);
 });

 it("flags seen-but-never-produced as consolidating", () => {
 const derived = deriveProgress(
 progressRow(busId, { timesSeen: 2, timesUsed: 0, lastSeenAt: "2026-09-25T08:00:00.000Z" }),
 NOW,
 );
 expect(derived.consolidating).toBe(true);
 expect(derived.unattempted).toBe(false);
 });
});

describe("selectTargets", () => {
 it("ranks every point of an empty class with a reason", () => {
 const result = selectTargets({ klass, progress: [], nowIso: NOW });
 expect(result.considered).toBe(4);
 expect(result.targets).toHaveLength(4);
 for (const target of result.targets) {
 expect(target.reasons.join(",")).toContain("new");
 }
 });

 it("is deterministic: identical input yields identical order", () => {
 const first = selectTargets({ klass, progress: [], nowIso: NOW });
 const second = selectTargets({ klass, progress: [], nowIso: NOW });
 expect(first.targets.map((target) => target.point.id)).toEqual(
 second.targets.map((target) => target.point.id),
 );
 });

 it("puts a struggling point ahead of an unattempted one", () => {
 const progress = [
 progressRow(grammarId, {
 timesSeen: 2,
 timesUsed: 0,
 timesWrong: 2,
 lastSeenAt: "2026-09-25T08:00:00.000Z",
 }),
 ];
 const result = selectTargets({ klass, progress, nowIso: NOW });
 expect(result.targets[0]?.point.id).toBe(grammarId);
 expect(result.targets[0]?.reasons.join(",")).toContain("struggle");
 });

 it("sinks a recently consolidated point below everything else", () => {
 const progress = [
 progressRow(grammarId, { timesSeen: 4, timesUsed: 3, lastSeenAt: "2026-09-25T08:00:00.000Z" }),
 progressRow(busId, { timesSeen: 4, timesUsed: 3, lastSeenAt: "2026-09-25T08:00:00.000Z" }),
 progressRow(bahnId, { timesSeen: 4, timesUsed: 3, lastSeenAt: "2026-09-25T08:00:00.000Z" }),
 ];
 const result = selectTargets({ klass, progress, nowIso: NOW });
 expect(result.targets[0]?.point.id).toBe(structureId);
 });

 it("respects the target limit and explains the choice in one line", () => {
 const result = selectTargets({ klass, progress: [], nowIso: NOW, limit: 2 });
 expect(result.targets).toHaveLength(2);
 expect(result.summary).toContain("selected 2/4");
 expect(result.summary).toContain("because");
 });

 it("excludes retired knowledge points", () => {
 const retired = makeClass();
 const withRetired = {
 ...retired,
 vocab: retired.vocab.map((point, index) =>
 index === 0 ? { ...point, retiredAt: NOW } : point,
 ),
 };
 const result = selectTargets({ klass: withRetired, progress: [], nowIso: NOW });
 expect(result.considered).toBe(3);
 expect(result.targets.map((target) => target.point.id)).not.toContain(busId);
 });

 it("breaks a score tie on unitOrder ascending, not id order", () => {
 // The declared unit order fixes unitOrder (index + 1), independent of title.
 const forward = makeLevelClass({ level: "A1", units: ["Kapitel 9", "Kapitel 1"] });
 const backward = makeLevelClass({ level: "A1", units: ["Kapitel 1", "Kapitel 9"] });

 const firstForward = selectTargets({ klass: forward, progress: [], nowIso: NOW }).targets[0];
 const firstBackward = selectTargets({ klass: backward, progress: [], nowIso: NOW }).targets[0];

 // Both points are unseen and tie at the same score; unitOrder 1 wins.
 expect(firstForward?.point.unitOrder).toBe(1);
 expect(firstForward?.point.title).toBe("Kapitel 9");
 expect(firstBackward?.point.unitOrder).toBe(1);
 expect(firstBackward?.point.title).toBe("Kapitel 1");
 expect(firstForward?.score).toBe(firstBackward?.score);
 });
});
