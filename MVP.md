# MVP.md — proof-of-concept scope and decision record

> **Status: status record, non-normative.** The specification now lives in
> [`design/`](design/00-index.md); `AGENT.md` holds the process rules, including
> the design-docs-first rule. This document reports what the proof of concept
> built and the decisions the maintainer made to unblock it. **It is not a
> specification and must not be treated as one** — where this file and a design
> doc disagree, the design doc wins and the disagreement is listed in §8.
>
> **Decision date:** 2026-09-25 · **Item states:** `DECIDED` (maintainer),
> `PROPOSED` (agent default, needs a yes/no), `OPEN` (must be answered before
> the related code is written).

## 0. Status — built on 2026-09-25

The PoC described here is **implemented** in this repository: the core domain,
ports, and steering loop; the LangGraph turn workflow with all four authored
branches; SQLite storage with idempotent progress writes; the OpenAI-compatible
and fake model adapters; the Discord channel and the CLI host; the scheduler;
87 offline tests; and a core-boundary check that fails the build.

Verified mechanically, not by assertion:

- `pnpm verify` → type-check clean, `✔ core boundary intact (16 files scanned)`,
  87 tests passing with no network and no live model.
- `pnpm demo:cli` → import → scheduled session → a conversation that routes
  through `attempt_judged`/`corrected`, `kp_question`, `drift`, and
  `attempt_judged`/`accepted` → progress rows → idempotent re-import (`added=0`,
  `retired=0`, `unchanged=22`).
- The boundary check was proven to fail by planting a deliberate
  `@langchain/langgraph` import inside `core/`.
- The Discord adapter is exercised end to end through an injected client: first
  contact and provisioning, identity linking, turn dispatch, DM delivery, and
  both slash commands — with no network and no bot token.
- `pnpm start` without a token exits non-zero with a clear message and creates
  no database file.
- **Deployed locally against a real HTTP provider stub** (`tools/stub-provider.ts`)
  with a real SQLite file, for both adapter paths: with conservative
  capabilities the request carried no `response_format` and the prompt-based JSON
  fallback parsed (stub logged `enforcedSchema:false`); with structured output
  declared, the request carried a `json_schema` and the stub logged
  `enforcedSchema:true`. The resulting database held 1 learner, 1 class,
  4 progress rows, 9 messages, 5 turns and 1 schedule, with counters
  `seen=4 used=4 wrong=0` — so the loop persists correctly end to end.
- **A real server-host deploy attempt** (invalid token) found and fixed two
  defects: `frontend.start()` was unguarded, so the operator got a raw
  `DiscordAPIError` payload dump instead of a message; and the scheduler was
  started *before* the gateway connected. Startup failure now logs one
  actionable line, closes storage cleanly, and never leaves the scheduler
  running.

**Still unverified at runtime:** the Discord gateway login and REST
slash-command registration. A deploy attempt with an invalid token fails at
authentication (401) *before* the command payload is validated, so the
registration shape is still unproven — that needs a real application. Also
unproven: any call to a real model provider, so the behavioral question (does
the model return schema-valid results and steer well) remains open.

Two decisions changed during implementation and are recorded in §2: `node:sqlite`
replaced `better-sqlite3` (no native build step), and the boundary tooling moved
from dependency-cruiser to a purpose-built scanner.

## 1. What the PoC must prove

One learner can import a class, converse with the agent on Discord, and be
steered by **persisted per-knowledge-point progress** — with the `core/`
boundary of `design/20-architecture.md` §2 intact.

The PoC is a **demonstration of the architecture and the steering loop**, not a
v1 product. It proves three claims:

1. **The engine runs server-side** and the learner talks to it over a real chat
   channel (Discord), with no on-device component.
2. **Progress is structured state, not prompt memory** (§7.5): counters persist,
   survive a restart, and are attributable to knowledge-point IDs.
3. **Steering is a deterministic function of progress** (§6.3): the agent picks
   the next target from persisted counters and logs why.

Non-goals at the time (2026-09-25): Telegram, website, phone clients; the
built-in German A1–C2 library (§19.2, licence-blocked); model-fitting of
learner uploads (§19.1); Postgres; multi-learner scale; billing. **Update
2026-09-27: Telegram shipped as the second channel** (`design/72-channels.md`,
D-034); the website and phone clients remain non-goals.

