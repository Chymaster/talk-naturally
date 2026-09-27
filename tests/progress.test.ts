/**
 * The mapping from a structured turn decision to counters lives in one place and
 * is tested here (design/30-domain-model.md §2).
 */
import { describe, expect, it } from "vitest";
import { mapTurnDecisionToDeltas } from "../core/progress/apply.js";
import {
 answerResultSchema,
 continuationResultSchema,
 pendingQuestionOf,
 turnDecisionSchema,
} from "../core/domain/turn.js";
import { allIds, makeClass, NOW } from "./fixtures.js";

const klass = makeClass();
// allIds() order is grammar, then sentence structure, then vocab.
const [grammarId, structureId] = allIds(klass) as [string, string, string, string];

function result(signals: unknown): ReturnType<typeof turnDecisionSchema.parse> {
 return turnDecisionSchema.parse({
 branch: "attempt_judged",
 corrections: [],
 signals,
 });
}

describe("mapTurnDecisionToDeltas", () => {
 it("counts an independent production as used and seen", () => {
 const mapped = mapTurnDecisionToDeltas(
 result([{ knowledge_point_id: grammarId, outcome: "used", evidence: "x" }]),
 [grammarId, structureId],
 NOW,
 );
 expect(mapped.deltas).toHaveLength(1);
 expect(mapped.deltas[0]).toMatchObject({
 knowledgePointId: grammarId,
 seen: 1,
 used: 1,
 usedWithHelp: 0,
 wrong: 0,
 lastSeenAt: NOW,
 lastWrongAt: null,
 });
 expect(mapped.unattributed).toHaveLength(0);
 });

 it("lets a wrong judgement win over a contradictory used signal", () => {
 const mapped = mapTurnDecisionToDeltas(
 result([
 { knowledge_point_id: grammarId, outcome: "used", evidence: "x" },
 { knowledge_point_id: grammarId, outcome: "wrong", evidence: "y" },
 ]),
 [grammarId],
 NOW,
 );
 expect(mapped.deltas[0]).toMatchObject({ wrong: 1, used: 0, usedWithHelp: 0 });
 expect(mapped.deltas[0]?.lastWrongAt).toBe(NOW);
 });

 it("collapses repeated signals for one point into one increment per counter", () => {
 const mapped = mapTurnDecisionToDeltas(
 result([
 { knowledge_point_id: structureId, outcome: "used", evidence: "a" },
 { knowledge_point_id: structureId, outcome: "used", evidence: "b" },
 { knowledge_point_id: structureId, outcome: "used", evidence: "c" },
 ]),
 [structureId],
 NOW,
 );
 expect(mapped.deltas).toHaveLength(1);
 expect(mapped.deltas[0]).toMatchObject({ used: 1, seen: 1 });
 });

 it("drops signals for ids outside the turn's target list instead of guessing", () => {
 const mapped = mapTurnDecisionToDeltas(
 result([{ knowledge_point_id: "kp_deadbeefdeadbeef", outcome: "used", evidence: "x" }]),
 [grammarId],
 NOW,
 );
 expect(mapped.deltas).toHaveLength(0);
 expect(mapped.unattributed).toHaveLength(1);
 expect(mapped.unattributed[0]?.knowledge_point_id).toBe("kp_deadbeefdeadbeef");
 });

 it("records helped production without counting it as independent use", () => {
 const mapped = mapTurnDecisionToDeltas(
 result([{ knowledge_point_id: grammarId, outcome: "used_with_help", evidence: "x" }]),
 [grammarId],
 NOW,
 );
 expect(mapped.deltas[0]).toMatchObject({ used: 0, usedWithHelp: 1, seen: 1 });
 });
});

describe("turnDecisionSchema", () => {
 it("rejects more corrections than the cap allows", () => {
 const parsed = turnDecisionSchema.safeParse({
 branch: "attempt_judged",
 corrections: [
 { span: "a", fix: "b", reason: "c" },
 { span: "a", fix: "b", reason: "c" },
 { span: "a", fix: "b", reason: "c" },
 ],
 signals: [],
 });
 expect(parsed.success).toBe(false);
 });

 it("rejects an invented branch", () => {
 const parsed = turnDecisionSchema.safeParse({
 branch: "freeform_lecture",
 corrections: [],
 signals: [],
 });
 expect(parsed.success).toBe(false);
 });

 it("defaults answered_previous_question to true when the model omits it", () => {
 const parsed = turnDecisionSchema.parse({
 branch: "attempt_judged",
 corrections: [],
 signals: [],
 });
 expect(parsed.answered_previous_question).toBe(true);
 });

 it("keeps answered_previous_question false when the model says the learner did not answer", () => {
 const parsed = turnDecisionSchema.parse({
 branch: "question",
 corrections: [],
 signals: [],
 answered_previous_question: false,
 });
 expect(parsed.answered_previous_question).toBe(false);
 });
});

describe("the prose contracts", () => {
 it("requires an answer reply", () => {
 expect(answerResultSchema.safeParse({ reply: "Because dative." }).success).toBe(true);
 expect(answerResultSchema.safeParse({}).success).toBe(false);
 });

 it("allows empty feedback but always requires a question", () => {
 const parsed = continuationResultSchema.parse({ feedback: "", question: "Und du?" });
 expect(parsed).toMatchObject({ feedback: "", question: "Und du?" });
 expect(continuationResultSchema.safeParse({ feedback: "ok" }).success).toBe(false);
 });
});

describe("pendingQuestionOf", () => {
 it("returns the last question the app asked, not its whole reply", () => {
 const messages = [
 { role: "learner", content: "Hallo" },
 { role: "agent", content: "Wie geht es dir?\n\nWomit fährst du zur Arbeit?" },
 { role: "learner", content: "Warum Dativ?" },
 { role: "agent", content: "Because dative.\n\nWomit fährst du zur Arbeit?" },
 ];
 expect(pendingQuestionOf(messages)).toBe("Womit fährst du zur Arbeit?");
 });

 it("returns an empty string when the app has not spoken", () => {
 expect(pendingQuestionOf([{ role: "learner", content: "Hallo" }])).toBe("");
 });
});
