# talk-naturally

A language-learning assistant that skips the admin. On first contact the learner
says which language and level they are studying — and, if they like, which
chapter they are on — and then simply **converses** with an agent that steers the
conversation so they naturally use the vocabulary and grammar they are meant to
learn. Earlier levels can stay in scope for review, and a learner who already has
their own material can upload a document and have it condensed into a personal
class.

When the learner asks a question about the language, the agent answers it in the
class's source language — English for the shipped German and Chinese classes — so
the explanation is never harder to read than the material it explains. The
conversation around the answer stays in the target language.

The learner's only interface is chat. There are no flashcard decks to maintain,
no session planner, and no progress bookkeeping: they show up, talk, and the
software does the rest.

> **Status: proof of concept.** This repository implements the architecture and
> the steering loop specified in `design/`, scoped by `MVP.md`. It is not v1 and
> not production software. See *Scope* below for exactly what is and is not here.

- `design/` — **the specification.** Start at `design/00-index.md`.
- `AGENT.md` — process rules for agents, including the design-docs-first rule.
- `MVP.md` — the proof-of-concept scope and the decision record.
- `idea.md` — non-normative staging register for unreviewed ideas.
- `deploy/` — the systemd unit template and installer.

## Quick start

Requires Node ≥ 22 (for the built-in `node:sqlite`) and pnpm.

```bash
pnpm install
pnpm verify        # type-check, core-boundary check, offline tests
pnpm demo:cli      # the whole loop with a fake model; no network, no API key
```

`pnpm demo:cli` walks the real onboarding (language, level, chapter), asks the
first question as soon as setup finishes, opens a scheduled session, runs a short
conversation that exercises the authored branches (attempt, question,
knowledge-point question, drift — including re-asking a question the learner did
not answer), applies progress, starts a new conversation with `/new`, and then
re-imports the same class to show that ids and progress survive.

To run the same loop against a real provider:

```bash
TALK_MODEL_API_KEY=<your key> pnpm demo:cli --live
```

## Running the chat channels

The server host is the authority for learner state and owns the connection to
every configured chat channel — Discord and/or Telegram, in one process
([`design/72-channels.md`](design/72-channels.md)). The official deployment
pathway is a systemd unit plus an installer
([`design/75-deployment.md`](design/75-deployment.md)).

### Locally, for development

```bash
cp .env.example .env      # then fill it in; never commit it
pnpm start
```

### As a service (deployment)

One Linux host, one server process. The full contract is in
[`design/75-deployment.md`](design/75-deployment.md).

```bash
pnpm install --frozen-lockfile
cp .env.example .env      # then fill it in; never commit it
chmod 600 .env
sudo bash deploy/install.sh --repo "$PWD" --user "$(id -un)"
systemctl status talk-naturally
journalctl -u talk-naturally -f
```

Upgrade with `git pull`, `pnpm install --frozen-lockfile`, and the same
`deploy/install.sh` command — learner data in `var/` is untouched. Remove the
service with `sudo bash deploy/install.sh --uninstall`; `var/` and `.env` are
left in place on purpose. Render the unit without installing anything with
`bash deploy/install.sh --dry-run`.

**At least one channel is required**; configure either or both. Discord needs
`DISCORD_TOKEN` and `DISCORD_APP_ID`; Telegram needs `TELEGRAM_TOKEN`.

| Variable | Meaning |
| --- | --- |
| `DISCORD_TOKEN` | bot token (with `DISCORD_APP_ID`, enables the Discord channel) |
| `DISCORD_APP_ID` | application id, for slash-command registration |
| `DISCORD_GUILD_ID` | optional; registers commands to one guild so they appear instantly |
| `TELEGRAM_TOKEN` | bot token from @BotFather (enables the Telegram channel) |
| `TALK_DB_PATH` | SQLite file for all learner data (default `./var/talk-naturally.db`) |
| `TALK_MODEL_BASE_URL` | any OpenAI-compatible endpoint (default DeepSeek official API) |
| `TALK_MODEL_ID` | model id (default `deepseek-flash`) |
| `TALK_MODEL_API_KEY` | deployer key |
| `TALK_MODEL_CAPABILITIES` | optional JSON capability override for unknown endpoints |
| `TALK_SCHEDULE_HOUR` | hour of the daily session, or empty to disable |
| `TALK_BUILTIN_DIR` | directory holding the built-in level catalog (default `datasets/builtin`) |

In the Discord developer portal, enable the **Message Content** privileged intent
so the bot can read ordinary messages. The `/new` and `/start` commands work
without it.

