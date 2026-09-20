# idea.md — staging register for unreviewed ideas

> **Non-normative.** `AGENT.md` is the single source of truth for how agents
> work in **talk-naturally**. Nothing in this file is a rule, an instruction, or
> a decision. An idea becomes real only when it is merged into `AGENT.md`.

Unreviewed ideas are written here first, so `AGENT.md` stays short and reviewed
while nothing is lost. Because ideas land here unreviewed, an idea may
contradict another idea or a rule already in `AGENT.md`; finding and resolving
that conflict is part of merging it into `AGENT.md`.

## How this file is used

1. **Capture.** Append the idea under *Ideas* as the next free `IDEA-nnnn`,
   using the entry template. Do not edit `AGENT.md` in the same step.
2. **Review.** Check the idea against every other idea here and against the
   `AGENT.md` sections it would touch. Record the result in *Conflicts* — an
   explicit "none found" is required, not silence.
3. **Resolve.** Settle every conflict before merging: adopt one side, amend the
   idea, supersede the other idea, or reject. Two contradictory ideas must not
   both be merged.
4. **Merge.** Fold the idea into `AGENT.md` as a rule (dropping the discussion),
   update the lines it changes rather than duplicating them, then mark the entry
   `Merged` and name the section it became.
5. **Never** leave a merged idea only here. `AGENT.md` is the artifact agents
   read; this file is the open queue plus the history of what was decided.

## Status values

`Open` · `Needs decision` · `Parked` · `Merged` · `Rejected` · `Superseded`

## Entry template

```markdown
### IDEA-0000 — <short title>
- **Status:** Open
- **Date:** YYYY-MM-DD
- **Author:** <who raised it>
- **Idea:** <what is proposed, in one or two sentences>
- **Why:** <the problem it solves / rationale>
- **Touches:** <AGENT.md sections it would change, or "new section">
- **Conflicts:** <other IDEA ids and/or AGENT.md rules that disagree; or "none found">
- **Resolution:** <how each conflict was settled; required before Merged>
- **Merged as:** <AGENT.md section(s); only when Status is Merged>
```

## Conflict rules

- Conflicts are **expected**, not a failure. Surfacing one is the point of this
  file.
- A conflict is any pair of ideas, or an idea and an `AGENT.md` rule, that
  cannot both be true at once.
- Cite conflicts by IDEA id and by `AGENT.md` section number so they can be
  found again.
- A losing idea is not deleted: mark it `Superseded` and point at the winner.
- **Tie-break while undecided:** an existing `AGENT.md` rule wins and the idea
  stays `Open` or `Parked` until a maintainer decides. `AGENT.md` changes only
  through the merge step.

## Merge checklist (run before editing AGENT.md)

- [ ] The idea was re-scanned against every other open idea; conflicts recorded.
- [ ] Each conflict has a resolution, not just a note.
- [ ] The idea is written into `AGENT.md` as a rule, not as discussion.
- [ ] Superseded `AGENT.md` lines are edited or removed, not left contradicting.
- [ ] Entry status set to `Merged` with the section reference.
- [ ] `AGENT.md` did not grow more than the rule is worth (see its preamble).

## Ideas

### IDEA-0001 — Stage ideas in `idea.md` before merging into `AGENT.md`
- **Status:** Merged
- **Date:** 2026-09-20
- **Author:** maintainer request
- **Idea:** Keep a non-normative `idea.md` register that collects unreviewed
  ideas and resolves their conflicts before they are consolidated into
  `AGENT.md`.
- **Why:** An idea that contradicts another idea, or an existing rule, was
  previously only discoverable while editing `AGENT.md` itself; there was no
  place to hold ideas that are not yet reviewed.
- **Touches:** `AGENT.md` §9 (layout), §12 (working agreement), new §17.
- **Conflicts:** `AGENT.md` line 5 — "This file is the single source of truth
  for how agents should work here." A second document could be read as a second
  source of truth.
- **Resolution:** `idea.md` is declared non-normative in both files; `AGENT.md`
  keeps primacy and is the only place a rule can live. §17 states the register
  is an inbox with no authority, so no rule is duplicated or diluted.
