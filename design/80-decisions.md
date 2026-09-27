# 80 — Decision log

> Specification of *what has been decided*, with dates and status. A decision
> here is normative only when its status is `DECIDED`. `PROPOSED` entries are
> defaults in code that the maintainer has not confirmed; `OPEN` entries are
> unresolved and must not be built on as if settled.
>
> Status values: `DECIDED` · `PROPOSED` · `OPEN` · `DEFERRED` · `SUPERSEDED`.
> Every design change adds or updates a row here (`design/00-index.md`).

## 1. Register

| ID | Date | Decision | Status |
|---|---|---|---|
| D-001 | 2026-09-20 | Conversation workflow runs on **LangGraph** | DECIDED |
| D-002 | 2026-09-20 | Engine is **server-side**; channels are clients. Replaces the earlier local-first plan | DECIDED |
| D-003 | 2026-09-20 | Channel order: **Discord → Telegram → website → phone thin clients** | DECIDED |
| D-004 | 2026-09-20 | Learner data lives on a **self-hostable server**; no claim of on-device data | DECIDED |
| D-005 | 2026-09-25 | Language **TypeScript**, Node ≥22, ESM | DECIDED |
| D-006 | 2026-09-25 | **pnpm** + `tsx` + `tsc --noEmit` | DECIDED |
| D-007 | 2026-09-25 | **vitest** as the test framework | DECIDED |
| D-008 | 2026-09-25 | Storage: **SQLite via `node:sqlite`**, single engine for v1 | DECIDED |
| D-009 | 2026-09-25 | Model transport: **OpenAI-compatible `/responses` over `fetch`**, no provider SDK | DECIDED |
| D-010 | 2026-09-25 | Default model: **DeepSeek official API, `deepseek-flash`** | DECIDED |
| D-011 | 2026-09-25 | Validation of untrusted model output: **`zod` in `core/`** | DECIDED |
| D-012 | 2026-09-25 | Boundary enforcement: **purpose-built scanner**, not dependency-cruiser | DECIDED |
| D-013 | 2026-09-25 | On-device alternatives (**Koog**, **MobileGraph**) are | SUPERSEDED |
| D-014 | 2026-09-25 | Knowledge-point ID scheme: `kp_` + 16 hex of a SHA-256 of canonical content | PROPOSED |
| D-015 | 2026-09-25 | Steering weights: `3·due + 2·struggle + 1·new + 1·consolidating`, top 5 | PROPOSED |
| D-016 | 2026-09-25 | Turn contract (`TurnDecision`, `AnswerResult`, `ContinuationResult`) and the four-branch set | PROPOSED |
| D-017 | 2026-09-25 | Graph checkpointing store and resumability point | DEFERRED |
| D-018 | 2026-09-25 | Persisting a learner-supplied model credential | OPEN |
| D-019 | 2026-09-25 | Built-in German A1–C2 library: Goethe/telc-derived content; accepted copyright risk; C1/C2 fallback open | DECIDED (risk accepted) |
| D-020 | 2026-09-25 | Git conventions, formatter, linter | OPEN |
| D-021 | 2026-09-26 | **Design-docs-first**: `design/` is the specification; `AGENT.md` holds process only | DECIDED |
| D-022 | 2026-09-27 | **Level = class**: one class per (target language, CEFR level); a chapter is `unit`/`unit_order` on points plus a learner cursor; learner settings persist the choice | DECIDED |
| D-023 | 2026-09-27 | **Onboarding**: deterministic, model-free, asked in chat; text-only in v1 | DECIDED |
| D-024 | 2026-09-27 | **Previous-level review pool**: the steering scope spans included levels; background-point rule; unit-order tie-break; weights unchanged | DECIDED |
| D-025 | 2026-09-27 | **Custom levels and document upload**: personal classes; pdf/docx/pptx/txt fitted by the model into knowledge points | DECIDED |
| D-026 | 2026-09-27 | Channel-agnostic **"choices" contract** for select menus | DEFERRED |
| D-027 | 2026-09-27 | **Answer language**: a `question` or `kp_question` answer is written in the class's source language (English for the shipped German and Chinese classes); the surrounding conversation stays in the target language | DECIDED |
| D-028 | 2026-09-27 | **Deployment pathway**: one Linux host under **systemd** (unit template + installer in `deploy/`); one process per bot token and per database; `.env` secrets; containers deferred | DECIDED |
| D-029 | 2026-09-27 | **Compiled production artifact** — run without `tsx` and install with `pnpm install --prod` | DEFERRED |
| D-030 | 2026-09-27 | **First question after setup**: when onboarding completes, the graph's `open` node starts the first session and asks the first question; onboarding stays model-free with a confirmation fallback | DECIDED |
| D-031 | 2026-09-27 | **Re-ask the question on the table**: `TurnDecision.answered_previous_question`; a clear attempt counts as answered even when wrong, anything else answers then repeats the same question | DECIDED |
| D-032 | 2026-09-27 | **New conversation entry point**: `/new` (alias `/start`) ends the question on the table and opens a fresh session whose opening asks a new question; no steering or graph change | DECIDED |
| D-033 | 2026-09-27 | **One language per model call**: `classify` always writes no prose, `answer` writes the source language (target for drift), and `continue_turn` writes the target language and runs only when the learner answered; the app composes the reply with the question last | DECIDED |
| D-034 | 2026-09-27 | **Telegram channel**: Bot API over `fetch` (no SDK), long polling, private chats only, full Discord parity; one server process serves every configured channel; one linked channel per learner, no automatic cross-channel merge | DECIDED |
| D-035 | 2026-09-27 | **Chinese built-in library**: derived from the 2021 Chinese Proficiency Grading Standards (GF 0025-2021); CEFR mapping A1=bands 1–2, A2=3, B1=4, B2=5, C1=6, C2=7–9 is an unofficial estimate; derive-and-attribute, no list vendored; B1–C2 bundles and the 2025 exam-syllabus edition open | PROPOSED |
| D-036 | 2026-09-27 | **Access approval**: an unapproved channel identity creates a pending request — no learner, no workflow, **no model call**; an operator approves or denies at the CLI (`pnpm admin`, `--json` for tool calling); a display label is stored for operator review only; existing links are grandfathered; revoking drops the link but keeps the learner | DECIDED |