## 2. Stack decisions

| Item | State | Decision |
|---|---|---|
| Language / runtime | **DECIDED** | TypeScript on Node ≥22, ESM (`"type": "module"`). Environment has Node v22.23.2. |
| Orchestration engine | DECIDED (design/10-overview.md §3.1) | LangGraph.js (`@langchain/langgraph`). |
| Package manager | **DECIDED** | `pnpm`; `tsx` runs the hosts; `tsc --noEmit` type-checks. |
| Test framework | **DECIDED** | `vitest` (native ESM/TS, no build step). |
| Discord integration | **DECIDED** | `discord.js` ^14.27 (current stable). |
| Storage | **DECIDED** | SQLite through Node's built-in `node:sqlite`, file-backed in the server host. **Single engine for v1; PostgreSQL is a future option, never a parallel dialect** (§11). Chosen over `better-sqlite3` so the PoC needs no native build step. |
| Graph checkpointing | **DEFERRED** | The PoC persists conversations, turns, and progress in its own tables and compiles the graph without a checkpointer. A persisted checkpointer belongs behind the storage port when graph state must be resumable (§2.1). |
| Model transport | **DECIDED** | OpenAI-compatible HTTP, called with `fetch` from the remote adapter. No provider SDK dependency. |
| Validation | **DECIDED** | `zod` in `core/` for all untrusted model output (§8). The only external package the core may import. |
| Boundary enforcement | **DECIDED** | A purpose-built scanner (`tools/boundary-scan.ts`) shared by `pnpm boundary` and the test suite (§4, §11). dependency-cruiser was tried first and **rejected**: under this TypeScript/ESM setup it resolved relative imports but silently dropped *bare* imports such as `@langchain/langgraph`, so its SDK rule could never fire while reporting success. |
| Deployment | **DECIDED** | Single process, `.env`-driven, Dockerfile deferred. |

`discord.js` prerequisite: reading ordinary message text needs the **Message
Content Intent** (privileged; toggled in the Discord developer portal, fine for a
single test guild). Slash commands avoid that dependency, so the PoC provides a
slash command for on-demand session start regardless.

## 3. Model provider configuration (the login-free, BYO-token design)

The model is a remote dependency behind the port (§8). Configuration is resolved
**only in the host composition root**; `core/` receives a plain config object and
never sees a URL, a token, or the word "deepseek" (§3).

### 3.1 Resolution order

Highest precedence wins:

| # | Source | Set by | Intended use |
|---|---|---|---|
| 1 | Per-learner override | the learner, in conversation | "use my own key/model" |
| 2 | Deployer configuration | the operator running the server | self-host default for everyone |
| 3 | Built-in default | the code | zero-config first run |

The built-in default is **DECIDED**: base URL `https://api.deepseek.com/v1`,
model `deepseek-flash`
(verified real: DeepSeek-V4.1-Flash, 1M-token context, 393K max output, native
function calling, and strict `json_schema` structured output). Enforcement is
requested through the **Responses API** (`POST {base}/responses`,
`text.format: {type: "json_schema"}`); the chat-completions surface rejects
`json_schema` outright, so the adapter speaks `/responses`.

### 3.2 The config object

```ts
type ModelConfig = {
  baseUrl: string;          // e.g. https://api.deepseek.com/v1
  model: string;            // e.g. deepseek-flash
  apiKey: string | null;    // deployer key or learner token; null = local/fake
  source: "learner" | "deployer" | "default";
  capabilities: {           // declared, never probed by failing (§8)
    structuredOutput: boolean;
    toolCalls: boolean;
    streaming: boolean;
    maxContextTokens: number;
  };
};
```

Deployer variable **names** are documented in `README.md`, never values (§12.7):
`TALK_MODEL_BASE_URL`, `TALK_MODEL_ID`, `TALK_MODEL_API_KEY`,
`TALK_MODEL_CAPABILITIES`.

### 3.3 Token handling

- **PoC:** the deployer key is the supported path. A learner-supplied token is
  accepted at runtime for a session but **not persisted**, so the PoC carries no
  secret-at-rest obligation.
- **v1 and later:** persisting a learner token means storing a per-learner
  credential, which belongs to the **identity layer, never the domain**
  (§6.6/§6.7) and must be encrypted at rest. This is an open decision (§8.2).
