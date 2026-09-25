/**
 * The mapping from a structured turn result to counters lives in one place and
 * is tested here (AGENT.md §6.2).
 */
import { describe, expect, it } from "vitest";
import { mapTurnResultToDeltas } from "../core/progress/apply.js";
import { turnResultSchema } from "../core/domain/turn.js";
import { allIds, makeClass, NOW } from "./fixtures.js";

const klass = makeClass();
// allIds() order is grammar, then sentence structure, then vocab.
const [grammarId, structureId] = allIds(klass) as [string, string, string, string];

function result(signals: unknown): ReturnType<typeof turnResultSchema.parse> {
  return turnResultSchema.parse({
    branch: "attempt_judged",
    reply: "ok",
    corrections: [],
    signals,
  });
}

describe("mapTurnResultToDeltas", () => {
  it("counts an independent production as used and seen", () => {
    const mapped = mapTurnResultToDeltas(
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
    const mapped = mapTurnResultToDeltas(
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
    const mapped = mapTurnResultToDeltas(
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
    const mapped = mapTurnResultToDeltas(
      result([{ knowledge_point_id: "kp_deadbeefdeadbeef", outcome: "used", evidence: "x" }]),
      [grammarId],
      NOW,
    );
    expect(mapped.deltas).toHaveLength(0);
    expect(mapped.unattributed).toHaveLength(1);
    expect(mapped.unattributed[0]?.knowledge_point_id).toBe("kp_deadbeefdeadbeef");
  });

  it("records helped production without counting it as independent use", () => {
    const mapped = mapTurnResultToDeltas(
      result([{ knowledge_point_id: grammarId, outcome: "used_with_help", evidence: "x" }]),
      [grammarId],
      NOW,
    );
    expect(mapped.deltas[0]).toMatchObject({ used: 0, usedWithHelp: 1, seen: 1 });
  });
});

describe("turnResultSchema", () => {
  it("rejects a reply that is a wall of corrections", () => {
    const parsed = turnResultSchema.safeParse({
      branch: "attempt_judged",
      reply: "ok",
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
    const parsed = turnResultSchema.safeParse({
      branch: "freeform_lecture",
      reply: "ok",
      corrections: [],
      signals: [],
    });
    expect(parsed.success).toBe(false);
  });
});
