# 70 — Stack and repository layout

> Specification. Code is written from this document (`AGENT.md` §2).

## 1. Decided stack

**Engine: LangGraph. Language: TypeScript on Node ≥22, ESM — decided
2026-09-25.** LangGraph.js is the engine runtime. The earlier constraint ("the
core must be embeddable in a phone app") is withdrawn: the engine is server-side
([10-overview.md §3](10-overview.md)), so portability to iOS/Android no longer
governs the choice.

- **Language / runtime:** TypeScript, Node ≥22, ESM (`"type": "module"`)
- **Package manager / build:** `pnpm`; `tsx` runs the hosts; `tsc --noEmit`
  type-checks
- **Host targets in scope for v1:** server host + Discord and Telegram channels
  ([10-overview.md §4](10-overview.md), [72-channels.md](72-channels.md)); a CLI
  host exists over the same core for development and tests
- **Storage:** SQLite through Node's built-in `node:sqlite`. One engine for v1;
  PostgreSQL is a future option, not a parallel dialect
  ([80-decisions.md](80-decisions.md) D-008)
- **Graph checkpointing:** TODO — the PoC reconstructs state from its own turn
  tables and compiles the graph without a checkpointer. Choose the store and the
  point at which graph state must be resumable; the checkpointer belongs behind
  the storage port ([20-architecture.md §2](20-architecture.md))
- **Model adapters:** fake first, then one OpenAI-compatible remote adapter over
  `fetch` — no provider SDK. Speaks the **OpenAI Responses API**
  (`POST {base}/responses`) because strict `json_schema` structured output is
  only reachable there. The built-in default endpoint and model live in the
  composition root, never in `core/`; the current default is the **DeepSeek
  official API** (`https://api.deepseek.com/v1`) with **`deepseek-flash`**
  (DeepSeek-V4.1-Flash, 1M context, structured output supported), so schema
  enforcement is the active path and the schema-in-prompt fallback covers
  endpoints that declare otherwise ([20-architecture.md §5](20-architecture.md),
  `MVP.md` §3.1). The deployer configures centrally; a learner may supply their
  own key. TODO: if v1 persists a learner credential, say where it lives
  (`MVP.md` §8.1)
- **Channel adapters:** `discord.js` v14 for Discord (the gateway protocol is why
  the SDK earns its place); the **Telegram Bot API over `fetch`** with long
  polling and no SDK ([72-channels.md](72-channels.md))
- **Document parsing (upload pipeline):** adapter-only dependencies for pdf,
  docx, and pptx text extraction, behind a new `core/ports/documents.ts` port.
  The exact libraries are an ask-first choice and stay a TODO
  ([60-ingestion.md §5](60-ingestion.md), [`AGENT.md`](../AGENT.md) §5)
- **Boundary-enforcement tooling:** a purpose-built scanner
  (`tools/boundary-scan.ts`) run by `pnpm boundary` and by the test suite.
  **dependency-cruiser was rejected:** under this TypeScript/ESM setup it
  silently dropped *bare* imports, so a forbidden-SDK rule could never fire while
  the check reported success
- **Test framework:** `vitest`
- **Deployment / self-hosting:** **one Linux host under systemd**, one server
  process, `.env`-driven configuration, SQLite in `var/`; containers deferred. The
  contract and the reference implementation are in
  [75-deployment.md](75-deployment.md) (D-028), so the server is runnable by an
  operator who is not the maintainer ([10-overview.md §4](10-overview.md))

## 2. Repository layout

Target layout. A directory listed here for a specification is created by the
change that implements that specification.

```
.
├── AGENT.md          # process rules for agents (starts at design/00-index.md)
├── MVP.md            # proof-of-concept build report (status, non-normative)
├── idea.md           # staging register for unreviewed ideas
├── README.md         # human-facing setup + overview
├── design/           # THE SPECIFICATION — this directory
├── package.json      # pnpm scripts: verify, test, boundary, demo:cli, admin, start
├── core/             # the domain: channel-agnostic, engine-agnostic
│   ├── steering/     # scope resolution + target selection (design/40-steering.md §2)
│   ├── classes/      # class fitting, reconciliation, knowledge-point identity (design/60-ingestion.md §1–2)
│   ├── onboarding/   # deterministic language/level/chapter questions (design/50-orchestration.md §3.2)
│   ├── progress/     # turn-result -> counter mapping + derived state (design/30-domain-model.md §2)
│   ├── identity/     # learner_id + channel-link rules (design/30-domain-model.md §6)
│   ├── prompts/      # versioned prompt assets
│   ├── domain/       # models + pure logic
│   └── ports/        # storage, model, clock, ids, config, documents interfaces
├── engine/           # LangGraph graphs + runtime wiring (design/50-orchestration.md)
├── adapters/         # implementations: fake, remote model, storage, clock, ids, document extraction
├── frontends/        # channel adapters: discord, telegram, web
├── hosts/            # composition roots: server (v1), cli, admin, scheduler
├── deploy/           # systemd unit template + installer (design/75-deployment.md §2)
├── tools/            # core-boundary scanner (`pnpm boundary`)
├── datasets/         # class data: one imported fixture plus the built-in seed levels
│   └── builtin/      # level bundles + attribution (design/60-ingestion.md §3)
└── tests/            # offline suite; no live model
```

The `core/` boundary is the one that must survive: nothing in `core/` may import
from `engine/`, `adapters/`, `frontends/`, `hosts/`, `datasets/`, or `tools/`,
and `zod` is its only allowed external package. Enforced by `pnpm boundary`
([20-architecture.md §3](20-architecture.md)).

## 3. Commands

| Purpose | Command |
|---|---|
| Full gate | `pnpm verify` (typecheck + boundary + tests) |
| Type-check | `pnpm typecheck` |
| Boundary check | `pnpm boundary` |
| Tests | `pnpm test` / `pnpm test:watch` |
| CLI demo | `pnpm demo:cli` |
| Approve / deny learner access | `pnpm admin` (see [74-access.md §4](74-access.md)) |
| Local provider stub | `pnpm stub:model` |
| Run the server | `pnpm start` |
| Install / upgrade the service | `sudo bash deploy/install.sh` (see [75-deployment.md §2](75-deployment.md)) |

## 4. Code style

TODO — no formatter or linter is configured, so `pnpm typecheck` and
`pnpm boundary` are the only mechanical checks. Do not claim a lint or format run
that did not happen (`AGENT.md` §4).

- Formatter: TODO
- Linter: TODO
- Naming: TODO
- **Error handling:** provider/parse failures must not surface as raw provider
  errors; wrap them and keep the learner's session usable. A failed progress
  update must not lose the learner's message.

## 5. Testing rules

TODO on specifics; the rules below apply regardless.

- **No live model calls in the default test suite.** The fake adapter plus
  recorded fixtures is the default path.
- **The core must be testable with no host, no channel, and no network.** If a
  core test needs a platform or a socket, the boundary is broken.
- **The boundary check is part of CI**, and a failure is a real failure, not a
  warning.
- **Storage tests run against the real server database**; there is no second
  dialect to support.
- **Test the turn pipeline directly**, not only through a channel or a host.
- **LangGraph graphs are tested with the fake model adapter**, and the routing
  decision per branch is asserted ([50-orchestration.md §3](50-orchestration.md)).
- **The steering engine is unit-tested in isolation** with hand-built progress
  states: struggling, unattempted, consolidated, empty. This is the logic that
  decides what the product actually teaches.
- **The scope resolver is unit-tested in isolation** with hand-built settings: no
  included levels, included levels, points below the cursor, and background
  points that start ranking once a counter exists
  ([40-steering.md §2](40-steering.md)).
- **Onboarding is tested as a pure, offline state machine**: each step, tolerant
  parsing, a re-ask on unknown input, resume after restart, and **zero model
  calls** ([50-orchestration.md §3.2](50-orchestration.md)).
- **Learner settings are tested for round-trip persistence and per-learner
  isolation**, like every other table
  ([30-domain-model.md §8](30-domain-model.md)).
- **Class ingestion gets real tests**, especially idempotent re-ingestion and
  preservation of progress ([30-domain-model.md §4](30-domain-model.md)).
- **Progress updates are tested for idempotency** and for the mapping from a
  structured turn result to counter changes
  ([30-domain-model.md §2](30-domain-model.md)).
- **Access control is tested**: one learner cannot read or write another
  learner's material or progress ([30-domain-model.md §7](30-domain-model.md)).
- **Failure paths are tested**: provider timeout, rate limit, malformed
  structured output, and no schema support. The learner's message and progress
  must survive all of them.
- **Migrations are tested** against a populated database, including the
  `learner_settings` table and the class/knowledge-point schema bump.
- Bug fixes come with a regression test.
- **Deployment artifacts are tested offline**: the unit template renders with
  `--dry-run`, the installer passes `bash -n`, and the unit carries no secrets
  ([75-deployment.md §5](75-deployment.md)). Installing a unit is an operator
  action, never part of `pnpm verify`.