## 2. Notes on the load-bearing decisions

### D-001 / D-002 — LangGraph, server-side

LangGraph ships for Python and JS only, with no on-device target. Rather than
abandon a graph workflow, the architecture moved the engine server-side, where
LangGraph is strongest and where chat platforms (Discord, Telegram) require a
reachable server anyway. The cost is explicit: **the local-first and offline
promises are withdrawn** ([10-overview.md §3.2](10-overview.md)).

### D-008 — SQLite only

PostgreSQL is a future option, never a parallel dialect. Supporting two dialects
would double the migration and testing surface for no v1 benefit. Revisit only
with a scaling requirement.

### D-011 — `zod` is the core's only external dependency

The core may import `zod` and nothing else. That single allowance keeps
untrusted-input validation inside the domain instead of in adapters, where it
would be duplicated per channel. Widening it requires a decision row here.

### D-012 — why not dependency-cruiser

It was tried first and rejected: under this TypeScript/ESM setup it resolved
relative imports but **silently dropped bare imports** such as
`@langchain/langgraph`, so the SDK rule could never fire while the check
reported success. A check that cannot fail is worse than no check. The
replacement (`tools/boundary-scan.ts`) was proven by planting a deliberate
LangGraph import inside `core/` and watching it fail.

### D-014 / D-015 / D-016 — the product's actual logic

These are the rules `AGENT.md` originally left undefined: knowledge-point
identity, steering weights, and the turn contract. They are **implemented**, so
they now describe real behavior even though the maintainer has not formally
confirmed them. Confirming them is cheap; changing them after learner history
exists is expensive. See `MVP.md` §5.1–5.4 for the full proposal text.

### D-017 — checkpointer deferred

The PoC reconstructs state from its own turn tables and compiles the graph
without a checkpointer. That is sufficient while every turn is self-contained. A
checkpointer becomes necessary when graph state must be resumable mid-workflow —
for example a long-running fit, or a human-approval pause. Until then, adding one
would duplicate state that storage already owns.