- **Merged as:** `AGENT.md` §17 (and cross-references in §9, §12).

### IDEA-0002 — Scheduler-driven conversation loop with per-turn re-evaluation
- **Status:** Merged
- **Date:** 2026-09-20
- **Author:** maintainer request
- **Idea:** The chatflow runs on a **customisable scheduler** (default: a set
  time daily; also random time during the day). At the scheduled moment the
  agent reviews the learner's dataset/progress, decides the best knowledge
  point to start on, and sends the first message, then waits. On each user
  reply it re-evaluates the exchange — what the learner already knows, what
  they are struggling with — and, considering the chat history together with
  the pending knowledge points, sends the response that best keeps the
  conversation going while guiding through unlearned points. If the learner
  asks a question about a knowledge point, the agent updates the dataset for
  that knowledge point, answers the question, and then continues the loop.
- **Why:** Turns the engine from a passive responder into a paced tutor. The
  schedule supplies the spaced exposure that §6.3's ranking assumes, without
  the learner managing admin. The drift-and-return shape of §7.3 and the
  small-target-list rule of §6.3 already fit this loop.
- **Touches:** §3 (clock/ports), §5 (remote model + network), §6.1–§6.5,
  §7.1, §7.2, §7.5, §8 (context budget), §15 (spend controls), new section.
- **Conflicts:**
  - **§7.2 "Chat is the entire interface."** A schedule that is "customisable
    (set time / random time)" implies a settings surface, and the rule forbids
    asking the learner to fill a form or open any screen other than chat.
    Agent-initiated first messages also invert the rule's framing that the
    learner is the one who sends messages. Is the schedule configured in
    conversation, and is proactive contact allowed at all?
  - **§6.3 "the core decides *what*; the model decides *how*."** "the agent
    will … decide on a topic" and "evaluate what user already knows and what
    user is struggling with" read as *model* judgment. The existing rule makes
    target choice the deterministic core function
    `select_targets(progress, class, session_state)` and validates learner
    state from structured output (§6.2). Direct conflict unless the wording
    means the core function phrasing the model's message.
  - **§6.4 "never rewrite or reassign an existing knowledge-point ID" +
    §6.5 class lifecycle + §7.8 untrusted material.** "update the dataset on
    the knowledge" is ambiguous. If it mutates *class material* from a chat
    question, it collides with deterministic identity, re-import
    reconciliation, and the fact that class material is imported/shared
    content. If it means "update *progress*", it must instead obey §6.2
    (once per turn, attributed by ID, idempotent).
  - **§6.1 "keep raw counters, derive the rest" + §7.5 "the learner model
    lives in the core."** Re-evaluating "what the user already knows" from the
    conversation must land as persisted per-knowledge-point counters, not as a
    fresh model opinion held only in the prompt.
  - **§5 "no fully offline mode" + §3 "the core must not make network calls" +
    §8.** A proactive message needs the remote model live at that moment. A
    device offline at the scheduled time, a missed schedule, and the
    notification/background wake are unaddressed; delivery and scheduling are
    host/transport concerns, not core ones.
  - **§8 context budget + §6.3 small target list.** "consider the chat history
    as well as the pending knowledge points" can exceed
    `max_context_tokens`; the rule requires fitting the smallest supported
    model.
  - **§15 "spend/cost controls" + §12.4 "ask before hard-to-reverse
    decisions."** Random or frequent scheduling multiplies remote calls, and
    the pacing/notification behaviour is a prompt- and product-behaviour
    change.
  - **§4 portability.** Background scheduling and notifications behave
    differently and are restricted per platform (iOS/Android); the scheduler
    must not leak a platform scheduling API into `core/`.
  - No conflict with IDEA-0001 (the register itself is orthogonal).
  - **IDEA-0007 architecture impact (2026-09-20).** The scheduler runs in the
    server host, not on the device. With Discord (then Telegram) as the first
    frontends, a scheduled opener is delivered as a normal bot message, so the
    delivery problem largely dissolves; only the later phone thin client
    reintroduces OS notification limits. §5's "core makes no network calls"
    conflict changes shape, and §4's platform-scheduling conflict moves to the
    client.
