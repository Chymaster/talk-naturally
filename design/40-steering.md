# 40 — Steering

> Specification. Code is written from this document (`AGENT.md` §2).

## 1. The split

**Target selection is a deterministic function of progress**, evaluated by the
core, not a decision delegated to the model:

```
select_targets(scope, progress, session_state) -> ranked knowledge points + reason
```

**The core decides *what* to work on; the model decides *how* to work it into the
conversation.** This split is what keeps steering debuggable and testable, and it
is the main reason the model stays swappable.

**The model does decide how an incoming message is handled.** Classifying learner
intent — a genuine attempt vs. a linguistic question vs. drift — has no
deterministic derivation, so per-message routing is model-determined
([50-orchestration.md §3](50-orchestration.md)). The branch set itself is
authored, versioned, and reviewed like a prompt, and the model selects among
those branches rather than inventing them. Target selection, progress updates
([30-domain-model.md §2](30-domain-model.md)), and knowledge-point identity
([30-domain-model.md §4](30-domain-model.md)) stay in the core.

## 2. Scope and ranking

Target selection runs over a **scope**, not a single class. The scope is the
current class's knowledge points plus the points of every previous level the
learner has included, deduped by knowledge-point id
([30-domain-model.md §8](30-domain-model.md)). Progress is keyed per knowledge
point ([30-domain-model.md §5](30-domain-model.md)), so a point present in two
levels is ranked once, from one set of counters.

Within the scope, ranking considers, in this order:

1. **Due for review** — not seen for a while (spaced exposure).
2. **Struggling** — high `times_wrong` or `times_used_with_help` relative to
   `times_used`.
3. **Not yet introduced** — new material still untouched in the current level.
4. **Consolidating** — seen but never produced by the learner unprompted.

**New material is the current level only, at or above the cursor.** A point that
has never been seen counts as due/new only when it belongs to the current level
and its `unit_order` is at or above `known_through_unit`. An unseen point in an
included previous level, or below the cursor, is **background**: it scores zero
and is selected only when nothing else is left. As soon as any counter exists for
such a point it ranks normally, which is what makes cross-level review work.

## 3. Practical constraints on selection

- **A target list per turn must be small** (a handful). Dumping the whole scope
  into context wastes tokens, costs money, and destroys the natural feel.
- **Respect the resolved scope** (§2) but allow the drift-and-return behaviour
  from [20-architecture.md §4.3](20-architecture.md).
- **Log the reason for every selection.** "Why did it ask about the dative
  again?" must be answerable from a log line.
- Selection must be **pure and unit-testable** with no model call, so the
  weighting can be tuned against recorded sessions.

## 4. The implemented rule

Deterministic, integer weights, evaluated in `core/`, reason logged per turn:

```
score = 3·due + 2·struggle + 1·new + 1·consolidating
due           = never seen  OR  last_seen_at older than 2 days
struggle      = times_wrong + times_used_with_help
new           = 1 if times_seen == 0
consolidating = 1 if times_seen > 0 and times_used == 0
background    = unseen, and below the cursor or in an included earlier level
              → due and new do not apply; score 0
tie-break     = unit_order asc, then knowledge_point_id asc  → stable, reproducible
```

The four weights and the top-5 list are unchanged. What changed is the rule's
input: the scope is resolved across levels (§2), the tie-break follows the unit
order so new material arrives chapter by chapter instead of in id-hash order, and
unseen points outside the current level's cursor are background. This is `D-024`
in [80-decisions.md](80-decisions.md); steering weights are an ask-first surface
([`AGENT.md`](../AGENT.md) §5) and were not touched.

Target list per turn: top 5. Pure and unit-testable with no model call.

*Implemented as:* `core/steering/scope.ts` (scope resolution) and
`core/steering/select-targets.ts` (`selectTargets`, `explainTarget`).

TODO: these weights and thresholds are the PoC defaults. Re-confirm them against
recorded session data, and confirm the progress fields they read match what
ingestion actually produces ([60-ingestion.md](60-ingestion.md)). Changing them
once learner history exists is an ask-first change (`AGENT.md` §5).