### D-019 — German library: decided with an accepted risk

The maintainer chose Goethe-derived content. Goethe publishes Wortlisten for A1,
A2, and B1 (plus the DTZ list), and telc publishes lesson-organized B2-Beruf
Wortschatzlisten; **no exam body publishes a C1/C2 word list** — Goethe's own C2
handbook points at the commercial *Profile deutsch A1–C2 v2.0*. The library
therefore ships derived points only: our own titles and explanations,
`raw_source` pointers, and attribution, with no source PDF vendored. That is a
copyright risk the maintainer accepted, not a clean licence. The **C1/C2
fallback remains open** — frequency bands plus CEFR descriptors, validated
against the ÖSD C1 and Goethe C2 model papers — and stays a TODO in
[60-ingestion.md §3](60-ingestion.md).

### D-022 / D-023 — level is a class; onboarding decides it

One class is one (target language, CEFR level). A chapter is not a class: it is
`unit`/`unit_order` on the knowledge points plus `known_through_unit` in learner
settings, and the current chapter is derived from the counters rather than
stored. First-run onboarding asks language, then level, then optionally a
starting chapter, deterministically and without a model call, so it still works
when no model key is configured. Later changes are chat commands; text-only in
v1. See [30-domain-model.md §8](30-domain-model.md) and
[50-orchestration.md §1](50-orchestration.md).

### D-024 — the review pool and the unit tie-break

Including a previous level widens the steering scope but not the class: the pool
is the current level plus the included levels, deduped by knowledge-point id.
Unseen points outside the current level's cursor are background (score 0) until a
counter exists, which lets cross-level review use real history without dumping an
earlier level into a new learner's first session. The tie-break becomes
`(score, unit_order, id)` so new material arrives in chapter order. The four
weights and the top-5 list are unchanged. See
[40-steering.md §2](40-steering.md).

### D-025 — personal material and the fitting pipeline

A custom level is a personal class; its mapping is its set of knowledge points.
Uploaded documents (pdf, docx, pptx, txt) are extracted by an adapter behind a
document port, and the model proposes knowledge points that the core validates
and gives ids to. Uploaded text is learner data and is sent to the configured
provider; token or page caps and a per-learner rate limit bound the cost. Scanned
PDFs without a text layer are out of scope. The PoC wires the text and markdown
adapter only; the pdf/docx/pptx libraries are the ask-first TODO in
[70-stack.md §1](70-stack.md). See
[60-ingestion.md §5](60-ingestion.md).

### D-026 — menus are deferred, not rejected

The "chat is the entire interface" invariant
([20-architecture.md §4.2](20-architecture.md)) rules out Discord select menus
for v1. A channel-agnostic choices contract — the core returns options and each
frontend renders them as menus or as text — would preserve the core boundary and
is parked here. Adopting it requires rewording §4.2 and adding per-channel
rendering tests; no design doc changes for it now.

### D-028 / D-029 — deployment is a systemd unit, not a container

The deployable artifact is a systemd unit plus a one-file installer, because the
target host already runs systemd and this adds no runtime dependency. The
**contract** in [75-deployment.md §1](75-deployment.md) is deliberately
platform-neutral — one process per bot token and per database, no inbound
listener, graceful `SIGTERM`, `.env` secrets, `var/` for learner data — so a
container or orchestrator can satisfy it later without touching the engine.
Containers are deferred until a deployment target actually needs them.

`tsx` is a dev dependency that the server currently uses as its runtime
(`pnpm start`), so the v1 install includes dev dependencies. Compiling to a
production artifact and installing with `pnpm install --prod` is D-029: a real
improvement, deferred because it adds a build step the PoC does not need yet.

### D-030 / D-031 — the conversation starts itself and stays on one question

The learner no longer has to write first: finishing onboarding starts the first
session in the same reply, so the app asks the first question. Onboarding itself
stays deterministic and model-free (D-023), and the opening is best-effort — a
provider failure falls back to the setup confirmation rather than a failure
message, so a deployment with no model key still completes setup.

