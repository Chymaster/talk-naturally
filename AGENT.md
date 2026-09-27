# AGENT.md

Process rules for AI coding agents working in **talk-naturally**.

> **The design documents are the specification.** This file tells you how to
> work; [`design/`](design/00-index.md) tells you what to build. Read
> [`design/00-index.md`](design/00-index.md) before writing code.
>
> This file holds process only. Product and architecture rules live in `design/`.
> Keep this file short.

---

## 1. Start here

| To understand… | Read |
|---|---|
| What the product is, deployment, v1 scope | [`design/10-overview.md`](design/10-overview.md) |
| The core boundary, ports, invariants, model port | [`design/20-architecture.md`](design/20-architecture.md) |
| Classes, levels, knowledge points, progress, learner settings, identity, access | [`design/30-domain-model.md`](design/30-domain-model.md) |
| Which knowledge point to work on next | [`design/40-steering.md`](design/40-steering.md) |
| Sessions and the per-message LangGraph workflow (**diagram**) | [`design/50-orchestration.md`](design/50-orchestration.md) |
| Where learning material comes from | [`design/60-ingestion.md`](design/60-ingestion.md) |
| Stack, layout, commands, testing rules | [`design/70-stack.md`](design/70-stack.md) |
| Dated decisions and their status | [`design/80-decisions.md`](design/80-decisions.md) |
| Where ideas are staged before they become rules | [`design/90-ideas.md`](design/90-ideas.md) |

Human-facing setup lives in [`README.md`](README.md). [`MVP.md`](MVP.md) is the
proof-of-concept build report — a status record, **not** a specification.

## 2. Design docs come first (the core rule)

**No feature or behavior change is implemented before it exists in a design
doc.** Code is written *from* the design docs.

The order is fixed:

1. **Idea** — if the change is not yet agreed, stage it in [`idea.md`](idea.md)
   ([`design/90-ideas.md`](design/90-ideas.md)).
2. **Design** — edit the affected document under `design/`. State what changes
   and what it replaces. Delete the old rule; never leave two contradictory
   statements.
3. **Decision** — add or update a row in
   [`design/80-decisions.md`](design/80-decisions.md) with date and status.
4. **Code** — implement it, with tests, citing the design section in the code.
5. **References** — update anything that pointed at the old rule, including code
   comments, `README.md`, and the diagram if you changed the graph.

What this forbids:

- **No code-first features.** If you find yourself implementing something the
  design docs do not describe, stop and write the design first.
- **No silent behavior change.** A prompt change, a graph change, a steering
  weight, or a schema change is a design change.
- **No spec in this file.** If you are tempted to add a product rule here, it
  belongs in `design/`. This file stays about process.
- **No building on a `TODO`.** A `TODO:` line is an open question, not a rule.
  Ask before implementing one.

If code and a design doc disagree, **the design doc is right and the code is a
bug** — unless the maintainer says otherwise, in which case update the doc.

### 2.1 What "done" means for a design change

- The affected `design/` document is updated and internally consistent.
- Superseded text is **deleted**, not just contradicted further down.
- `design/80-decisions.md` has a row if a real decision was made.
- Cross-references still resolve (`design/NN-*.md §X`).
- If the workflow graph changed, [`design/turn-graph.mmd`](design/turn-graph.mmd)
  and the diagram in [`design/50-orchestration.md`](design/50-orchestration.md)
  were updated in the same change, and `tests/design-conformance.test.ts` passes.

## 3. Ideas are staged in `idea.md`

- Unreviewed ideas go to [`idea.md`](idea.md), **never** straight into `design/`
  or this file. It is non-normative; nothing in it is a rule.
- **Capture first, merge later.** Record an `IDEA-nnnn` entry; do not edit a
  design doc in the same step.
- **Conflicts surface at merge time.** Scan the idea against other open ideas and
  the design docs it touches, and record each conflict plus its resolution.
  "None found" is an explicit result.
- **Resolve before merging.** Two contradictory ideas must not both be merged.
- **While an idea is undecided, the design docs win.**
- A merge can carry TODOs; the entry must say so. See
  [`design/90-ideas.md`](design/90-ideas.md) for the full workflow and where each
  kind of idea lands.

## 4. Working agreement

1. **Read before writing.** Read the relevant design doc and the surrounding
   code first; match existing conventions.
2. **Verify before claiming done.** Run `pnpm verify` (typecheck + boundary +
   tests). If you cannot run it, say so plainly — never report untested work as
   working. There is **no linter or formatter configured**, so do not claim a
   lint or format run that did not happen.