- **Resolution:** **Unresolved at merge time (2026-09-20); carried into `AGENT.md` as TODOs.** Decisions a
  maintainer must make: (a) can the schedule be set in conversation, or does
  §7.2 forbid any schedule UI and therefore this idea? (b) confirm target
  selection stays the core's deterministic function and the model only phrases
  it; (c) define "update the dataset" as progress-only, or justify mutating
  class material; (d) define offline / missed-schedule / retry behaviour;
  (e) fix a bounded history + pending-points budget; (f) decide cost controls
  for proactive turns. Existing `AGENT.md` rules win until each is settled.
- **Merged as:** Merged 2026-09-20 into `AGENT.md` §18.1 (scheduler). The open
  items (a)–(f) were carried across as the TODO in §18.1, not resolved.

### IDEA-0003 — Bundled German A1–C2 knowledge, with a level question on first run
- **Status:** Merged
- **Date:** 2026-09-20
- **Author:** maintainer request
- **Idea:** By default the app ships knowledge information for German at every
  level from A1 to C2, built from public information for each level. On a fresh
  start the app asks the learner which level they are learning now.
- **Why:** Removes the import step for the most common case, so a new learner
  can start talking immediately (§1 core promise). §6.5 already plans a
  built-in default class library; this supplies the first concrete content and
  the entry point for choosing it.
- **Touches:** §6.1, §6.4, §6.5, §7.2, §7.3, §8, §9, §12.4, §15, new section.
- **Conflicts:**
  - **§6.5 already plans this and constrains it.** "A built-in class is just a
    class with a different `origin` — do not special-case it," and it "must
    work with no network." Largely aligned, but the idea adds a **level**
    dimension (A1–C2) that §6.1's Class model does not have: is a level one
    class, or several? It must map onto existing Class + `origin`, not a new
    type.
  - **No rule covers content provenance, licensing, or attribution.** Bundled
    third-party material is a vendored artifact, which §15 already makes
    ask-before-touching and §12.4 treats as a hard-to-reverse decision. This is
    a real gap. Worse, there is no single authoritative "public information"
    list of A1–C2 German vocabulary and grammar — CEFR describes levels, it
    does not publish per-level word/grammar inventories — so the idea assumes a
    source that may not exist in the form implied. If any of it is scraped,
    §7.8 (class material is untrusted input) also applies.
  - **§6.4 stable knowledge-point identity.** Bundled points still need
    deterministic IDs, and updating the bundle later must reconcile and
    preserve progress exactly like a re-import.
  - **§7.2 "Chat is the entire interface."** The level question must be asked
    in conversation — which the rule explicitly allows — and must stay a single
    question; a placement test form or a level-selection screen would conflict.
    There is also no fallback defined for a learner who does not know their
    level.
  - **§7.3 "the class is a scope, not a wall" + §6.3 ranking.** A fixed level
    risks hard-gating: an A2 learner may still need A1 review, and §6.3 ranks
    "due for review" within the class. Define whether level filters targets or
    merely orders them.
  - **§8 context budget + §6.3 small target list.** A1–C2 is a large body of
    material; only a handful of points may enter context per turn, and the
    bundled asset must still fit a phone app (§4).
  - **IDEA-0002 interaction.** The scheduler's opening message needs a class
    and targets to pick from, so a first-ever session must ask the level before
    any scheduled topic. Not contradictory, but the ordering must be stated.
  - **IDEA-0007 architecture impact (2026-09-20).** With a thin client the
    A1–C2 knowledge no longer has to be bundled in the app; it lives wherever
    the server host runs. §6.5's "a bundled default class must work with no
    network" becomes moot for the client, and the licence/provenance question
    now covers hosted content, not just a shipped asset.
- **Resolution:** **Unresolved at merge time (2026-09-20); carried into `AGENT.md` as TODOs.** Decisions a
  maintainer must make: (a) is "level" a field on Class or a separate concept?
  (b) which public sources, under what licence and attribution, may be bundled?
  (c) is the level question the only onboarding step, asked in chat, with a
  fallback? (d) does level gate targets or only order them? (e) how are bundled
  datasets versioned and reconciled on update (§6.4)? Existing `AGENT.md` rules
  win until each is settled.