Once a question is on the table, the conversation does not move past it until the
learner answers or attempts an answer. The model reports
`answered_previous_question` with every turn; a clear attempt counts as answered
even when the language is wrong, while asking a question, saying "I don't
understand", or drifting does not. On a non-answer the reply handles what the
learner said and then repeats the same question, in the same words — the answer
from its own call and the repeat from the app (D-033). This changes the earlier
behavior where a `question` or `kp_question` turn answered and then moved on to a
different question. See [50-orchestration.md §3.3](50-orchestration.md).

### D-032 — a learner can start a new conversation

D-031 left the learner with no way past the question on the table except
answering it. `/new` (alias `/start`) is that way, and it is the learner's
decision, not the model's: the command is recognised before the turn graph runs,
abandons the question on the table, and opens a session immediately.

The new opening is a **new question**. The question being left behind is passed
to the opening prompt, marked as untrusted material, with the instruction not to
repeat or rephrase it. This is deliberately *not* a steering change: target
selection (`selectTargets`, [40-steering.md §4](40-steering.md)) is untouched,
and the weights stay ask-first (`AGENT.md` §5). The prompt is versioned
`opening-v2`, and scheduled openings keep their existing "the learner did not ask
for this" framing.

Before onboarding completes, `/new` behaves like a scheduled start and returns
the pending onboarding question rather than opening a session. See
[50-orchestration.md §1–§2.1](50-orchestration.md).

### D-033 — one language per call

The model used to write the whole learner-facing reply in one call, so a turn
that both answered a question and continued the conversation asked it to switch
from the source language to the target language mid-message. In practice it
sometimes answered in the target language, which is the one thing the answer is
supposed to avoid (D-027). The same applied to a correction: woven into the
target-language continuation, it came out in German rather than the source
language.

The turn is now three calls, each single-language. `classify` always runs and
writes no prose at all: it returns the branch, the corrections, the progress
signals, and `answered_previous_question`. `answer` runs for a question, an
incorrect attempt, or drift: it writes the source language for a question or a
correction, and the target language for drift. `continue_turn` runs **only when
the learner answered** and writes the target language; it does not repeat a
correction, which the answer call has already explained in the learner's own
language. The app composes the message from those parts with the question last,
which is also how the next turn finds the question on the table. The cost is one
extra call on most turns; the benefit is that the language boundary is a call
boundary, not something the model has to hold. See
[50-orchestration.md §3.5](50-orchestration.md).

### D-034 — Telegram, and what "one process" means with two channels

Telegram is channel #2 (D-003), and the maintainer chose the smallest dependency
surface that works. **The adapter speaks the Bot API directly over `fetch`**,
behind a `TelegramTransport` interface, with **no channel SDK** added to the
lockfile. Discord keeps `discord.js` because its gateway is a stateful protocol
where a library earns its place; Telegram's Bot API is a plain HTTPS/JSON
endpoint, so the adapter follows the same no-SDK discipline as the model adapter
([20-architecture.md §5](20-architecture.md)). Transport is **long polling**
(`getUpdates`), which preserves the no-inbound-listener contract
([75-deployment.md §1.2](75-deployment.md)); a webhook is not used. The channel
ships at **full parity with Discord** — text turns, `/new`/`/start`, the settings
commands, document uploads, and `/model` — and only in **private chats**: a group
would put several people behind one `learner_id`.

The runtime reading of "one instance per bot token and database" is **one server
process that starts every channel whose token is configured**, sharing one
engine, storage, and scheduler ([72-channels.md §4](72-channels.md)). The
scheduler was already started once and resolves `learner_id` → channel identity,
so it did not need a channel dimension.

**Cross-channel identity stays explicit, and v1 still creates one learner per
first contact.** The maintainer chose that the same person on Discord and
Telegram is two learners until an explicit linking feature exists; no merge is
guessed. That keeps access control true by construction
([30-domain-model.md §6–7](30-domain-model.md)) and leaves account linking as a
future feature with its own design (proof of ownership on both channels, and a
merge story for two progress records).

### D-035 — Chinese: the 2021 standard with an unofficial CEFR mapping

Chinese is the second built-in language, so the questions D-019 answered for
German had to be answered again, and one of them has no clean answer.

