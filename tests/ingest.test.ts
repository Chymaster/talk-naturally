/**
 * Class ingestion: stable ids, idempotent re-import, and preservation of
 * progress (design/30-domain-model.md §4, design/70-stack.md §5).
 */
import { describe, expect, it } from "vitest";
import { ClassFitError, fitClass, reconcileClass } from "../core/classes/ingest.js";
import { knowledgePointId } from "../core/classes/canonical.js";
import { MemoryStorage } from "../adapters/memory-storage.js";
import { importClass } from "../hosts/class-import.js";
import { allIds, makeClass, NOW, progressRow, rawFixture } from "./fixtures.js";

describe("fitClass", () => {
 it("derives the same ids from the same material, twice", () => {
 const first = makeClass();
 const second = makeClass();
 expect(allIds(first)).toEqual(allIds(second));
 });

 it("derives ids from content, not from position", () => {
 const reordered = {
 ...rawFixture,
 points: [...rawFixture.points].reverse(),
 };
 const original = fitClass(rawFixture, { ownerLearnerId: "lrn_a", nowIso: NOW });
 const shuffled = fitClass(reordered, { ownerLearnerId: "lrn_a", nowIso: NOW });
 expect(new Set(allIds(shuffled))).toEqual(new Set(allIds(original)));
 });

 it("is insensitive to case and surrounding whitespace in a title", () => {
 expect(knowledgePointId("vocab", " der BUS ", "German")).toBe(
 knowledgePointId("vocab", "der bus", "german"),
 );
 });

 it("does not split progress between the same point listed twice", () => {
 const duplicated = {
 ...rawFixture,
 points: [...rawFixture.points, { ...rawFixture.points[1]! }],
 };
 const klass = fitClass(duplicated, { ownerLearnerId: "lrn_a", nowIso: NOW });
 expect(allIds(klass)).toHaveLength(rawFixture.points.length);
 });

 it("surfaces a bad fit as a typed error, not a crash", () => {
 const malformed = {
 ...rawFixture,
 points: [{ kind: "nonsense", title: "x" }],
 } as unknown as typeof rawFixture;
 expect(() => fitClass(malformed, { ownerLearnerId: null, nowIso: NOW })).toThrow(ClassFitError);
 });
});

describe("reconcileClass", () => {
 it("adds new points, retires removed ones, and never reassigns an id", () => {
 const existing = makeClass();
 const trimmed = fitClass(
 { ...rawFixture, points: rawFixture.points.slice(0, 3) },
 { ownerLearnerId: "lrn_a", nowIso: NOW },
 );
 const added = fitClass(
 {
 ...rawFixture,
 points: [...rawFixture.points, { kind: "vocab", title: "der Zug", detail: "train", raw_source: "t5" }],
 },
 { ownerLearnerId: "lrn_a", nowIso: NOW },
 );

 const removed = reconcileClass(existing, trimmed, NOW);
 expect(removed.summary.retired).toBe(1);
 expect(removed.summary.added).toBe(0);
 const retired = [...removed.klass.grammar, ...removed.klass.sentenceStructure, ...removed.klass.vocab].filter(
 (point) => point.retiredAt !== null,
 );
 expect(retired).toHaveLength(1);
 // Progress rows reference the retired point, so it still exists.
 expect(allIds(removed.klass)).toHaveLength(4);

 const extended = reconcileClass(existing, added, NOW);
 expect(extended.summary.added).toBe(1);
 expect(extended.summary.unchanged).toBe(4);
 });

 it("revives a point that comes back instead of duplicating it", () => {
 const existing = makeClass();
 const trimmed = fitClass(
 { ...rawFixture, points: rawFixture.points.slice(0, 3) },
 { ownerLearnerId: "lrn_a", nowIso: NOW },
 );
 const { klass: afterRemoval } = reconcileClass(existing, trimmed, NOW);
 const { klass: afterReturn, summary } = reconcileClass(afterRemoval, existing, NOW);
 expect(summary.revived).toBe(1);
 expect(allIds(afterReturn)).toHaveLength(4);
 expect(new Set(allIds(afterReturn))).toEqual(new Set(allIds(existing)));
 });
});

describe("importClass over storage", () => {
 it("preserves progress across a re-import (ingest twice → no duplicates)", async () => {
 const storage = new MemoryStorage();
 const learnerId = await storage.createLearner();

 const first = await importClass(storage, learnerId, rawFixture, NOW);
 const [grammarId] = allIds(first.klass) as [string, string, string, string];

 await storage.applyProgressDeltas(learnerId, "turn-1", [
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

 const second = await importClass(storage, learnerId, rawFixture, NOW);
 expect(second.reimport).toBe(true);
 expect(second.added).toBe(0);
 expect(second.retired).toBe(0);
 expect(second.pointCount).toBe(4);

 const stored = await storage.getClass(learnerId, first.klass.id);
 expect(stored).not.toBeNull();
 expect(allIds(stored!)).toHaveLength(4);

 const progress = await storage.getProgress(learnerId, first.klass.id);
 expect(progress.find((row) => row.knowledgePointId === grammarId)?.timesUsed).toBe(1);
 });

 it("keeps the learner's existing counters when material disappears and returns", async () => {
 const storage = new MemoryStorage();
 const learnerId = await storage.createLearner();
 const first = await importClass(storage, learnerId, rawFixture, NOW);
 const [grammarId] = allIds(first.klass) as [string, string, string, string];
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

 await importClass(storage, learnerId, { ...rawFixture, points: rawFixture.points.slice(1) }, NOW);
 await importClass(storage, learnerId, rawFixture, NOW);

 const progress = await storage.getProgress(learnerId, first.klass.id);
 expect(progress.find((row) => row.knowledgePointId === grammarId)?.timesSeen).toBe(1);
 });
});