- **Merged as:** Merged 2026-09-20 into `AGENT.md` §19.2 (built-in levels) and
  §6.5. The open items (a)–(e) were carried across as the TODO in §19.2, not
  resolved.

### IDEA-0004 — Learner can upload their own personal knowledge points
- **Status:** Merged
- **Date:** 2026-09-20
- **Author:** maintainer request
- **Idea:** In addition to bundled and imported class material, the learner can
  upload their own personal learning knowledge points, which then take part in
  the same progress tracking and steering as everything else.
- **Why:** Lets the learner bring material we did not bundle — their own notes,
  corrections, or a deck from another app — without leaving the "show up and
  talk" premise (§1). §6.5 already anticipates learner-supplied material; this
  makes the personal case explicit and first-class.
- **Touches:** §6.1, §6.2, §6.3, §6.4, §6.5, §7.2, §7.5, §7.8, §8, §12.4, §15.
- **Conflicts:**
  - **§7.2 "Chat is the entire interface."** "Upload" implies a file picker or
    an import screen; the rule permits asking the learner for data *in
    conversation* but forbids a separate surface. As worded this is a direct
    conflict — it must become an in-chat attach/paste, or the rule must change.
  - **§6.5 already covers learner-supplied import.** "Imported now: one class
    imported from learner-supplied material," and "a built-in class is just a
    class with a different `origin` — do not special-case it." The idea must
    state what is *new* here — personal points outside a class, a cross-class
    personal collection, or merely import — or it is already-planned behavior
    and does not deserve its own entry.
  - **§6.1 domain model.** A KnowledgePoint lives inside a Class with `kind`
    (grammar | sentence_structure | vocab), `title`, `detail`, `raw_source`. A
    personal point needs a container and a kind, or an explicit fourth
    kind/origin ("personal"). That is a domain-model change, not a formatting
    detail.
  - **§6.4 stable identity.** Personal points need deterministic IDs that do
    not collide with bundled IDs or with themselves on a second upload, and
    re-uploading the same point must reconcile rather than duplicate. If a
    personal point duplicates a bundled one, merging vs. duplicating changes
    progress: duplicates would split counters and distort §6.3 ranking.
    §15 makes the ID scheme ask-first.
  - **§6.2/§6.3.** Uploaded points must enter `select_targets` like any other
    point, with per-turn, ID-attributed, idempotent progress updates.
  - **§7.8.** Uploaded content is untrusted input flowing into model context —
    never instructions. Personal material makes this sharper, not weaker.
  - **§8 context budget + §6.3 small target list.** The point pool grows;
    still only a handful of points may enter context per turn.
  - **§12.4/§15.** "Storage schema" and "knowledge-point ID scheme" are
    explicitly ask-first, and the upload format/interop (own format, CSV,
    Anki, …) may add a dependency under §12.4.
  - **IDEA-0002 / IDEA-0003 interactions.** Define how personal points coexist
    with level-based bundled classes and whether they are eligible for the
    scheduler's opening topic; if they are not selectable, they are invisible
    to the loop.
  - **IDEA-0007 architecture impact (2026-09-20).** Uploads are received and
    stored by the server host, so §6.1's "authoritative store is the learner's
    device" becomes a server-side store with the privacy and auth obligations
    that follow. The §7.2 upload-surface conflict is unchanged.
- **Resolution:** **Unresolved at merge time (2026-09-20); carried into `AGENT.md` as TODOs.** Decisions a
  maintainer must make: (a) is upload allowed as an in-chat attachment, or does
  §7.2 forbid it? (b) what is the container for personal points — their own
  class with `origin: personal`, or a new kind? (c) duplicate/collision policy
  against bundled points; (d) ID scheme and accepted file format/interop;
  (e) can personal points carry a level (IDEA-0003)? (f) are they in scheduler
  scope (IDEA-0002)? IDEA-0005 proposes a fixed dataset schema with
  model-assisted fitting — a candidate answer for (b) and (d), itself
  unreviewed. Existing `AGENT.md` rules win until each is settled.
- **Merged as:** Merged 2026-09-20 into `AGENT.md` §19.3 (personal points) and
  §19.1. The open items (a)–(f) were carried across as the TODO in §19.3, not
  resolved.

