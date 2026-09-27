/**
 * Design-doc conformance for the turn workflow (design/50-orchestration.md §3.2).
 *
 * The per-message workflow is specified in `design/`, and its picture is
 * duplicated in Mermaid. A stale diagram documents a workflow that no longer
 * runs, so this test fails when the compiled graph, the documented topology,
 * and the diagram stop agreeing.
 *
 * It is intentionally a *source* check, not a runtime one: it asserts the shape
 * a reviewer reads in the design doc, which is what the design-docs-first rule
 * (design/20-architecture.md §1) makes normative. No network, no host, no model.
 *
 * The `route`/`onboarding` prefix is deterministic and makes no model call;
 * `open` asks the first question once onboarding completes
 * (design/50-orchestration.md §3.2).
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const turnGraphSource = readFileSync(`${repoRoot}engine/turn-graph.ts`, "utf8");
const mermaidSource = readFileSync(`${repoRoot}design/turn-graph.mmd`, "utf8");

/** Topology documented in design/50-orchestration.md §3.2. Update it there first. */
const DOCUMENTED_EDGES: ReadonlyArray<readonly [string, string]> = [
 ["__start__", "route"],
 ["route", "onboarding"], // learner settings incomplete
 ["route", "assemble"], // learner settings complete
 ["onboarding", "open"], // onboarding just completed: ask the first question
 ["onboarding", "deliver"], // still mid-onboarding
 ["open", "deliver"],
 ["assemble", "deliver"], // class missing
 ["assemble", "classify"],
 ["classify", "validate"],
 ["validate", "failed"],
 ["validate", "attempt_judged"],
 ["validate", "question"],
 ["validate", "kp_question"],
 ["validate", "drift"],
 ["attempt_judged", "attempt_corrected"],
 ["attempt_judged", "attempt_accepted"],
 ["attempt_corrected", "answer"], // a wrong attempt is corrected in the source language
 ["attempt_accepted", "answered"],
 ["question", "answer"], // answer the question on its own, in one language
 ["kp_question", "answer"],
 ["drift", "answer"],
 ["answer", "answered"],
 ["answered", "continue_turn"], // a clear attempt moves the conversation on
 ["answered", "reask"], // anything else repeats the question on the table
 ["continue_turn", "compose"],
 ["reask", "compose"],
 ["compose", "persist"],
 ["failed", "deliver"],
 ["persist", "deliver"],
 ["deliver", "__end__"],
];

function nodeIds(source: string): Set<string> {
 const ids = new Set<string>();
 for (const match of source.matchAll(/\.(?:addNode|addConditionalEdges)\(\s*"([A-Za-z_][\w]*)"/g)) {
 ids.add(match[1] ?? "");
 }
 for (const match of source.matchAll(/\.addEdge\(\s*"([A-Za-z_][\w]*)"/g)) {
 ids.add(match[1] ?? "");
 }
 for (const match of source.matchAll(/\.addEdge\(\s*"[^"]*"\s*,\s*"([A-Za-z_][\w]*)"/g)) {
 ids.add(match[1] ?? "");
 }
 return ids;
}

function edgesFrom(source: string, from: string): string[] {
 const targets: string[] = [];
 // .addEdge("from", "to")
 const direct = new RegExp(`\\.addEdge\\(\\s*"${from}"\\s*,\\s*"([A-Za-z_][\\w]*)"`, "g");
 for (const match of source.matchAll(direct)) {
 targets.push(match[1] ?? "");
 }
 // .addConditionalEdges("from", router, { a: "x", b: "y" })
 const conditional = new RegExp(
 `\\.addConditionalEdges\\(\\s*"${from}"[\\s\\S]*?\\{(?<body>[\\s\\S]*?)\\}\\s*\\)`,
 "g",
 );
 for (const match of source.matchAll(conditional)) {
 const body = match.groups?.["body"] ?? "";
 for (const entry of body.matchAll(/:\s*"([A-Za-z_][\w]*)"/g)) {
 targets.push(entry[1] ?? "");
 }
 }
 return targets;
}

function graphEdges(): Array<[string, string]> {
 const froms = nodeIds(turnGraphSource);
 const edges: Array<[string, string]> = [];
 for (const from of froms) {
 for (const to of edgesFrom(turnGraphSource, from)) {
 edges.push([from, to]);
 }
 }
 for (const match of turnGraphSource.matchAll(/\.addEdge\(\s*START\s*,\s*"([A-Za-z_][\w]*)"/g)) {
 edges.push(["__start__", match[1] ?? ""]);
 }
 for (const match of turnGraphSource.matchAll(/\.addEdge\(\s*"([A-Za-z_][\w]*)"\s*,\s*END\s*\)/g)) {
 edges.push([match[1] ?? "", "__end__"]);
 }
 return edges;
}

/** Mermaid node identifiers, excluding the rounded START/END terminals. */
function mermaidNodeIds(): Set<string> {
 const ids = new Set<string>();
 // A declaration is `id` immediately followed by `[`, `(` or `{`. The leading
 // guard rejects edge syntax: in `A --> B`, the id before the arrow is followed
 // by whitespace then `-`, not by a bracket.
 for (const match of mermaidSource.matchAll(/(?:^|[\s>|])?([A-Za-z][\w]*)\s*[\[\(\{]/gs)) {
 ids.add(match[1] ?? "");
 }
 return ids;
}

describe("design conformance: turn workflow (design/50-orchestration.md §3.2)", () => {
 it("the compiled graph has exactly the documented edges", () => {
 const actual = new Set(graphEdges().map(([from, to]) => `${from}->${to}`));
 const documented = new Set(DOCUMENTED_EDGES.map(([from, to]) => `${from}->${to}`));

 expect([...actual].sort()).toEqual([...documented].sort());
 });

 it("every documented node exists in the graph", () => {
 const graphNodes = nodeIds(turnGraphSource);
 const documentedNodes = new Set(DOCUMENTED_EDGES.flat().filter((id) => !id.startsWith("__")));

 for (const node of documentedNodes) {
 expect(graphNodes.has(node), `documented node "${node}" is not in the graph`).toBe(true);
 }
 });

 it("the Mermaid diagram shows every documented graph node", () => {
 const diagramNodes = mermaidNodeIds();
 const graphNodes = nodeIds(turnGraphSource);

 for (const node of graphNodes) {
 expect(diagramNodes.has(node), `node "${node}" is missing from design/turn-graph.mmd`).toBe(
 true,
 );
 }
 });

 it("the design doc requires the diagram to be updated with the graph", () => {
 const doc = readFileSync(`${repoRoot}design/50-orchestration.md`, "utf8");
 expect(doc).toMatch(/same commit/i);
 });

 it("the graph source points a reader at the design doc", () => {
 expect(turnGraphSource).toContain("design/50-orchestration.md");
 });
});
