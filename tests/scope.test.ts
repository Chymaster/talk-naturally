/**
 * Cross-level scope and ranking, unit-tested in isolation with hand-built
 * settings and progress (design/40-steering.md §2–4, design/70-stack.md §5).
 *
 * Two fitted level classes share a unit label, so that knowledge point has one
 * id in both levels — the review item carried from A1 into A2
 * (design/30-domain-model.md §5).
 */
import { describe, expect, it } from "vitest";
import { allKnowledgePoints, type ClassRecord, type KnowledgePoint } from "../core/domain/knowledge.js";
import { selectTargets } from "../core/steering/select-targets.js";
import { resolveScope, singleClassScope } from "../core/steering/scope.js";
import { makeClass, makeLevelClass, NOW, progressRow } from "./fixtures.js";

const a1 = makeLevelClass({ level: "A1", units: ["Kapitel 1", "Kapitel 2"] });
const a2 = makeLevelClass({ level: "A2", units: ["Kapitel 1", "Kapitel 3", "Kapitel 4"] });

function pointOf(klass: ClassRecord, title: string): KnowledgePoint {
 const found = allKnowledgePoints(klass).find((point) => point.title === title);
 if (found === undefined) {
 throw new Error(`fixture class has no point titled ${title}`);
 }
 return found;
}

describe("resolveScope", () => {
 it("keeps one candidate per knowledge-point id when two levels share a point", () => {
 const sharedId = pointOf(a1, "Kapitel 1").id;
 expect(pointOf(a2, "Kapitel 1").id).toBe(sharedId);

 const scope = resolveScope([
 { klass: a2, primary: true, knownThroughUnit: 2 },
 { klass: a1, primary: false, knownThroughUnit: 0 },
 ]);

 const copies = scope.candidates.filter((candidate) => candidate.point.id === sharedId);
 expect(copies).toHaveLength(1);
 // The primary copy wins, so its cursor decides teachability.
 expect(copies[0]?.primary).toBe(true);
 expect(copies[0]?.teachable).toBe(false);
 });

 it("ranks the deduped point once, from its single counter set", () => {
 const sharedId = pointOf(a1, "Kapitel 1").id;
 const scope = resolveScope([
 { klass: a2, primary: true, knownThroughUnit: 2 },
 { klass: a1, primary: false, knownThroughUnit: 0 },
 ]);

 const result = selectTargets({
 scope,
 progress: [
 progressRow(sharedId, {
 timesSeen: 2,
 timesWrong: 1,
 lastSeenAt: "2026-09-25T08:30:00.000Z",
 }),
 ],
 nowIso: NOW,
 });

 // A2 contributes three points; A1 contributes only its non-shared Kapitel 2.
 expect(result.considered).toBe(4);
 const ranked = result.targets.filter((target) => target.point.id === sharedId);
 expect(ranked).toHaveLength(1);
 // struggle 2×1 + consolidating 1 = 3, from the one row. Not due (seen 30 min ago).
 expect(ranked[0]?.score).toBe(3);
 expect(ranked[0]?.reasons.join(",")).toContain("struggle(1)");
 });
});

describe("new material and the chapter cursor", () => {
 it("scores below-cursor unseen points as background and at-or-above as new/due", () => {
 const scope = resolveScope([{ klass: a2, primary: true, knownThroughUnit: 2 }]);
 const result = selectTargets({ scope, progress: [], nowIso: NOW });

 const below = result.targets.find((target) => target.point.title === "Kapitel 1");
 expect(below?.teachable).toBe(false);
 expect(below?.score).toBe(0);
 expect(below?.reasons).toEqual(["background(not being taught yet)"]);

 for (const title of ["Kapitel 3", "Kapitel 4"]) {
 const target = result.targets.find((candidate) => candidate.point.title === title);
 expect(target?.teachable).toBe(true);
 expect(target?.score).toBe(4);
 expect(target?.reasons).toContain("due(never seen)");
 expect(target?.reasons).toContain("new");
 }
 });

 it("breaks a score tie by unitOrder ascending", () => {
 const result = selectTargets({
 scope: singleClassScope(a2),
 progress: [],
 nowIso: NOW,
 });

 expect(result.targets.map((target) => target.point.title)).toEqual([
 "Kapitel 1",
 "Kapitel 3",
 "Kapitel 4",
 ]);
 const orders = result.targets.map((target) => target.point.unitOrder);
 expect(orders).toEqual([...orders].sort((left, right) => left - right));
 });
});

describe("included previous levels", () => {
 it("ranks a seen included-level point by its counters above unseen background", () => {
 const scope = resolveScope([
 { klass: a2, primary: true, knownThroughUnit: 2 },
 { klass: a1, primary: false, knownThroughUnit: 0 },
 ]);
 const included = pointOf(a1, "Kapitel 2");
 const backgroundId = pointOf(a2, "Kapitel 1").id;

 // Unseen included material is background: visible, but scored zero.
 const before = selectTargets({ scope, progress: [], nowIso: NOW });
 const unseen = before.targets.find((target) => target.point.id === included.id);
 expect(unseen?.teachable).toBe(false);
 expect(unseen?.score).toBe(0);
 expect(unseen?.reasons).toContain("background(not being taught yet)");

 // As soon as a counter exists it ranks normally, on its own counters.
 const after = selectTargets({
 scope,
 progress: [
 progressRow(included.id, {
 timesSeen: 2,
 timesWrong: 1,
 lastSeenAt: "2026-09-25T08:30:00.000Z",
 }),
 ],
 nowIso: NOW,
 });
 const seen = after.targets.find((target) => target.point.id === included.id);
 const background = after.targets.find((target) => target.point.id === backgroundId);
 expect(seen?.score).toBe(3);
 expect(seen?.reasons.join(",")).toContain("struggle");
 expect(background?.score).toBe(0);
 expect(seen?.score).toBeGreaterThan(background?.score ?? -1);
 });
});

describe("legacy single-class input", () => {
 it("treats every point as teachable at unitOrder 0", () => {
 const legacy = makeClass();
 const result = selectTargets({ klass: legacy, progress: [], nowIso: NOW });

 expect(result.considered).toBe(4);
 expect(result.targets).toHaveLength(4);
 for (const target of result.targets) {
 expect(target.teachable).toBe(true);
 expect(target.primary).toBe(true);
 expect(target.point.unitOrder).toBe(0);
 }
 });
});