### IDEA-0005 — One fixed dataset schema; uploads are model-fitted into it
- **Status:** Merged
- **Date:** 2026-09-20
- **Author:** maintainer request
- **Idea:** The knowledge dataset has one set schema. Whatever the learner
  uploads is analysed by the agent and fitted into that schema, rather than
  introducing a different shape per source.
- **Why:** One schema keeps storage, progress, steering, and identity uniform,
  and makes an upload "just a class with a different `origin`" (§6.5) instead
  of a special case. It is the mechanism IDEA-0004 needs.
- **Touches:** §6.1, §6.2, §6.4, §6.5, §7.2, §7.8, §8, §11, new section.
- **Conflicts:**
  - **§6.1.** The schema already exists in outline (Class, KnowledgePoint,
    UserProgress) but is not frozen or versioned; this idea requires making it
    explicit and versioned. The three kinds (grammar | sentence_structure |
    vocab) also leave no bucket for material that fits none — model fitting
    will meet such input.
  - **§6.2 "matching … by fuzzy text is a bug factory."** The sharp one. Model
    fitting is legitimate when *creating* knowledge points from free text, but
    it must never fuzzy-match an uploaded point onto an existing ID for
    progress attribution; progress attaches only from structured output by ID,
    or is logged as unattributed. The idea is safe only if that line is
    explicit.
  - **§6.4 stable identity.** IDs must stay deterministic from canonical
    content, not model-assigned. If the model normalizes a title differently on
    two uploads of the same material, the derived ID changes and progress is
    orphaned; fitting needs a canonical normalization step and a duplicate
    policy.
  - **§8 model adapter.** Fitting is a model call: structured output, validated
    in the core, bounded repair, no trusting the model. It also means arbitrary
    uploads cannot be ingested offline, while §6.5's bundled class must still
    work with no network (pre-fitted at build time).
  - **§7.8.** Uploaded text is untrusted input inside the fitting prompt; it
    must not be able to alter the schema or the instructions.
  - **§6.5 + §7.2.** Fitting can fail or fit partially; that must surface in
    conversation, not crash. Any "did we read this right?" confirmation must
    also happen in chat, not on a review screen.
  - **§11/§12.4/§15.** The schema is a storage-schema and knowledge-point-ID
    decision (ask-first); schema changes need tested migrations, and stored
    points must reconcile with a new schema rather than being silently
    re-fitted.
  - **§6.1 `raw_source`.** Keep the original uploaded text per point so a
    re-fit is possible and the mapping stays debuggable.
  - **IDEA-0004 / IDEA-0003 / IDEA-0002 interactions.** This is a candidate
    answer for IDEA-0004 (b) and (d); bundled A1–C2 content and "level" must
    fit this same schema; the scheduler selects from whatever the schema holds.
  - **IDEA-0007 architecture impact (2026-09-20).** Fitting runs in the server
    host and stored points live there; "arbitrary uploads cannot be ingested
    offline" is no longer a client-side constraint. The schema is now a
    server-side storage decision.
- **Resolution:** **Unresolved at merge time (2026-09-20); carried into `AGENT.md` as TODOs.** Decisions a
  maintainer must make: (a) freeze and version the schema, and decide whether
  an "other/unclassified" kind is allowed; (b) forbid fuzzy matching for
  attribution, in writing (§6.2); (c) canonical normalization + duplicate
  policy for deterministic IDs; (d) fit-failure and learner-confirmation path,
  in chat; (e) whether fitting lives in the core or outside it (it is a
  model + transport concern — §3/§8); (f) migration behaviour when the schema
  changes. Existing `AGENT.md` rules win until each is settled.
- **Merged as:** Merged 2026-09-20 into `AGENT.md` §19.1 (one schema,
  model-fitted). The open items (a)–(f) were carried across as the TODO in
  §19.1, not resolved.

