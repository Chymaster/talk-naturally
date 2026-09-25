# talk-naturally

A language-learning assistant that skips the admin. The learner imports the
material they are already studying, and then simply **converses** with an agent
that steers the conversation so they naturally use the vocabulary and grammar
they are meant to learn.

The learner's only interface is chat. There are no flashcard decks to maintain,
no session planner, and no progress bookkeeping: they show up, talk, and the
software does the rest.

> **Status: proof of concept.** This repository implements the architecture and
> the steering loop of `AGENT.md`, scoped by `MVP.md`. It is not v1 and not
> production software. See *Scope* below for exactly what is and is not here.

- `AGENT.md` — the single source of truth for how the project works.
- `MVP.md` — the proof-of-concept scope and the decision record.
- `idea.md` — non-normative staging register for unreviewed ideas.

## Quick start

Requires Node ≥ 22 (for the built-in `node:sqlite`) and pnpm.

```bash
pnpm install
pnpm verify        # type-check, core-boundary check, 81 tests — all offline
pnpm demo:cli      # the whole loop with a fake model; no network, no API key
```

`pnpm demo:cli` imports the bundled class, opens a scheduled session, runs a
short conversation that exercises all four authored branches (attempt, question,
knowledge-point question, drift), applies progress, and then re-imports the same
class to show that ids and progress survive.

To run the same loop against a real provider:

```bash
TALK_MODEL_API_KEY=<your key> pnpm demo:cli --live
```

## Running the Discord channel

The server host is the authority for learner state and owns the Discord
connection.

```bash
cp .env.example .env      # then fill it in; never commit it
pnpm start
```

Required in `.env`:

| Variable | Meaning |
| --- | --- |
| `DISCORD_TOKEN` | bot token |
| `DISCORD_APP_ID` | application id, for slash-command registration |
| `DISCORD_GUILD_ID` | optional; registers commands to one guild so they appear instantly |
| `TALK_DB_PATH` | SQLite file for all learner data (default `./var/talk-naturally.db`) |
| `TALK_MODEL_BASE_URL` | any OpenAI-compatible endpoint (default OpenRouter) |
| `TALK_MODEL_ID` | model id (default `google/gemma-4-26b-a4b-it`) |
| `TALK_MODEL_API_KEY` | deployer key |
| `TALK_MODEL_CAPABILITIES` | optional JSON capability override for unknown endpoints |
| `TALK_SCHEDULE_HOUR` | hour of the daily session, or empty to disable |
| `TALK_CLASS_PATH` | class imported for each new learner (default the bundled fixture) |

In the Discord developer portal, enable the **Message Content** privileged intent
so the bot can read ordinary messages. The `/start` command works without it.

| Command | Effect |
| --- | --- |
| `/start` | start a practice session now |
| `/model` | show the model in use |
| `/model api_key:<key>` | use your own provider key — held in memory, never written to storage |

## How it is put together

Ports and Adapters (hexagonal). Dependency always flows inward; the wiring
happens only in a host, never in the core.

```
Discord (frontends/discord)  ─┐
CLI host (hosts/cli)          ─┴─►  engine/  (LangGraph turn workflow)
                                          │
                                          ▼
                          core/  — channel-agnostic, engine-agnostic
                          domain · ports · classes · progress · steering
                          identity · prompts
                                          ▲
                    adapters/  — sqlite storage · openai-compatible model
                                 fake model · clock · ids · model resolver
```

**The dependency rule.** Nothing in `core/` may import `engine/`, `adapters/`,
`frontends/`, `hosts/`, or `datasets/`; it may not use platform modules, read
the environment, call `fetch`, or read the clock directly. The only external
package it may import is `zod`.

That rule is enforced mechanically, not by discipline:

```bash
pnpm boundary      # exits non-zero on any violation
```

The check is a purpose-built scanner (`tools/boundary-scan.ts`) shared by the
CLI and the test suite. It exists instead of dependency-cruiser because, under
this TypeScript/ESM setup, dependency-cruiser resolved relative imports but
silently dropped *bare* imports such as `@langchain/langgraph` — so a rule
forbidding SDKs in the core could never fire, and the check reported success
while the boundary was broken. A guard rail that cannot fail is worse than none.