For Telegram, create a bot with [@BotFather](https://t.me/BotFather), put its
token in `TELEGRAM_TOKEN`, and message it privately. The adapter long-polls the
Bot API, so no webhook, public URL, or certificate is needed
([`design/72-channels.md` §3.1](design/72-channels.md)); it answers in private
chats only. A learner who uses both Discord and Telegram is two learners — the
channels are not merged automatically ([`design/72-channels.md` §4.1](design/72-channels.md)).

One learner per channel: the scheduler delivers a session on the channel that
learner is linked to. A Telegram message that is not a command is a normal turn;
`/new`, `/settings`, `/level`, `/language`, `/chapter`, `/include`, `/exclude`,
`/class`, and `/model` work the same as on Discord.

| Command | Effect |
| --- | --- |
| `/new` | start a new conversation — the app asks something new |
| `/start` | alias for `/new` |
| `/settings` | show your language, level, current chapter, and review scope |
| `/level <A1–C2>` | switch level (the newer level keeps earlier ones in scope for review) |
| `/language <name>` | switch target language |
| `/chapter <n\|start>` | say where you are in the level's chapters |
| `/class <name>` | switch to one of your classes, including an uploaded personal one |
| `/include <level>` / `/exclude <level>` | add or drop an earlier level from the review pool |
| `/model` | show the model in use |
| `/model <key> [model-id]` | use your own provider key (Discord: `/model api_key:…`) — held in memory, never written to storage |

Onboarding also accepts typed answers, so a learner can reply `German`, `中文`,
`A1`, `not sure`, or `chapter 4` to the questions instead of using a command. Typing
`/new` (or `/start`) in chat starts a new conversation on any channel: the
question on the table is dropped and the app asks a new one. Sending a `.txt` or
`.md` file starts the upload → fit → confirm flow for a personal class.

## Approving learners

A publicly reachable bot is an open wallet: every conversation contains a billed
model call, so **nobody reaches the engine until an operator approves them**
([`design/74-access.md`](design/74-access.md)). First contact creates a pending
request — no learner, no onboarding, no model call — and the person is told to
wait. Approved learners work exactly as above; a denied identity is turned away
without a model call.

Approve and deny from the CLI on the server host (same database, no network). The
commands are non-interactive and every one takes `--json`, so a tool-calling
operator or script can drive them:

```bash
pnpm admin pending                                   # who is waiting
pnpm admin list                                      # everyone and their status
pnpm admin approve --channel telegram --user 123456789
pnpm admin deny    --channel discord  --user 123456789012345678
pnpm admin pending --json                             # machine-readable
```

Rules worth knowing:

- **Approval creates the learner** and links the channel identity; it takes effect
  on that person's next message (the admin CLI holds no channel connection).
- The operator sees the platform's display label to recognise someone, but the
  identity is always the numeric channel id.
- **Revoking drops the channel link, not the learner**: classes and progress are
  kept, and re-approving restores the same learner.
- Existing linked learners are grandfathered as approved when the database is
  upgraded, so an upgrade never locks anyone out.
- **Never run two server processes on one database or bot token**
  ([`design/75-deployment.md` §1](design/75-deployment.md)); the admin CLI is not
  a server, it exits after one command.

## How it is put together

Ports and Adapters (hexagonal). Dependency always flows inward; the wiring
happens only in a host, never in the core.

```
Discord  (frontends/discord)  ─┐
Telegram (frontends/telegram) ─┼─►  engine/  (LangGraph turn workflow)
CLI host (hosts/cli)          ─┘         │
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
| Class dataset and knowledge points | `core/domain/knowledge.ts` | grammar · sentence structure · vocab, each with an optional unit/chapter |
| Learner settings | `core/domain/settings.ts` | language, level, class, chapter cursor, review scope; the current chapter is derived |
| Onboarding | `core/onboarding/onboarding.ts`, `engine/onboarding.ts` | deterministic and model-free: language, level, optional chapter; completion starts the first session and asks the first question |
| Review scope | `core/steering/scope.ts` | current level plus included earlier levels, deduped by point id |
| Built-in level catalog | `core/ports/catalog.ts`, `hosts/catalog-file.ts` | languages and levels, loaded from `datasets/builtin/` |
| Stable knowledge-point identity | `core/classes/canonical.ts` | derived from canonical content, never import order |
| Ingestion and reconciliation | `core/classes/ingest.ts` | re-import adds, retires, revives — never reassigns ids or loses progress |
| Document fitting | `core/prompts/fit.ts`, `core/domain/fit.ts`, `engine/ingest.ts` | extract → chunk → model fit → validate → preview → confirm |
| Progress counters | `core/progress/apply.ts` | one place maps a turn decision to counter deltas |
| Derived state | `core/progress/derive.ts` | due / struggle / new / consolidating, recomputed — never stored |
| Steering | `core/steering/select-targets.ts` | pure, deterministic, logged with a reason |
| Turn workflow | `engine/turn-graph.ts` | onboarding is a deterministic route; the model picks a branch for everything else; each reply is written by single-language calls, and the question on the table is re-asked until the learner answers |
| Prompts | `core/prompts/` | versioned behavior artifacts, recorded per turn |

Progress is stored as countable facts only. Mastery, confidence, and "next
review" are derived, so the reasoning stays inspectable and the formula can
change without losing history.

## Model configuration

Resolved in one place, the composition root (`hosts/config.ts`), with this
precedence:

1. **learner override** — a key supplied at runtime via `/model`
2. **deployer configuration** — the operator's endpoint, model, and key
3. **built-in default** — DeepSeek official API with `deepseek-flash`

The core never sees a URL, a key, or a provider name. Capabilities are declared,
never discovered by failing; an unknown endpoint gets the conservative set
(`structuredOutput: false`), and the adapter then prompts for JSON and parses
defensively with one bounded repair. The core validates the result regardless.

The remote adapter speaks the **OpenAI Responses API** (`POST {base}/responses`).
That is not incidental: strict `json_schema` structured output — which the
built-in default uses — is only accepted there, while the chat-completions
surface rejects it outright.

## Scope

Implemented:

- the core domain, ports, and steering loop, with no host, channel, or network;
- a LangGraph per-message workflow with a deterministic onboarding route, the
  four authored teaching branches, single-language model calls (a question and a
  wrong attempt's correction are written in the source language, the next turn in
  the target language), and a re-ask rule that keeps the learner on the question
  on the table until they answer it;
- language/level/chapter onboarding, `/settings` commands, and cross-level review;
- the first question asked automatically once onboarding completes;
- a file-backed built-in catalog with hand-authored German and Chinese A1 and A2
  seed levels;
- upload → model-fit → confirm for personal classes (text and markdown);
- a scheduler that starts sessions, gated on onboarding;
- SQLite storage with a tested v1→v2 class-schema migration, idempotent progress
  writes, and per-learner isolation;
- an OpenAI-compatible model adapter with structured output and a fallback;
- a Discord channel and a Telegram channel over the same core, plus a CLI host,
  with both adapters tested end to end through an injected client/transport (no
  network, no bot token);
- one server process that serves every configured channel over one engine and one
  database, with per-channel identity ([`design/72-channels.md`](design/72-channels.md));
- an **operator approval gate**: unapproved identities create a pending request,
  never a learner, and no workflow or model call runs for them; approval and
  denial are scriptable CLI commands with `--json`
  ([`design/74-access.md`](design/74-access.md));
- an offline test suite and a core-boundary check that fails the build.

Not implemented (deliberately out of PoC scope):

- the website and phone channels;
- explicit cross-channel account linking — a person using both Discord and
  Telegram is two learners until that feature exists
  ([`design/72-channels.md` §4.1](design/72-channels.md));
- rate-limiting pending access requests, proactive approval notification, and
  operator roles or an audit log ([`design/74-access.md` §9](design/74-access.md));
- a durable Telegram update offset (in memory for now), and a `/model` flow that
  does not leave the learner's key in the Telegram chat history;
- the full built-in A1–C2 libraries — the PoC ships hand-authored German and
  Chinese A1/A2 seed levels, and the sourcing and licensing decisions are
  recorded as `D-019` and `D-035` in `design/80-decisions.md` while the German
  C1/C2 fallback and the Chinese B1–C2 bundles stay open;
- pdf/docx/pptx parsing — the document port and pipeline exist and text/markdown
  works, but the parsing dependencies are not chosen yet
  (`design/70-stack.md` §1);
- a persisted upload preview and durable rate limiting (in memory for now);
- PostgreSQL, and a persisted LangGraph checkpointer;
- persisted learner model credentials — the PoC keeps them in memory only;
- auth beyond the channel identity, and retention/deletion tooling.

## Data and privacy

Learner data — settings, classes, conversations, progress — lives on the
**server**, in the SQLite file. There is no on-device engine and no offline mode.
The server is self-hostable, which is the guarantee we can honestly make: data
stays on infrastructure the operator runs.

Conversation text, the current target material, and **the text of any document
you upload for fitting** are sent to the configured model provider. With the
built-in default that is a third party; point `TALK_MODEL_BASE_URL` at a
self-hosted OpenAI-compatible endpoint to avoid that. Message content is never
logged at info level, and the built-in level data shipped in `datasets/builtin/`
is authored for this repository rather than copied from an exam body
(`datasets/builtin/README.md`).

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
the stub too — everything except the channel connections then runs locally.

See `AGENT.md` §7 for the definition of done, `design/` for the specification,
and `MVP.md` for the build report and the open questions that remain.