- Capability fallback: if the configured model reports no structured output, the
  adapter prompts for JSON and parses defensively with bounded repair (§8). The
  turn-result schema in §5.1 is therefore kept small enough for that path.

## 4. Repository layout (concrete `design/70-stack.md` §2)

Single package for the PoC — the boundary is enforced by rules, not by workspace
boundaries.

```
.
├── AGENT.md  ·  MVP.md  ·  idea.md  ·  README.md
├── package.json  ·  tsconfig.json  ·  vitest.config.ts  ·  .dependency-cruiser.cjs
├── core/                 # channel-agnostic, engine-agnostic; no network, no DB, no SDK
│   ├── domain/           # Class, KnowledgePoint, UserProgress, TurnResult (zod)
│   ├── ports/            # storage · model · clock · ids · config (interfaces only)
│   ├── classes/          # import, canonicalization, reconciliation (§6.4)
│   ├── progress/         # TurnResult -> counter deltas, idempotent (§6.2)
│   ├── steering/         # select_targets(progress, class, session_state) (§6.3)
│   ├── identity/         # learner_id + channel-link rules (§6.6)
│   └── prompts/          # versioned prompt assets (§7.7)
├── engine/               # LangGraph graph + node wiring (§18.2)
├── adapters/             # fake model · openai-compatible remote model · sqlite storage · clock · ids
├── frontends/discord/    # driving adapter (§5)
├── hosts/server/         # composition root: the authority
├── hosts/cli/            # composition root: core + fake model, for tests (unchanged behavior)
└── datasets/             # one committed PoC class fixture
```

## 5. The behavioral gaps (former items 5–8)

These are the parts `AGENT.md` leaves as `TODO` and that the PoC cannot be coded
without. Each is given a **proposed default**; all are `OPEN` until confirmed.

### 5.1 Turn result — the model↔core contract (§6.2, §18.2) · **PROPOSED**

Never specified in `AGENT.md`; it is the crux of the product. Proposal:

```ts
TurnResult = {
  branch: "attempt_judged" | "question" | "kp_question" | "drift",
  reply: string,                       // what the learner sees
  corrections: Array<{ span: string; fix: string; reason: string }>,  // small, inline (§7.4)
  signals: Array<{
    knowledge_point_id: string,        // must be an ID from the provided target list
    outcome: "used" | "used_with_help" | "wrong" | "seen",
    evidence: string,
  }>,
}
```

Invariants enforced in `core/`: at most one update per (turn, knowledge point);
IDs not in the turn's provided target list are **logged as unattributed and
dropped**, never fuzzy-matched (§6.2); schema validated before any write.

### 5.2 Branch set and graph (§18.2) · **PROPOSED**

Nodes: `assemble_context` → `select_targets` → `decide` → `validate` →
`persist_progress` → `deliver`. `decide` branches to
`judge_attempt` (correct / incorrect), `answer_question`, `answer_kp_question`,
or `handle_drift` (soft re-anchor, §7.3), then composes one reply.

**Model calls per learner message: one structured `decide` call**, with at most
one bounded repair/retry call. Cheap, fast, and keeps the PoC inside a small
budget; escalation to a separate classify call is a later tuning option.
The branch set is authored and versioned in `core/prompts/`, not invented at
runtime (§7.7).

### 5.3 Knowledge-point ID canonicalization (§6.4) · **PROPOSED**

`kp_` + first 16 hex chars of `sha256(kind + "\u0000" + normalize(title) + "\u0000" + target_language)`,
where `normalize` = Unicode NFC, lowercase, collapse internal whitespace, trim,
strip trailing punctuation. Deterministic across re-imports; never derived from
import order or a UUID. Reconciliation: match by ID, insert new, mark missing as
`retired` — never delete, never reassign. Test: "ingest twice → no duplicates,
progress preserved." Changing this scheme later orphans history (§15).

### 5.4 Steering weights (§6.3) · **PROPOSED**

Deterministic, integer weights, evaluated in `core/`, reason logged per turn:

```
score = 3·due + 2·struggle + 1·new + 1·consolidating
due          = never seen  OR  last_seen_at older than 2 days
struggle     = times_wrong + times_used_with_help
new          = 1 if times_seen == 0
consolidating= 1 if times_seen > 0 and times_used == 0
tie-break    = knowledge_point_id (lexicographic)  → stable, reproducible
```

