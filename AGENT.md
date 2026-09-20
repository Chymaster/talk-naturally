# AGENT.md

Instructions for AI coding agents working in **talk-naturally**.

> This file is the single source of truth for how agents should work here.
> Keep it short — delete any rule not worth enforcing.

---

## 1. Project overview

**talk-naturally** is a language learning assistant. The learner imports the
material they are already studying (e.g. *"German A1.2, chapter 8 — talking
about how to get to places; vocabulary: …; grammar: …"*) and then simply
**converses** with the agent about that material. The agent steers the
conversation so that the learner naturally uses the vocabulary and grammar they
are meant to be learning, and answers grammar questions along the way.

**Core product promise:** the learner never has to manage the admin of
learning. No flashcard decks to maintain, no session planner, no progress
bookkeeping. They show up, talk, and the software does the rest.

**What we are building: one server-side engine, driven by pluggable chat
channels.** The repository produces a **backend** (conversation orchestration,
class datasets, progress, steering) built on **LangGraph**, plus the **adapters**
that expose it to chat channels. The same engine backs every channel: **Discord
first**, then Telegram, a website, and eventually thin clients on phones.
Channels are added one at a time and never change the domain. See §5 for the v1
scope and §2.2 for why the engine is server-side.

**The engine is server-side; learner data lives on the server.** All application
logic, and the learner's classes, conversations, and progress, live in a
**server host** — a self-hostable process, so the operator controls the data.
There is no on-device engine and no local-first mode: a client must reach the
server to converse. **The language model is remote** and is reached as a
dependency behind an interface (§8). Concretely:

- the learner's classes, conversations, and progress are stored **on the
  server**, not on the device;
- the engine runs **in the server host**, which is the authority for learner
  state (§2.2);
- one external dependency — the model provider — is called over the network.

## 2. Prior art — this is a solved, well-known pattern

**This architecture is not novel, and we should not invent our own version.**
It is **Ports and Adapters**, aka **Hexagonal Architecture** (Alistair
Cockburn): the domain is isolated from external systems and communicates only
through interfaces (ports), which concrete adapters implement. Its defining
property is precisely our requirement — the same core can be driven by an HTTP
API, a CLI, a bot, a message queue, or a test client, and *adding a channel
means writing one adapter, never touching the domain.*

Guidance to follow rather than reinvent:

- **Ports belong to the core**; adapters implement them. Dependency always
  flows inward. Wiring happens only in a **composition root** (the host's entry
  point) — never inside core logic. No core class may construct its own
  adapter.
- **Keep the boundary even though the engine is now server-side.** The domain
  must not learn about Discord, Telegram, HTTP, the database, or the model
  provider; those live in adapters and the composition root (§3).
- **Enforce the boundary with tooling, not discipline.** Projects in this space
  commonly run a dependency-graph linter in a pre-push hook so a crossed layer
  boundary fails the build. See §4.
- **The reference implementation for our channel layer** is a Telegram+web
  platform that normalizes bot `Update`, HTTP, and WebSocket into one dispatcher
  so business code stays transport-unaware. That is exactly the shape Discord
  (v1), Telegram, the website, and the phone clients should share (§5) — read it
  before designing the dispatcher.

### 2.1 The engine is LangGraph, and it is server-side

**Decision: the conversation workflow is built on
[LangGraph](https://github.com/langchain-ai/langgraph).** LangGraph ships for
**Python and JS only** — no Kotlin Multiplatform, no native mobile — so it
cannot run inside a phone app. That is precisely why the engine is server-side
(§2.2): the framework's supported shape and our architecture now agree.

The on-device alternatives were evaluated and are now **superseded, not rejected
on quality**:

- **Koog** (JetBrains) is Kotlin Multiplatform with graph strategies available
  on JVM, Android, iOS, JS, and WasmJS. It was the portable option while an
  on-device core was the plan; with the engine server-side it buys nothing we
  need.
- **MobileGraph** was already immature (`0.5.0-alpha`, Android-first) and is
  irrelevant for the same reason.

Rules that still apply:

- **Do not let LangGraph types leak into `core/`.** Wrap the engine behind the
  §3 boundary so the domain stays testable and the engine stays swappable.
- **The graph is code.** A LangGraph graph is a prompt-behavior artifact:
  versioned, reviewed in diffs, and treated with the same care as a prompt
  (§7.7).
- **Checkpointing is infrastructure.** LangGraph checkpointers live outside the
  domain, behind the storage port (§3).

General principle worth internalizing: *a framework is justified when the
orchestration logic exceeds what a plain state machine handles cleanly.* The
per-message decision workflow (§18.2) is that case — intent classification has
no deterministic derivation, so the model routes among authored branches.

### 2.2 The chosen shape: server-side engine, chat channels

The engine runs in a server host, and every learner-facing channel is a client
of it (§3). This was decided deliberately on 2026-09-20, replacing the earlier
local-first plan, because LangGraph has no on-device target (§2.1) and because
chat platforms such as Discord and Telegram require a reachable server anyway.

- **The server is the authority** for learner state, and it is
  **self-hostable**, so the operator controls the data (§5).
- **Channels are adapters.** Discord first, then Telegram, a website, and phone
  thin clients. Adding one must never touch the domain (§3).
- **The earlier local-first promise is withdrawn.** Do not claim that learner
  data stays on the learner's device (§16).

The part of our design that is *not* covered by prior art remains the domain
itself — class datasets, per-knowledge-point progress, and progress-driven
steering (§6). That is the actual invention here, and where engineering effort
should go.

## 3. Framework shape: core, adapters, hosts

```
Channels (driving adapters; see §5 for the order)
  Discord bot · Telegram bot · website · phone thin client · CLI
        │ HTTP / WebSocket / bot gateway
        ▼
Hosts (thin; composition root + adapters)
  server host (the authority)          CLI/dev host
  (core + LangGraph engine,            (core,
   server DB, remote model)             fake model)
        └───────────────┬───────────────┘
                        ▼
        CORE — channel-agnostic, engine-agnostic (§2: the hexagon)
          turn pipeline · class datasets · progress · steering
          ports: storage · model adapter · clock · ids · config
```

**The dependency rule: the core knows nothing about its host or its channel.**
It must not import platform, transport, channel, or provider SDKs. Concretely,
the core must not assume:

- **Channel.** No Discord/Telegram SDK, no bot framework, no webhook or HTTP
  server, no sockets. The core exposes plain function calls; a channel adapter
  translates to and from them.
- **Platform/host.** No OS-specific filesystem paths or APIs. The core runs
  in-process wherever the host puts it.
- **Storage engine.** No direct database driver calls. The core talks to a
  storage port; the host supplies the adapter.
- **Model.** No provider SDK and **no HTTP call inside the core**. The core
  depends on a model port; a remote adapter (§8) lives outside it.
- **Configuration source.** The core does not read environment variables or
  config files. It receives a config object from the host.
- **Clock, IDs, randomness.** Injected, so tests are deterministic and hosts
  can supply correct implementations.

**Hosts are thin.** A host wires up adapter implementations in one composition
root and exposes the core to a channel. If a host grows tutor logic, that logic
belongs in the core (or in the channel adapter, if it is really about the
channel).

## 4. Boundary guard rails

The pressure to cut corners on the §3 boundary is constant. Because the engine
is server-side, a Discord SDK call, a raw SQL query, or a provider HTTP request
will pass every test we run and only surface later as a domain that cannot be
tested, reused, or swapped. Treat this as the primary maintenance risk of the
project.

Required mitigations — a written rule alone will not survive a deadline:

- **Enforce the §3 boundary mechanically.** An automated check must fail the
  build when `core/` imports a channel SDK, transport, storage driver, HTTP
  client, provider SDK, or the LangGraph runtime. TODO: implement once the stack
  exists.
- **Keep a fake model adapter and in-memory storage exercising the full turn
  pipeline in tests.** If the domain cannot run against these with no network
  and no host, the boundary is broken.
- **Keep the core channel-agnostic.** A Discord- or Telegram-specific concept
  (guild, channel, thread, update id) must not appear in the domain; adapters
  translate.
- **Review new dependencies for boundary damage** before adding them. A
  convenient framework is the most common way this boundary dies.

## 5. Deployment modes and v1 scope

**Decision (v1): one server host, remote model, Discord as the only channel.**
The engine and learner data live on a server the operator controls; the model is
remote (§8). The server host is **self-hostable**, and "self-hostable" is the
data guarantee we can honestly make: data stays on infrastructure the operator
runs, not on the learner's device.

Channel order — add one at a time, each as a driving adapter (§3):

1. **Discord bot (v1).** The only channel shipped at first.
2. **Telegram bot.**
3. **Website.**
4. **Phone thin clients.**

Consequences:

- **A client cannot converse without the server.** There is no offline mode and
  no on-device engine. **Never claim offline conversation support, and never
  claim learner data stays on the learner's device.**
- **The server owns learner data.** Conversations, classes, and progress are
  personal data on the server. Auth, data placement, retention, and backups are
  real obligations, not accidents (§6.6, §12.7, §15).
- **The core must still not make network calls.** Reachability, retries, auth,
  and provider specifics belong to the remote model adapter (§8), behind the
  model port. The core stays pure and testable.
- **Do not start with every channel.** v1 is the server plus Discord. "Do not
  start with three" still applies to the surface area we maintain.

## 6. Class dataset and progress model

This is the heart of the core, and the part not covered by prior art (§2). A
**class** is a body of material (e.g. *German A1.2, chapter 8*). Each class has
a dataset of knowledge points grouped under three keys: **grammar**,
**sentence structure**, and **vocab**.

### 6.1 Structure

```
Class (imported, built-in, or personal material)
├── id, title, source language, target language, imported_at, origin
├── grammar[]            ─┐
├── sentence_structure[]  ├─ each entry is a Knowledge Point
└── vocab[]              ─┘

KnowledgePoint (stable identity — see §6.4)
├── id            # stable, deterministic
├── kind          # grammar | sentence_structure | vocab
├── title         # e.g. "Dativ: mit + dem/der"
├── detail        # explanation / example / translation as imported
└── raw_source    # pointer back into the source material for debugging

UserProgress (per learner × per knowledge point)
├── knowledge_point_id
├── times_seen    # introduced / model used it in a reply ("read")
├── times_used    # learner produced it themselves, unassisted
├── times_used_with_help   # produced after a hint or correction
├── times_wrong   # attempts judged incorrect
├── last_seen_at, last_wrong_at
└── notes         # short learner-specific observations
```

**Progress is per learner and per knowledge point.** Class material is shared;
progress against it is personal.

**Where data lives.** The authoritative store is the **server host**, which is
self-hostable (§5). A class can be shared or exported, and progress is personal:
it is never silently merged across learners. A learner's identity spans channels
— see §6.6.

**Keep raw counters, derive the rest.** Store countable facts
(`times_seen`, `times_used`, `times_wrong`, …). Do not store a `mastery` float,
a `confidence` score, or a `next_review_at` as the source of truth — compute
those from the counters so the reasoning stays inspectable and the formula can
change without losing history. A short `notes` string is fine to keep, but it
is a hint, not the model.

### 6.2 How progress is updated

- Updates happen **once per turn**, at the end of the pipeline, from the
  model's structured output — not by the model writing to storage.
- The model identifies *knowledge points by ID*. Matching corrections or
  targets back to IDs by fuzzy text matching is a bug factory; if the model
  cannot supply an ID, treat the signal as unattributed and log it.
- A learner attempt can legitimately produce several facts at once (used
  correctly → `times_used += 1`; also seen → `times_seen += 1`). Define the
  mapping in one place and test it.
- Re-reading a message, retrying a failed turn, or replaying a session **must
  not** double-count. Make updates idempotent per (turn, knowledge point).
- Progress is never reset by a re-import; see §6.4.

### 6.3 Steering — how progress picks the next topic

**Target selection** is a **deterministic function of progress**, evaluated by
the core, not a decision delegated to the model:

```
select_targets(progress, class, session_state) -> ranked knowledge points + reason
```

**The core decides *what* to work on; the model decides *how* to work it into
the conversation.** This split is what keeps steering debuggable and testable,
and it is the main reason the model stays swappable.

**The model does decide how an incoming message is handled.** Classifying
learner intent — a genuine attempt vs. a linguistic question vs. drift — has no
deterministic derivation, so per-message routing is model-determined (§2.1,
§18.2). The branch set itself is authored, versioned, and reviewed like a prompt
(§7.7), and the model selects among those branches rather than inventing them.
Target selection, progress updates (§6.2), and knowledge-point identity (§6.4)
stay in the core.

Ranking should consider, roughly in this order:

1. **Due for review** — not seen for a while (spaced exposure).
2. **Struggling** — high `times_wrong` or `times_used_with_help` relative to
   `times_used`.
3. **Not yet introduced** — new material still untouched in this class.
4. **Consolidating** — seen but never produced by the learner unprompted.

Practical constraints on selection:

- **A target list per turn must be small** (a handful). Dumping the whole
  chapter into context wastes tokens, costs money, and destroys the natural
  feel.
- **Respect the class scope** but allow the drift-and-return behaviour from
  §7.3.
- **Log the reason for every selection.** "Why did it ask about the dative
  again?" must be answerable from a log line.
- Selection must be **pure and unit-testable** with no model call, so the
  weighting can be tuned against recorded sessions.

TODO: confirm the exact weights and thresholds once there is session data, and
confirm that the fields above match what ingestion actually produces (§19).

### 6.4 Stable knowledge-point identity (critical)

Progress is worthless if IDs move. When the same class is re-imported, or the
same material is ingested twice, knowledge points **must map to the same IDs**
or the learner's history is silently orphaned.

- Derive IDs deterministically from stable content (e.g. a normalized hash of
  kind + canonical title), not from import order or a fresh UUID per ingestion.
- Re-importing or re-fitting a class must **reconcile**: match existing IDs, add
  genuinely new points, and mark removed ones as retired rather than deleting
  them — progress rows reference them.
- Never rewrite or reassign an existing knowledge-point ID.
- A test must cover "ingest twice → no duplicate points, progress preserved."

### 6.5 Class lifecycle

- **Imported now:** a class imported from learner-supplied material.
- **Planned:** a built-in library of default classes the learner can pick from
  instead of importing — starting with German levels A1–C2 (§19.2). A built-in
  class is just a class with a different `origin`; do not special-case it.
- Material may be messy or incomplete. Parsing and normalizing it into knowledge
  points is a real, testable unit, and failures are surfaced to the learner in
  conversation rather than crashing the session.

### 6.6 Learner identity across channels

One learner may reach the engine through Discord today and through Telegram, the
website, or a phone client later. Progress is per learner, so identity must be
resolved before progress is read or written.

- **v1:** the Discord user id is the learner identity; one Discord account is one
  learner.
- **Adding a channel requires explicit account linking.** Never guess that two
  channel identities are the same person.
- Until linking exists, users of a new channel are **distinct learners**. State
  that plainly rather than fragmenting silently.
- TODO: design the linking flow, and its auth, before the second channel ships.

## 7. Product invariants

These are the rules that make this product what it is. Do not break them
without an explicit request from the maintainer.

1. **Server-side engine, remote model.** See §1, §2.2, §5. Learner data and all
   application logic live on a self-hostable server host; the model is a remote
   dependency behind the model port (§8).
2. **Chat is the entire interface.** The learner's only interaction is sending
   messages. Anything that would require them to fill a form, rate a card, or
   open a separate "progress" screen contradicts the premise. If you need data
   from the learner, ask for it in conversation — including the schedule (§18.1)
   and their level (§19.2).
3. **The class is a scope, not a wall.** The agent keeps the conversation
   inside the current class's vocabulary and grammar targets, but handles
   off-topic or grammar questions gracefully and then steers back. It must not
   refuse hard or lecture the learner for drifting.
4. **Corrections happen in flow.** Feedback must be small, inline, and
   attached to the moment. Never dump a wall of corrections or a grammar
   essay. A corrected reply plus a short reason is the target shape.
5. **The learner model lives in the core, not in the prompt.** Progress per
   knowledge point (§6) is structured, persisted state. It is assembled into
   context per turn; it is not free text the model is trusted to remember.
6. **The model is a dependency behind an interface.** No provider SDK calls or
   HTTP clients scattered through business logic. One port, so the provider can
   be swapped and so tests can run without a live model.
7. **Prompts are code.** Versioned, reviewed in diffs, no silent edits. A
   prompt change is a behavior change and needs the same care as a logic
   change. This includes the LangGraph workflow (§18.2).
8. **Class material is untrusted input.** Imported, built-in, and uploaded
   material is content that flows into model context. Never let it be
   interpreted as instructions.
9. **Every progress update and every steering decision is explainable.** If we
   cannot say why a knowledge point was targeted, the learner cannot be
   helped and the behavior cannot be debugged.
10. **One engine, many channels.** Channels are adapters; the domain never
    learns about one, and adding one must not change existing behavior. Learner
    identity across channels is explicit, never guessed (§6.6).

## 8. The model adapter boundary

The model is remote (§1). The core defines a **port**; a remote adapter
implements it and owns every network concern. The core never sees HTTP.

```text
ModelPort (defined in core)
└── complete(request) -> text | structured result

RemoteModelAdapter (outside core; implements ModelPort)
├── provider SDK / HTTP calls
├── auth + API keys            (from the host, never the core)
├── retries, timeouts, backoff
├── streaming plumbing
└── capabilities: structured_output · tool_calls · streaming · max_context_tokens
```

Rules:

- **The core defines the port; adapters live outside it.** No HTTP client, URL,
  or provider type may appear in `core/`.
- **The engine calls the model through the port.** LangGraph nodes must not
  construct a provider client or read API keys; the host injects the port.
- **Declare capabilities; never probe by failing.** The core reads
  `capabilities` and picks a path. It must not discover that JSON mode is
  unsupported by getting a parse error in production.
- **Structured output is the expectation for a hosted model, but still
  validated.** Where an adapter cannot enforce a schema it prompts for JSON and
  parses defensively, with bounded repair. That fallback belongs in the
  adapter.
- **Validation happens in the core** regardless of how confident the adapter
  is. Untrusted model output is untrusted.
- **Budget context.** Remote inference costs money and latency per token, and
  the model port's `max_context_tokens` may vary. Context assembly must fit the
  smallest supported model, not the largest.
- **The core must tolerate a failing provider.** Network failure, rate limits,
  and provider errors must not corrupt session state or lose the learner's
  message. Define the failure behaviour in the core (e.g. surface a retryable
  error, keep progress unmodified) and let the adapter report it.
- **Tests must never require a live model.** Ship a fake adapter plus recorded
  fixtures (§11).

TODO: confirm the exact port shape once the language is chosen. Keep it in one
file and keep it small.

## 9. Repository layout

**Proposed** — adapt to reality. Update this section as directories appear.

```
.
├── AGENT.md          # this file
├── idea.md           # staging register for unreviewed ideas (§17)
├── README.md         # human-facing setup + overview
├── core/             # the domain: channel-agnostic, engine-agnostic (§3)
│   ├── steering/     # target selection from progress (§6.3)
│   ├── classes/      # class import, parsing, knowledge-point identity (§6.4)
│   ├── progress/     # turn-result -> counter mapping (§6.2)
│   ├── prompts/      # versioned prompt assets
│   ├── domain/       # models + pure logic
│   └── ports/        # storage, model, clock, ids, config interfaces
├── engine/           # LangGraph graphs + runtime wiring (§2.1, §18.2)
├── adapters/         # implementations: fake, remote model, storage
├── frontends/        # channel adapters: discord (v1), telegram, web
├── hosts/            # composition roots: server (v1), cli
└── datasets/         # built-in class data, e.g. German A1–C2 (§19.2)
```

The `core/` boundary is the one that must survive: nothing in `core/` may import
from `engine/`, `adapters/`, `frontends/`, `hosts/`, or `datasets/`.
TODO: confirm real paths once the language is chosen.

## 10. Tech stack

**Engine: LangGraph — decided (§2.1). Language: TODO — Python or JS/TS**, the
two LangGraph ships for. The earlier constraint ("the core must be embeddable in
a phone app") is **withdrawn**: the engine is server-side (§2.2), so portability
to iOS/Android no longer governs the choice. Pick the language the server
runtime and the channel SDKs are best served by; both have mature Discord and
Telegram libraries.

Once chosen, fill in:

- Language / runtime: TODO — LangGraph (Python) or LangGraph.js
- Package manager / build: TODO
- Host targets in scope for v1: **server host + Discord channel** (§5)
- Storage: TODO — one server database; LangGraph's `PostgresSaver` is its
  recommended production checkpointer, so Postgres is the default candidate
- Model adapters: TODO — fake first, then one remote provider (§8)
- Channel adapters: TODO — Discord first (§5)
- Boundary-enforcement tooling: TODO (§4)
- Test framework: TODO
- Deployment / self-hosting: TODO — the server must be runnable by an operator
  who is not the maintainer (§5)

## 11. Testing

TODO on specifics; the rules below apply regardless.

- **No live model calls in the default test suite.** The fake adapter plus
  recorded fixtures is the default path.
- **The core must be testable with no host, no channel, and no network.** If a
  core test needs a platform or a socket, the boundary in §3 is broken.
- **The boundary check from §4 is part of CI**, and a failure is a real
  failure, not a warning.
- **Storage tests run against the real server database** in CI; there is no
  second dialect to support (§10).
- **Test the turn pipeline directly**, not only through a channel or a host.
- **LangGraph graphs are tested with the fake model adapter**, and the routing
  decision per branch is asserted (§18.2).
- **The steering engine is unit-tested in isolation** with hand-built progress
  states: struggling, unattempted, consolidated, empty. This is the logic that
  decides what the product actually teaches.
- **Class ingestion gets real tests**, especially idempotent re-ingestion and
  preservation of progress (§6.4).
- **Progress updates are tested for idempotency** and for the mapping from a
  structured turn result to counter changes (§6.2).
- **Failure paths are tested**: provider timeout, rate limit, malformed
  structured output, and no schema support. The learner's message and progress
  must survive all of them.
- **Migrations are tested** against a database containing existing data.
- Bug fixes come with a regression test.

## 12. Working agreement

1. **Read before writing.** Inspect existing code and conventions first; match
   what is there.
2. **Verify before claiming done.** Run the relevant tests, lint, and
   type-check. If you cannot run them, say so plainly — never report untested
   work as working.
3. **Small, focused changes.** One logical change at a time. No drive-by
   refactors or reformatting.
4. **Ask before hard-to-reverse decisions.** New dependency, stack choice,
   provider choice, storage schema, knowledge-point ID scheme, steering
   weights, the model port, public API shape, prompt- or graph-behavior change —
   ask first.
5. **Protect the core boundary.** Before adding an import to `core/`, check it
   against §3. Channel SDK, transport, storage-driver, HTTP-client, provider-SDK,
   and LangGraph imports in the core are bugs, not style issues.
6. **Don't reinvent the pattern.** For anything structural — hosts, adapters,
   composition roots, channel dispatchers, testing seams — follow the
   established Ports and Adapters practice in §2.
7. **Treat learner data as sensitive.** Conversations, classes, and progress are
   personal data stored on a server (§5). No secrets in the repo; model API keys
   and **channel bot tokens** come from the host environment, never from the
   core. Document required variable *names* in `README.md`, never values. Do not
   log full conversations at info level. Be explicit about what is sent to the
   remote model and what is retained on the server.
8. **Do not commit unless asked.** Leave changes for review.
9. **Report honestly.** State what changed, what you verified, and what is
   still uncertain or deferred.
10. **Stage new ideas in `idea.md`, not here.** Do not add speculative or
    unreviewed rules to this file; see §17.

## 13. Code style

TODO — set concrete rules with the stack. Until then, follow the surrounding
code.

- Formatter: TODO
- Linter: TODO
- Naming: TODO
- Error handling: provider/parse failures must not surface as raw provider
  errors; wrap them and keep the learner's session usable. A failed progress
  update must not lose the learner's message.

## 14. Git conventions

TODO

- Default branch: TODO
- Branch naming: TODO
- Commit style: TODO (Conventional Commits is a fine default)
- PR expectations: TODO

## 15. Boundaries — ask before touching

- Lockfiles and dependency manifests.
- Database migrations and anything destructive to learner progress or
  conversations.
- The knowledge-point ID scheme (§6.4) and steering weights (§6.3) once data
  exists — changing either silently corrupts or shifts learner history.
- The model port and the `capabilities` set (§8) — every host and adapter
  depends on it.
- Prompt files and LangGraph graphs once conversations depend on them (treat as
  reviewed artifacts).
- Auth, learner-identity linking (§6.6), rate limiting, and spend/cost controls.
- Channel credentials — Discord/Telegram bot tokens, webhooks — and the server's
  deployment configuration.
- The learner-data retention, logging, and backup policy (§12.7).
- Any generated or vendored code, including built-in datasets (§19.2).

## 16. Definition of done

- [ ] The requested behavior is implemented.
- [ ] Relevant tests pass (or the reason they cannot run is reported).
- [ ] Lint / type-check / format pass, where they exist.
- [ ] No live model call is required for the test suite to pass.
- [ ] No channel SDK, transport, storage-driver, HTTP-client, provider-SDK, or
      LangGraph dependency in the core (§3).
- [ ] No channel-specific concept leaked into the domain, and adding a channel
      did not change existing behavior (§3, §7.10).
- [ ] Progress updates are idempotent and attributable to knowledge-point IDs.
- [ ] Steering decisions are logged with a reason.
- [ ] Learner identity is explicit; no two channel identities are silently
      merged (§6.6).
- [ ] No claim of offline conversation support, and no claim that learner data
      stays on the learner's device; server-side handling is stated accurately
      (§5).
- [ ] `README.md` / this file updated if commands, layout, or behavior changed.
- [ ] Final response summarizes what changed and how it was verified.

## 17. Gathering ideas: `idea.md` comes first

Unreviewed ideas are **gathered in `idea.md`, not written here**. The register
keeps this file short and reviewed, and gives one place to catch an idea that
contradicts another idea or a rule here before either reaches this file.

- `idea.md` is **non-normative**. This file remains the single source of truth
  (preamble). Nothing in `idea.md` is a rule, and no agent may treat it as one.
- **Capture first, merge later.** Record the idea as an `IDEA-nnnn` entry in
  `idea.md`; do not edit this file in the same step.
- **Conflicts surface at merge time.** Before an idea is consolidated here,
  scan it against every other open idea and against the sections it touches,
  and record each conflict plus its resolution on the entry. "None found" is an
  explicit result, not an omission.
- **Resolve before merging.** Settle a conflict by adopting one side, amending
  the idea, superseding the other idea, or rejecting it. Two contradictory
  ideas must not both be merged.
- **Merge deliberately.** Write the idea into this file as a rule (drop the
  discussion), update affected lines instead of duplicating them, and mark the
  entry `Merged` with the section it became.
- **While an idea is undecided, this file wins.** An unreviewed idea never
  overrides an existing rule here.
- **A merge can carry TODOs.** When an idea is merged by maintainer instruction
  with conflicts still open, the undecided parts land here as explicit `TODO:`
  lines and the entry says so. A TODO is not a settled rule — do not build on it
  as if it were.

## 18. Conversation orchestration

This is the product's behavior layer, and it is core logic (§3): these rules
decide *what* happens; the model decides *how* it is phrased (§6.3).

### 18.1 Sessions start on a schedule

- A session is started by the **scheduler**, not only by the learner. Default:
  once daily at a set time; the learner may choose another cadence, including a
  random time during the day.
- At the scheduled moment the scheduler reads progress, picks the starting
  knowledge point via `select_targets` (§6.3), and sends the opening message. It
  then **waits for the learner**.
- On every learner reply the engine re-evaluates — what the learner knows and
  what they are struggling with, from persisted counters (§7.5), never from
  prompt memory — and, together with the pending knowledge points, replies so the
  conversation continues while guiding toward unlearned points.
- The schedule is set **in conversation** (§7.2): no settings screen.
- Delivery is a normal channel message. The server sends it; the channel adapter
  delivers it.
- TODO: cadence options and defaults; whether an unanswered session is retried;
  how the schedule is stored; cost controls for proactive turns.

### 18.2 Every message runs its own workflow

- A message is **not** handled by one monolithic system prompt. It enters a
  per-message workflow with boundary decisions: classify the intent, then branch
  — a learner attempt (judge the grammar → correct vs. incorrect branch), a
  linguistic question (unknown word or construction → its own branch), drift, or
  a question about a knowledge point.
- **The model picks the branch.** Intent has no deterministic derivation
  (§6.3); that is why a graph engine is justified here (§2.1).
- **The branch set is authored**, versioned, and reviewed like a prompt (§7.7).
  The model selects among branches; it does not invent the workflow at runtime.
- **A knowledge-point question is answered before re-anchoring.** The engine
  records the interaction against the knowledge point (§6.2 — progress, not
  class material) and answers, then continues the workflow.
- **Drift is handled by a soft re-anchor, never a clamp** (§7.3). Handle the
  off-topic message, then steer back; never refuse or lecture.
- Every path still produces **at most one progress update per turn**, by ID,
  idempotent (§6.2).
- The workflow is a **LangGraph graph** (§2.1), run server-side and reviewed as
  code.
- TODO: the full branch set; how many model calls per learner message are
  acceptable; how drift is detected and bounded; where the graph source and any
  diagram live.

## 19. Knowledge sources and ingestion

### 19.1 One schema, model-fitted

- The knowledge dataset has **one schema**, defined by the core (§6.1). Every
  source — built-in, imported, or personal — is fitted into it; there is no
  per-source shape.
- The schema is **versioned**, and changing it requires tested migrations (§11).
  Keep `raw_source` so a re-fit stays possible and debuggable.
- **Uploaded material is analysed by the model and fitted into the schema.**
  Fitting creates knowledge points whose IDs are derived deterministically from
  canonical content (§6.4); the model never assigns IDs.
- **Model fitting must never attribute progress.** Creating a point from free
  text is fine; matching an upload onto an existing ID for progress is not
  (§6.2). Unattributable signals are logged, not guessed.
- Fitting runs through the model port (§8), and its output is validated in the
  core like any other model output. A failed or partial fit is surfaced in
  conversation, never a crash.
- TODO: whether an "other/unclassified" kind is allowed beyond grammar,
  sentence structure, and vocab; the duplicate policy against existing points;
  where fitting runs (core vs. adapter); the confirmation flow when a fit is
  uncertain.

### 19.2 Built-in German levels

- The server ships a **built-in library of German knowledge for levels A1–C2**,
  assembled from public sources.
- **On a fresh start the app asks which level the learner is studying now** —
  one question, in conversation (§7.2). A built-in class is a class with a
  different `origin`; do not special-case it (§6.5).
- TODO: which sources, and under what licence/attribution (ask-first —
  §12.4/§15); whether "level" is a field on `Class` or a separate concept; what
  happens when the learner does not know their level; whether level filters
  targets or only orders them (§6.3); how the library is versioned and
  reconciled (§6.4).

### 19.3 Personal knowledge points

- The learner can also bring **their own knowledge points**, uploaded through a
  channel and fitted into the same schema (§19.1).
- Personal points take part in progress and steering like any other point; if
  they are not selectable, they are invisible to the loop (§18.1).
- TODO: how an upload is delivered in chat without a separate surface (§7.2);
  the container and `origin` for personal points; the collision policy against
  built-in points; the ID scheme and accepted formats/interop.

### 19.4 One learner, one progress record

Regardless of channel or source, progress belongs to one learner (§6.6). A point
present in both the built-in library and a personal upload must not split the
learner's counters (§6.4).