### IDEA-0006 — Per-message decision workflow that re-anchors to the knowledge point
- **Status:** Merged
- **Date:** 2026-09-20
- **Author:** maintainer request
- **Idea:** The conversation should keep being pulled back toward touching the
  active knowledge point, with some mechanism that stops the agent being
  dragged away. Instead of every message being handled by the same system
  prompt, each message becomes its own workflow with boundary decisions: analyse
  the reply, then branch — is it a learner response (judge the grammar →
  correct branch vs. incorrect branch) or a linguistic question (unknown word,
  sentence construction → its own branch), and so on. The full workflow is TBD
  but should be presentable as a flowchart, LangGraph-style.
- **Why:** Makes re-anchoring explicit and inspectable instead of trusting one
  prompt. The branch points are exactly where explainable steering (§7.9) and
  inline correction (§7.4) live, and a visible flowchart is reviewable in a diff
  the way a prompt is (§7.7).
- **Touches:** §2, §2.1, §3, §6.2, §6.3, §7.3, §7.4, §7.5, §7.7, §7.9, §8,
  §9, §11, §12.4.
- **Conflicts:**
  - **§2.1 "Do not build on LangGraph" / §2.2.** "like LangGraph" must mean
    graph-shaped and flowchart-documented, not the library. If it means adopting
    LangGraph, that is a direct conflict (and §2.2's server-host reversal would
    apply). Koog is the portable graph option — and even then §2.1 forbids Koog
    types appearing in `core/`.
    → **SUPERSEDED 2026-09-20 by IDEA-0007: LangGraph is adopted and the phone
    is a thin client. Decision (a) is answered — it means the library. The
    workflow is a LangGraph graph executed by the server host.**
  - **§6.3 + §2.1 "it assumes the model decides control flow; our steering is
    deliberately deterministic. That is a design mismatch."** A tree that
    branches on model judgment (correct/incorrect, question vs. response) hands
    control flow to the model. It is only compatible if the *branch structure*
    stays deterministic core logic and the model supplies validated structured
    signals; otherwise this is a design reversal needing an explicit maintainer
    decision.
    → **RESOLVED AND MERGED 2026-09-20: the maintainer chose the reversal —
    the model picks the branch, because user intent has no deterministic
    derivation. Now normative in `AGENT.md` §2.1 and §6.3.**
  - **§2.1 "our turn is: load context → one structured model call → validate →
    update progress. Linear, seconds long."** A per-message workflow with
    several classification calls changes latency, cost, and complexity, so it
    must pass §2.1's own test for justifying framework-style orchestration.
  - **§7.3 "the class is a scope, not a wall."** The rule *requires* handling
    off-topic remarks and grammar questions gracefully and then steering back,
    and forbids refusing hard or lecturing. The "stop the agent being dragged
    away" mechanism must therefore be a soft re-anchor with a bounded drift
    allowance, not a clamp or refusal. Direct tension as worded.
    → **RESOLVED 2026-09-20: the maintainer chose the soft re-anchor, not a
    clamp.** This *conforms* to §7.3 as written, so no amendment is needed
    there; only the definition of drift and its allowance remain open. See
    *Resolution*.
  - **§7.4 "corrections happen in flow."** The correct/incorrect branches must
    stay small and inline; a branch that produces a grammar essay conflicts.
  - **§6.2.** Every branch still ends in one per-turn, ID-attributed, idempotent
    progress update, and an unattributable signal is logged, not guessed.
    Grammar verdicts must map to counters in one tested place, not be re-derived
    per branch.
  - **§7.5 / §6.1.** Branch conditions must read persisted progress counters,
    not conversation-only memory.
  - **§7.7 "prompts are code" + §12.4.** A multi-branch workflow is a
    prompt-behavior change; the flowchart is a reviewed, versioned artifact, not
    a diagram kept beside the code.
  - **§8 + §11 + §15.** Each branch decision needs structured output validated
    in the core, and every extra model call spends context and money (§8 budget,
    §15 spend controls); the tree must be unit-testable against the fake adapter
    with no live model.
  - **§9.** "Presentable as a flowchart" needs a home and a text source of truth
    in the layout; none exists yet.
  - **IDEA-0002 / IDEA-0003 / IDEA-0004 / IDEA-0005 interactions.** This is the
    inside of the IDEA-0002 loop and the "how" of §6.3 re-anchoring; its targets
    come from the IDEA-0005 schema whatever their origin.
  - **IDEA-0007 architecture impact (2026-09-20).** The per-message workflow is
    a LangGraph graph on the server host. On-device execution is no longer
    required, which moots the React Native/Hermes and CPython-on-iOS questions,
    and the "flowchart" can be LangGraph's own graph plus its Studio
    visualization.