Target list per turn: top 5 (§6.3 "a handful"). Pure and unit-testable with no
model call; tunable against recorded sessions later.

### 5.5 Scheduler and session start (§18.1) · **PROPOSED**

PoC: an in-process daily timer in the server host (default 09:00 server time) plus
a Discord **slash command** to start a session on demand. The schedule is stored
per `learner_id`; the cadence is set in conversation (§7.2). Retry of an
unanswered session and cost controls are deferred.

### 5.6 Class import for the demo (§19.1) · **PROPOSED**

PoC ships **one committed fixture class** (e.g. German A1.2, chapter 8) in
`datasets/`, imported through the same core ingestion path a model fit would use.
Model-fitting of free text is stubbed behind the same interface but not
exercised, so the PoC proves the schema and identity rules without depending on
a licensing decision.

## 6. Definition of done for the PoC

Mapped to `AGENT.md` §7. The demo script, in order:

1. Fresh DB; invite the bot; `/start` opens a session with an opening message
   chosen by `select_targets`, and the log states the reason.
2. The learner replies with an attempt → one inline correction plus a short
   reason (§7.4), never a wall of corrections.
3. `UserProgress` counters for the named knowledge points change by exactly the
   mapped deltas; replaying the same turn does not double-count (§6.2).
4. A question and a drift message are both handled and followed by a soft
   re-anchor; neither is refused or lectured (§7.3).
5. Restart the server → progress and conversation continue from SQLite.
6. Re-import the same class → same IDs, zero duplicates, progress intact (§6.4).
7. `pnpm test` passes with **no network and no live model** (fake adapter).
8. Deliberately import `discord.js` inside `core/` → the boundary check fails.

## 7. Answer to "is `AGENT.md` enough?"

- **Before these decisions:** enough to build the right thing, not enough to
  start (§10 stack undecided, §12.4 gated).
- **Now:** enough for the **skeleton and the whole core** — §3–§8 and the domain
  model are unambiguous, and the stack is settled.
- **Still not enough for end-to-end behavior** until §5.1–5.4 above are
  confirmed: the turn-result contract, branch set, ID rule, and steering weights
  are the product's actual logic and had no definition at all in `AGENT.md`.

## 8. Conflicts and open questions for the maintainer

### 8.1 Conflicts with `AGENT.md` (resolved or open)

1. **SQLite vs the earlier stack section — RESOLVED (maintainer, 2026-09-25).** SQLite
   is the **single engine for v1**; PostgreSQL is a future option and never a
   parallel dialect. That keeps §11's "no second dialect to support" rule intact
   and makes the `PostgresSaver` default obsolete. `design/70-stack.md` has been
   updated to record this.
2. **Learner-supplied tokens vs §12.7 — RESOLVED FOR THE POC, OPEN FOR V1.** The
   PoC keeps a learner key in memory for the life of the process and never writes
   it to storage, so no secret is at rest. If v1 persists per-learner credentials,
   §12.7 must be amended: they would live encrypted in the identity layer, never
   in the domain (§6.6/§6.7).
3. **Third-party data flow vs §5/§12.7 — RESOLVED.** Conversation text and the
   current target material are sent to the configured endpoint. The default is a
   third party; `TALK_MODEL_BASE_URL` points at any OpenAI-compatible endpoint,
   including a self-hosted one. `README.md` states this plainly, which is what
   §12.7 requires.

### 8.2 Open decisions

- **Confirm §5.1–5.4** (turn result, branch set, ID rule, steering weights) as
  the accepted defaults rather than provisional ones. They are implemented, so
  changing them now means changing behavior and re-recording sessions.
- **Persisting a learner model credential**, if v1 keeps the bring-your-own-key
  path (§8.1 item 2).
- **The LangGraph checkpointer**: which store, and when graph state must be
  resumable rather than reconstructed from the turn tables (§2).
- **Discord Message Content Intent** is privileged: confirm the production guild
  setup, or make the channel slash-command-first (README documents the toggle).
- **Git conventions** (`AGENT.md` §6) remain entirely `TODO`.
- Whether the CLI host stays a permanent second composition root or is only used
  by tests.
