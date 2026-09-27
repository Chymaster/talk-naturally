# 90 — Ideas register (staging)

> **Non-normative.** Nothing here is a rule. Ideas are staged in
> [`idea.md`](../idea.md) — this document explains the workflow and points at
> the register. The register itself stays at the repository root because
> `AGENT.md` and prior commits reference it by that path.

## 1. Why ideas are staged

Unreviewed ideas must not reach the specification. Staging them keeps `design/`
reviewed and gives one place to catch an idea that contradicts another idea or an
existing rule **before** either becomes a design change.

## 2. The workflow

1. **Capture first, merge later.** Record the idea as an `IDEA-nnnn` entry in
   [`idea.md`](../idea.md). Do not edit a design doc in the same step.
2. **Conflicts surface at merge time.** Before an idea is consolidated, scan it
   against every other open idea and against the design docs it touches, and
   record each conflict plus its resolution on the entry. "None found" is an
   explicit result, not an omission.
3. **Resolve before merging.** Settle a conflict by adopting one side, amending
   the idea, superseding the other idea, or rejecting it. Two contradictory
   ideas must not both be merged.
4. **Merge deliberately.** Write the idea into the right design doc as a rule
   (drop the discussion), update affected lines instead of duplicating them, add
   a row to [80-decisions.md](80-decisions.md), and mark the entry `Merged` with
   the design-doc section it became.
5. **While an idea is undecided, the design docs win.** An unreviewed idea never
   overrides an existing rule.

## 3. Where things land

| The idea is about… | It merges into |
|---|---|
| What the product is, deployment, scope | [10-overview.md](10-overview.md) |
| The core boundary, ports, invariants, model port | [20-architecture.md](20-architecture.md) |
| Classes, knowledge points, progress, identity, access | [30-domain-model.md](30-domain-model.md) |
| Which knowledge point to work on next | [40-steering.md](40-steering.md) |
| Sessions, the per-message workflow, the graph | [50-orchestration.md](50-orchestration.md) |
| Where material comes from and how it is fitted | [60-ingestion.md](60-ingestion.md) |
| Language, library, storage, layout, testing | [70-stack.md](70-stack.md) |
| A dated decision and its status | [80-decisions.md](80-decisions.md) |

A merge can carry TODOs: when an idea is merged by maintainer instruction with
conflicts still open, the undecided parts land in the design doc as explicit
`TODO:` lines. A TODO is not a settled rule.