3. **Small, focused changes.** One logical change at a time. No drive-by
   refactors or reformatting.
4. **Ask before hard-to-reverse decisions.** New dependency, stack or provider
   change, storage schema, knowledge-point ID scheme, steering weights, the model
   port, prompt- or graph-behavior change — ask first.
5. **Protect the core boundary.** Before adding an import to `core/`, check it
   against [`design/20-architecture.md §2`](design/20-architecture.md). Channel
   SDK, transport, storage-driver, HTTP-client, provider-SDK, and LangGraph
   imports in the core are bugs, not style issues. `zod` is the core's only
   allowed external package.
6. **Don't reinvent the pattern.** For anything structural — hosts, adapters,
   composition roots, channel dispatchers, testing seams — follow the Ports and
   Adapters practice in [`design/20-architecture.md §1`](design/20-architecture.md).
7. **Treat learner data as sensitive.** Conversations, classes, and progress are
   personal data stored on a server. No secrets in the repo; model API keys and
   **channel bot tokens** come from the host environment, never from the core.
   Document required variable *names* in `README.md`, never values. Do not log
   full conversations at info level. Be explicit about what is sent to the remote
   model and what is retained on the server.
8. **Do not commit unless asked.** Leave changes for review.
9. **Report honestly.** State what changed, what you verified, and what is still
   uncertain or deferred.

## 5. Boundaries — ask before touching

- Lockfiles and dependency manifests.
- Database migrations and anything destructive to learner progress or
  conversations.
- The knowledge-point ID scheme ([`design/30-domain-model.md §4`](design/30-domain-model.md))
  and steering weights ([`design/40-steering.md §4`](design/40-steering.md)) once
  data exists — changing either silently corrupts or shifts learner history.
- The model port and the `capabilities` set
  ([`design/20-architecture.md §5`](design/20-architecture.md)) — every host and
  adapter depends on it.
- Prompt files and LangGraph graphs once conversations depend on them (reviewed
  artifacts).
- Auth, learner-identity linking, rate limiting, and spend/cost controls.
- The access-control model, the `learner_id` anchor, and the channel
  identity/link table ([`design/30-domain-model.md §6–7`](design/30-domain-model.md)).
- Channel credentials — Discord/Telegram bot tokens, webhooks — and the server's
  deployment configuration.
- The learner-data retention, logging, and backup policy.
- Any generated or vendored code, including built-in datasets.
- Document-parsing dependencies for the upload pipeline (pdf/docx/pptx
  extractors) and where they may live — adapters only
  ([`design/60-ingestion.md §5`](design/60-ingestion.md)).
- The onboarding question set and the level catalog: which languages and levels
  exist, their order, and the wording of the questions
  ([`design/60-ingestion.md §3`](design/60-ingestion.md)).
- Uploaded learner documents: what formats are accepted, what text is sent to the
  model provider, and what is retained
  ([`design/60-ingestion.md §5`](design/60-ingestion.md)).

## 6. Git conventions

TODO — the maintainer has not decided these.

- Default branch: TODO
- Branch naming: TODO
- Commit style: TODO (Conventional Commits is a fine default)
- PR expectations: TODO

Existing history uses short, typed subjects (`feat(core):`, `docs:`, `test:`).

## 7. Definition of done

For a **code** change:

- [ ] The behavior is described by a design doc, and that doc is updated if this
      change altered it (§2).
- [ ] `pnpm verify` passes (typecheck + boundary + tests), or the reason it could
      not run is reported.
- [ ] No live model call is required for the test suite to pass.
- [ ] No channel SDK, transport, storage-driver, HTTP-client, provider-SDK, or
      LangGraph dependency in the core.
- [ ] No channel-specific concept leaked into the domain, and adding a channel
      did not change existing behavior.
- [ ] Progress updates are idempotent and attributable to knowledge-point IDs.
- [ ] Steering decisions are logged with a reason.
- [ ] Learner identity is explicit; no two channel identities are silently
      merged.
- [ ] Access to another learner's material or progress is impossible by
      construction.
- [ ] No claim of offline conversation support, and no claim that learner data
      stays on the learner's device.
- [ ] Code comments cite `design/NN-*.md §X`; no reference points at a section
      that no longer exists.
- [ ] `README.md` updated if commands, layout, or behavior changed.
- [ ] Final response summarizes what changed and how it was verified.

For a **design** change, see §2.1.
