# 72 — Chat channels

> Specification. Code is written from this document (`AGENT.md` §2).

This document specifies the **driving adapters** that expose the engine to chat
platforms. It defines the contract every channel adapter satisfies (§1), records
which channels exist (§2), and specifies the **Telegram** adapter (§3), the
runtime shape that serves more than one channel from one process (§4), and the
testing rules for channel adapters (§5).

The core stays channel-agnostic throughout: nothing here may leak into `core/`
([20-architecture.md §2](20-architecture.md)), and a channel concept must not
appear in the domain ([20-architecture.md §3](20-architecture.md)).

## 1. The channel adapter contract

A channel adapter is a **driving adapter**: it translates platform events into
engine calls and engine replies into platform messages, and owns every platform
concern. It is the only place that knows a platform's id format, message limits,
attachment mechanism, and transport.

Every adapter implements the same small surface, so the host can start, stop, and
deliver through any of them without branching on the platform
(`frontends/…/bot.ts`):

| Member | Responsibility |
|---|---|
| `start()` | connect to the platform and begin receiving events |
| `stop()` | stop receiving events and release the connection gracefully |
| `sendToLearner(learnerId, text)` | deliver a proactive (scheduler-started) message; returns `false` when the learner has no linked identity on this channel or delivery fails |

Rules that apply to every channel adapter:

- **It resolves identity and nothing else about the learner.** First contact
  creates a `learner_id` and links the platform's own user id
  ([30-domain-model.md §6](30-domain-model.md)); all other state is reached
  through the engine.
- **It makes no product decision.** Turn routing, onboarding, settings parsing,
  progress, and steering belong to the engine. The adapter recognises the
  channel's command syntax and passes it to the engine's one text-command entry
  point.
- **It validates the platform's own id format.** A username, display name, or
  handle is never stored as identity
  ([30-domain-model.md §6](30-domain-model.md)); each adapter enforces that rule
  for its platform in its own `identity.ts`.
- **It does not log message content at info level**
  ([`AGENT.md`](../AGENT.md) §4.7). Ids and event labels are safe; text is not.
- **It is tested with an injected transport**, so the whole translation layer
  runs with no network and no bot token (§5).
- **It may expose learner model configuration.** Where the host wires a
  `ModelAdmin`, the adapter's `/model` command shows the effective model and sets
  an in-memory learner key. The contract is channel-neutral
  (`frontends/model-admin.ts`); no provider detail reaches the frontend.

## 2. Which channels exist

Channel order is Discord → Telegram → website → phone thin clients (D-003).

| Channel | Status | Transport | Notes |
|---|---|---|---|
| **Discord** | shipped | `discord.js` v14, gateway | the first v1 channel; the gateway protocol is why a library is used |
| **Telegram** | shipped | Bot API over `fetch`, long polling | §3 |
| Website | not started | — | must not introduce forms or a progress screen |
| Phone thin clients | not started | — | chat only; no on-device engine |

## 3. The Telegram adapter

### 3.1 Transport: the Bot API over `fetch`, long polling

- **No channel SDK.** The adapter calls the Bot API directly over `fetch`
  (`https://api.telegram.org/bot<token>/<method>`) behind a small `TelegramTransport`
  interface. This keeps the dependency surface at one channel SDK (Discord's,
  which earns its place because of the gateway) and follows the same
  "no provider SDK, use `fetch`" discipline as the model adapter
  ([20-architecture.md §5](20-architecture.md)). It also keeps the adapter
  testable by injecting a fake transport.
- **Long polling, never a webhook.** The deployment contract forbids an inbound
  listener ([75-deployment.md §1.2](75-deployment.md)); `getUpdates` dials out
  and needs no port, TLS certificate, or reverse proxy.
- **The token is a host secret**, read from the environment by the composition
  root and never by the adapter's callers ([75-deployment.md §1.4](75-deployment.md)).
- **The update offset is in-memory in the PoC.** On startup the adapter skips
  the pending backlog by asking for the last update and continuing after it, so a
  restart does not replay old messages. A durable offset is a TODO; long-poll
  redelivery is bounded by Telegram's own update retention.

### 3.2 Scope: private chats, full parity with Discord

The Telegram channel ships with the same learner-facing surface as Discord:

- text turns through the engine's turn workflow;
- `/new` and its alias `/start` (the engine's new-conversation entry point,
  [50-orchestration.md §2](50-orchestration.md));
- the settings commands `/settings`, `/level`, `/language`, `/chapter`, and the
  rest of the one text-command path ([30-domain-model.md §8](30-domain-model.md));
- document uploads fitted into a personal class
  ([60-ingestion.md §5](60-ingestion.md));
- `/model` to show the effective model and set a learner-supplied key.

**Private chats only.** A group is not a learner: several people would share one
conversation and see each other's messages, which breaks the "material and
progress are scoped to one `learner_id`" rule
([30-domain-model.md §7](30-domain-model.md)). The adapter ignores updates from
groups, channels, and other bots, and registers its commands for private chats.

**Message length.** Telegram caps a message at 4096 characters; the adapter clips
longer replies, as the Discord adapter clips at its own limit. Both are channel
concerns, not core ones.

**Learner model key.** `/model <api_key> [model_id]` sets an in-memory override
for the run, exactly as Discord does. The adapter warns that Telegram keeps the
message, and the key is never written to storage. A flow that does not leave the
key in the chat history is a TODO.

## 4. One process, many channels

The server host is **one process** that starts every channel whose token is
configured, over one engine, one storage instance, and one scheduler
([10-overview.md §4](10-overview.md)). This is the runtime reading of the
deployment contract's "one instance per database" rule
([75-deployment.md §1.1](75-deployment.md)).

- **At least one channel is required.** The host refuses to start with no channel
  token, because the engine's only interface is chat
  ([20-architecture.md §4.2](20-architecture.md)).
- **Each bot token is used by exactly one process.** Several configured channels
  in one process satisfy this; running a second process against the same token or
  the same database does not.
- **The scheduler is started once**, after every channel has connected, and
  delivers through the channel the learner is linked on
  ([50-orchestration.md §2](50-orchestration.md)). In v1 a learner has exactly one
  linked channel (§4.1), so delivery is unambiguous.

### 4.1 Identity is per channel; linking is not automatic

**A channel identity is a credential, and only one is linked per learner in
v1.** First contact on Discord and first contact on Telegram each create their
own `learner_id`. The same person who uses both channels is **two learners** until
an explicit linking feature exists — the adapter never guesses that two channel
identities are the same person
([30-domain-model.md §6](30-domain-model.md)).

This keeps the access-control rule true: a learner's material and progress are
reachable only through the credential they arrived with. Explicit account linking
remains a future feature; it needs its own design (a proof of ownership on both
channels, and a merge story for the two progress records).

## 5. Testing channel adapters

A channel adapter is tested with an **injected transport** (Discord: an injected
client; Telegram: an injected `TelegramTransport`). The whole translation layer —
first contact, identity resolution, onboarding, settings commands, command
parsing, attachments, turn dispatch, and proactive delivery — runs with no
network and no bot token, against the real engine, catalog, and document
adapters. `start()` against the live platform stays unverified until it runs
against a real bot ([70-stack.md §5](70-stack.md)).

New adapters must not change existing behavior: adding Telegram leaves the
Discord adapter, the engine, and the core untouched
([20-architecture.md §4.10](20-architecture.md)).