- **Resolution:** **Partially resolved at merge time (2026-09-20); the remaining
  items are carried into `AGENT.md` as TODOs.**
  - **Decided 2026-09-20 (decision (b), control-flow conflict): branch
    selection is model-determined.** User intent — a genuine reply vs. a
    linguistic question vs. drift — has no deterministic derivation, so the
    model chooses the branch for each incoming message. What this means (now
    applied):
    - `AGENT.md` §2.1's reason "it assumes the model decides control flow; …
      that is a design mismatch" was **over-broad and has now been amended**:
      that objection is withdrawn, and `linear` / `one structured model call`
      wording is replaced. The portability objections to LangGraph (Python/JS
      only, no KMP) are untouched, so **LangGraph stays ruled out**.
    - §6.3's "not a decision delegated to the model" has been narrowed to
      target selection: the model routes *how a message is handled*; the core
      still decides *what to teach* — target ranking remains the deterministic
      `select_targets(progress, class, session_state)`.
    - Progress stays deterministic and validated: once per turn,
      ID-attributed, idempotent (§6.2); identity stays core-derived (§6.4).
    - The **branch set** stays authored, versioned, and reviewed (§7.7, §11).
      **Confirmed by the maintainer 2026-09-20:** the model picks among a
      fixed, authored set of branches; it does not generate the workflow
      structure at runtime. This keeps the flowchart a reviewable artifact and
      the branches unit-testable (§11).
    - **Applied 2026-09-20:** the maintainer chose the recommended option, so
      these amendments are live in `AGENT.md` now. The rest of IDEA-0006 is
      still open, so this file wins on every point not yet decided.
  - **Also decided 2026-09-20 (decision (d), §7.3 conflict): drift is handled
    by a soft re-anchor, never a clamp.** This conforms to §7.3 as written, so
    no amendment is needed there: an off-topic or linguistic message is handled
    first and the conversation is then steered back, with no hard refusal. A
    direct learner question is therefore answered before any re-anchoring, and
    the re-anchor never overrides it.
  - **Still open:** (c) how many model calls per learner message is acceptable;
    (d) how drift is detected and quantified, and how large the drift allowance
    is; (e) where the workflow graph is stored, versioned, and reviewed (the
    LangGraph graph source, plus any diagram); (f) the full branch set. Existing
    `AGENT.md` rules win on every point not yet decided.
- **Merged as:** Merged 2026-09-20 into `AGENT.md` §18.2 (per-message workflow),
  plus the earlier control-flow decision in §2.1 and §6.3. The open items (c)–(f)
  were carried across as the TODO in §18.2, not resolved.

### IDEA-0007 — LangGraph backend with Discord-first chat frontends (architecture reversal)
- **Status:** Merged
- **Date:** 2026-09-20
- **Author:** maintainer decision
- **Idea:** The engine is a **LangGraph backend** running in a server host,
  exposed to **pluggable chat frontends**: **Discord first**, then branching to
  **Telegram**, a **website**, and eventually **thin clients on phones**. The
  phone is never the engine; every frontend talks to the same backend.
- **Why:** LangGraph has no Kotlin Multiplatform or native-mobile target, so it
  cannot run inside a portable on-device core; its supported shape is a server.
  Bot platforms also *require* a reachable server by nature, so a backend is not
  a compromise for Discord and Telegram — it is the only workable shape. This is
  also the prior art already cited in §2: one dispatcher normalizing bot
  `Update`, HTTP, and WebSocket so business code stays transport-unaware.
- **Frontend order:** Discord (v1) → Telegram → website → phone thin clients.
  Channels are added one at a time, each as a driving adapter outside the core
  (§3), never by touching the domain.
- **Touches:** §1, §2 (prior art), §2.1, §2.2, §3, §4, §5, §6.1, §6.5, §7.1,
  §7.2, §8, §9, §10, §11, §12.4, §12.7, §15.
