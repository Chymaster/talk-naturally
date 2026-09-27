# 10 — Overview and shape

> Specification. Code is written from this document (`AGENT.md` §2).

## 1. What the product is

**talk-naturally** is a language learning assistant. On first contact the learner
says which language and level they are studying, or brings the material they are
already studying (e.g. *"German A1.2, chapter 8 — talking about how to get to
places; vocabulary: …; grammar: …"*), and then simply **converses** with the
agent about that material. The agent steers the
conversation so that the learner naturally uses the vocabulary and grammar they
are meant to be learning, and answers grammar questions along the way.

**Core product promise:** the learner never has to manage the admin of learning.
No flashcard decks to maintain, no session planner, no progress bookkeeping.
They show up, talk, and the software does the rest.

## 2. What we are building

One **server-side engine**, driven by pluggable chat channels. The repository
produces a **backend** (conversation orchestration, class datasets, progress,
steering) built on **LangGraph**, plus the **adapters** that expose it to chat
channels.

The same engine backs every channel: **Discord and Telegram** ship today; a
website and eventually thin clients on phones follow. Channels are added one at a
time and never change the domain ([72-channels.md](72-channels.md)). See §4 for
the v1 scope and §3 for why the engine is server-side.

## 3. The engine is server-side; learner data lives on the server

All application logic, and the learner's classes, conversations, and progress,
live in a **server host** — a self-hostable process, so the operator controls
the data. There is no on-device engine and no local-first mode: a client must
reach the server to converse.

**The language model is remote** and is reached as a dependency behind an
interface ([20-architecture.md §5](20-architecture.md)). Concretely:

- the learner's classes, conversations, and progress are stored **on the
  server**, not on the device;
- the engine runs **in the server host**, which is the authority for learner
  state;
- one external dependency — the model provider — is called over the network.

### 3.1 The engine is LangGraph

**Decision: the conversation workflow is built on
[LangGraph](https://github.com/langchain-ai/langgraph).** LangGraph ships for
**Python and JS only** — no Kotlin Multiplatform, no native mobile — so it
cannot run inside a phone app. That is precisely why the engine is server-side:
the framework's supported shape and our architecture now agree.

The on-device alternatives were evaluated and are now **superseded, not rejected
on quality**:

- **Koog** (JetBrains) is Kotlin Multiplatform with graph strategies available on
  JVM, Android, iOS, JS, and WasmJS. It was the portable option while an
  on-device core was the plan; with the engine server-side it buys nothing we
  need.
- **MobileGraph** was already immature (`0.5.0-alpha`, Android-first) and is
  irrelevant for the same reason.

Rules that still apply:

- **Do not let LangGraph types leak into `core/`.** Wrap the engine behind the
  core boundary so the domain stays testable and the engine stays swappable.
- **The graph is code.** A LangGraph graph is a prompt-behavior artifact:
  versioned, reviewed in diffs, and treated with the same care as a prompt
  ([20-architecture.md §4](20-architecture.md)).
- **Checkpointing is infrastructure.** LangGraph checkpointers live outside the
  domain, behind the storage port.

General principle: *a framework is justified when the orchestration logic
exceeds what a plain state machine handles cleanly.* The per-message decision
workflow ([50-orchestration.md](50-orchestration.md)) is that case — intent
classification has no deterministic derivation, so the model routes among
authored branches.

### 3.2 Why server-side, and what it withdrew

The engine runs in a server host, and every learner-facing channel is a client
of it. This was decided deliberately on 2026-09-20, replacing the earlier
local-first plan, because LangGraph has no on-device target (§3.1) and because
chat platforms such as Discord and Telegram require a reachable server anyway.

- **The server is the authority** for learner state, and it is
  **self-hostable**, so the operator controls the data (§4).
- **Channels are adapters.** Discord and Telegram ship today; a website and
  phone thin clients follow ([72-channels.md](72-channels.md)). Adding one must
  never touch the domain.
- **The earlier local-first promise is withdrawn.** Do not claim that learner
  data stays on the learner's device.

The part of our design that is *not* covered by prior art remains the domain
itself — class datasets, per-knowledge-point progress, and progress-driven
steering ([30-domain-model.md](30-domain-model.md),
[40-steering.md](40-steering.md)). That is the actual invention here, and where
engineering effort should go.

## 4. Deployment modes and v1 scope

**Decision (v1): one server host, remote model, Discord and Telegram as the chat
channels.** The engine and learner data live on a server the operator controls;
the model is remote. The server host is **self-hostable**, and "self-hostable" is
the data guarantee we can honestly make: data stays on infrastructure the
operator runs, not on the learner's device.

Channel order — add one at a time, each as a driving adapter
([72-channels.md](72-channels.md)):

1. **Discord bot (v1).** Shipped.
2. **Telegram bot.** Shipped; one server process serves both channels
   ([72-channels.md §4](72-channels.md)).
3. **Website.**
4. **Phone thin clients.**

Consequences:

- **A client cannot converse without the server.** There is no offline mode and
  no on-device engine. **Never claim offline conversation support, and never
  claim learner data stays on the learner's device.**
- **The server owns learner data.** Conversations, classes, and progress are
  personal data on the server. Auth, data placement, retention, and backups are
  real obligations, not accidents ([30-domain-model.md §6](30-domain-model.md)).
- **The core must still not make network calls.** Reachability, retries, auth,
  and provider specifics belong to the remote model adapter, behind the model
  port.
- **Do not start with every channel.** The website and phone clients are not
  built. "Do not start with three" still applies to the surface area we maintain.

## 5. Related documents

- Core boundary and ports: [`design/20-architecture.md`](20-architecture.md)
- Domain model and access control: [`design/30-domain-model.md`](30-domain-model.md)
- Process rules for agents: [`AGENT.md`](../AGENT.md)