**Source.** Level content derives from the *Chinese Proficiency Grading Standards
for International Chinese Language Education* (《国际中文教育中文水平等级标准》,
GF 0025-2021), issued by the Ministry of Education and the State Language
Commission and effective 2021-07-01. It is the authoritative, official framework:
three stages and nine bands, with a 音节表 (syllables), 汉字表 (characters),
词汇表 (vocabulary), and 语法等级大纲 (grammar). Its cumulative counts — 500 /
1272 / 2245 / 3245 / 4316 / 5456 / 11092 words, 300 characters per band to 1800
then 3000, and 48 / 129 / 210 / 286 / 357 / 424 / 572 grammar points — are the
level sizes. Chinese Testing International's HSK 3.0 syllabus is the exam-facing
document derived from it; its November 2025 revision changes the per-band counts
(about 300 / 500 / 1000 / 2000 / 3600 / 5400, then 11000), and which edition the
bundles follow is still open.

**The mapping is the risk, and it is not official.** The repo has six CEFR
classes per language, and the mapping chosen is A1 = bands 1–2, A2 = band 3,
B1 = band 4, B2 = band 5, C1 = band 6, C2 = bands 7–9. It is a widely published
third-party alignment and it uses every band once, which makes it the practical
choice. It is **not** an equivalence the test authority publishes: the standard's
own 三等 framework puts bands 4–6 in 中等 and 7–9 in 高等, and the published
third-party charts already disagree at band 2. The status is therefore `PROPOSED`,
the mapping must not be shown to a learner as official, and building on it after
learner history exists is the point at which it should be re-confirmed.

Bands 7–9 are published as one merged word list, so Chinese C2 is that whole
band. Unlike German, no C-level source is missing; the open questions are only
which HSK edition to track and when to build B1–C2. The licensing stance is
D-019's, unchanged: derived points only, our own titles and explanations,
`raw_source` pointers, attribution in `datasets/builtin/README.md`, and no source
list vendored. The PoC ships hand-authored **Chinese A1 and A2** seeds. See
[60-ingestion.md §3.2](60-ingestion.md).

### D-036 — access approval is a spend control

A bot that anyone can find is a bot that scanners will find, and **every useful
conversation contains a billed remote model call**
([20-architecture.md §5](20-architecture.md)). The maintainer's requirement was
therefore not "moderate the chat" but "no LLM-calling workflow runs for someone
an operator has not approved". The rule and its mechanics are
[74-access.md](74-access.md).

**No learner until approval.** First contact creates a `pending` request keyed by
(channel, numeric id) and nothing else — no learner row, no link, no settings, no
schedule — so an attacker cannot even bloat the learner tables. This is why the
gate lives *before* identity provisioning rather than as a flag on an existing
learner.

**Approval happens at the CLI.** `pnpm admin` (`hosts/admin/`) opens the same
database and needs no network: `pending`, `list`, `approve`, `deny`. Approval is
what creates and links the learner. Every subcommand takes `--json` and prints one
JSON document, so a tool-calling operator can drive it; the human path prints a
table. The decision takes effect on the learner's next message, because the admin
host holds no channel connection.

**Enforcement is two layers**, because a missed gate is a bill: the channel
adapters answer unapproved identities before the engine
(`frontends/access.ts`), and `guardEngine` (`engine/access-guard.ts`) wraps every
engine entry point in the server host so the scheduler and any future caller
cannot reach the model port either. The guard is why a learner revoked *after*
onboarding still cannot be woken by the scheduler.

**One narrow amendment to §6.** A mutable display label is stored on the pending
request so the operator can recognise the person. It is not a key, not a lookup,
and not copied into the link or any domain record; the storage key stays the
platform's numeric id.

**Revocation keeps history.** Denying removes the channel link but never the
learner: progress is keyed by `learner_id`, and re-approval re-links the same
learner. **The upgrade grandfathers existing links** as approved, so nobody using
the bot before this change is locked out.

Left open and recorded in [74-access.md §9](74-access.md): rate-limiting pending
requests, proactive approval notification, operator roles and an audit log, and
admin authentication beyond local database access.