- **Conflicts:** this reverses the project premise, so they are large.
  - **§1 "there is no server-side application tier that owns the user's state"
    and the device-data promise.** Directly reversed: the server now owns
    learner state. §1 must be rewritten.
  - **§7.1 invariant "Local-first stack, remote model."** An invariant is being
    changed, which §7 permits only on an explicit maintainer request — this is
    it.
  - **§2.2**, which conditions exactly this change on "an explicit maintainer
    decision". Granted. Both §2.2 and §2.1's "Do not build on LangGraph" must be
    updated to record it.
  - **§5 "Decision (v1): remote model, local-first stack"** and "a server host
    is a convenience, not an authority". The server host is now the authority.
  - **§3 host diagram, §4 guard rails, §10.** All three exist because the core
    must be embeddable in a phone app. That constraint is dropped — the phone no
    longer embeds the core — so §10's governing constraint and §4's rationale
    ("nothing will notice when portability breaks") need restating. The §4
    mechanical boundary check may still be worth keeping, but for a different
    reason.
  - **§6.1 "the authoritative store is the learner's device"** and **§6.5 "a
    bundled default class must work with no network"** become server-side
    statements.
  - **§12.7 sensitive learner data + §15 auth.** Moving conversations and
    progress to a server creates privacy, auth, data-placement, retention, and
    hosting-cost obligations that did not exist when the data stayed on device.
  - **§5 "There is no fully offline mode."** Still true for conversation, but
    the reason changes: the client is now useless without the server, not merely
    without the model.
  - **§1 "front ends are deliberately deferred" vs. a Discord-first v1.** The
    only usable v1 surface *is* the Discord bot, so either that channel adapter
    lives in this repo (permitted — it is a driving adapter, §3) or v1 ships no
    way for a learner to reach the engine. Resolve the contradiction.
  - **Learner-facing consequence:** the "your data stays on your device"
    guarantee can no longer be made. That is a product decision, not just a
    technical one.
  - **§5 "v1 host scope … Do not start with three."** The phased plan is
    compatible with this only if **Discord alone ships in v1**; Telegram, the
    website, and phone clients are later, and each channel is an adapter rather
    than a new host.
  - **New dependencies (§12.4).** Discord and Telegram bot libraries plus a
    transport layer are new dependencies, which §15 makes ask-first.
  - **§12.7 secrets.** Bot tokens are per-host environment secrets and never
    enter the repo — the rule that covered the model API key now covers every
    channel.
  - **Cross-channel learner identity (new).** One learner may arrive on Discord,
    then Telegram, then the website. §6.4 pins *knowledge-point* identity but
    says nothing about *learner* identity across channels; without explicit
    linking, progress fragments per channel.
  - **§7.2 "Chat is the entire interface."** Satisfied naturally by Discord and
    Telegram. The website and phone clients must not introduce forms or a
    progress dashboard and break it.
- **Resolution:** **Merged 2026-09-20 by maintainer instruction.** The decided
  architecture (LangGraph backend, Discord first, then Telegram, website, phone
  thin clients) is now normative in `AGENT.md`. Remaining decisions, carried into
  `AGENT.md` as TODOs: (a) is the server host self-hostable, and
  what is the default deployment? (b) what is stored server-side and what, if
  anything, stays on the device? (c) auth and **cross-channel learner identity** —
  how are Discord, Telegram, web, and phone accounts linked to one learner? (d) do
  the model adapter/provider choices change? (e) is §4's boundary check retained,
  and for what reason? (f) how are §1 and §7.1 rewritten — is "local-first"
  removed, or redefined as "self-hostable"? (g) how much of the §2 prior art
  (one dispatcher for bot `Update`, HTTP, WebSocket) is adopted as-is rather than
  reinvented? Existing `AGENT.md` rules win on every point not yet decided.
- **Merged as:** Merged 2026-09-20 into `AGENT.md` §1, §2.1, §2.2, §3, §4, §5,
  §6.1, §6.6, §7.1, §7.10, §9, §10, §11, §12.7, §15, and §16. The open items
  (a)–(g) were carried across as TODOs in §5, §6.6, and §10, not resolved.