## The parts that carry the product

| Concern | Where | Notes |
| --- | --- | --- |
| Class dataset and knowledge points | `core/domain/knowledge.ts` | grammar · sentence structure · vocab |
| Stable knowledge-point identity | `core/classes/canonical.ts` | derived from canonical content, never import order |
| Ingestion and reconciliation | `core/classes/ingest.ts` | re-import adds, retires, revives — never reassigns ids or loses progress |
| Progress counters | `core/progress/apply.ts` | one place maps a turn result to counter deltas |
| Derived state | `core/progress/derive.ts` | due / struggle / new / consolidating, recomputed — never stored |
| Steering | `core/steering/select-targets.ts` | pure, deterministic, logged with a reason |
| Turn workflow | `engine/turn-graph.ts` | the model picks a branch; the graph routes it |
| Prompts | `core/prompts/` | versioned behavior artifacts, recorded per turn |

Progress is stored as countable facts only. Mastery, confidence, and "next
review" are derived, so the reasoning stays inspectable and the formula can
change without losing history.

## Model configuration

Resolved in one place, the composition root (`hosts/config.ts`), with this
precedence:

1. **learner override** — a key supplied at runtime via `/model`
2. **deployer configuration** — the operator's endpoint, model, and key
3. **built-in default** — OpenRouter with `google/gemma-4-26b-a4b-it`

The core never sees a URL, a key, or a provider name. Capabilities are declared,
never discovered by failing; an unknown endpoint gets the conservative set
(`structuredOutput: false`), and the adapter then prompts for JSON and parses
defensively with one bounded repair. The core validates the result regardless.

## Scope

Implemented:

- the core domain, ports, and steering loop, with no host, channel, or network;
- a LangGraph per-message workflow with the four authored branches;
- a scheduler that starts sessions;
- SQLite storage, idempotent progress writes, and per-learner isolation;
- an OpenAI-compatible model adapter with structured output and a fallback;
- a Discord channel and a CLI host over the same core, with the Discord adapter
  tested end to end through an injected client (no network, no bot token);
- 81 tests, all offline; a core-boundary check that fails the build.

Not implemented (deliberately out of PoC scope):

- Telegram, website, and phone channels;
- the built-in German A1–C2 library (a licensing decision, see `AGENT.md` §19.2);
- model-fitting of learner-uploaded free text;
- PostgreSQL, and a persisted LangGraph checkpointer;
- persisted learner model credentials — the PoC keeps them in memory only;
- auth beyond the channel identity, and retention/deletion tooling.

## Data and privacy

Learner data — classes, conversations, progress — lives on the **server**, in the
SQLite file. There is no on-device engine and no offline mode. The server is
self-hostable, which is the guarantee we can honestly make: data stays on
infrastructure the operator runs.

Conversation text and the current target material are sent to the configured
model provider. With the built-in default that is a third party; point
`TALK_MODEL_BASE_URL` at a self-hosted OpenAI-compatible endpoint to avoid that.
Message content is never logged at info level.

## Development

```bash
pnpm verify        # type-check + boundary + tests
pnpm test          # vitest, offline
pnpm test:watch
pnpm demo:cli --db=./var/demo.db    # persist the demo across runs
```

### Running the whole loop locally, with no API key

`tools/stub-provider.ts` is a local OpenAI-compatible stub, so the **real**
remote adapter can be exercised over real HTTP without a key or a third party.
Two terminals:

```bash
pnpm stub:model                                   # listens on 127.0.0.1:8787

TALK_MODEL_BASE_URL=http://127.0.0.1:8787/v1 \
TALK_MODEL_API_KEY=stub TALK_MODEL_ID=stub-model \
pnpm demo:cli --live --db=./var/local.db
```

Drop `TALK_MODEL_CAPABILITIES` to exercise the JSON fallback path; set
`TALK_MODEL_CAPABILITIES='{"structuredOutput":true}'` to exercise schema
enforcement. The stub logs one line per request showing which path was used.

The same variables apply to `pnpm start`, so the server host can be pointed at
the stub too — everything except the Discord connection then runs locally.

See `AGENT.md` §16 for the definition of done, and `MVP.md` for the decisions
and the open questions that remain.
