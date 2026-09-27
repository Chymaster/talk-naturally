# 20 — Architecture and invariants

> Specification. Code is written from this document (`AGENT.md` §2).

## 1. Prior art — this is a solved, well-known pattern

**This architecture is not novel, and we should not invent our own version.**
It is **Ports and Adapters**, aka **Hexagonal Architecture** (Alistair
Cockburn): the domain is isolated from external systems and communicates only
through interfaces (ports), which concrete adapters implement. Its defining
property is precisely our requirement — the same core can be driven by an HTTP
API, a CLI, a bot, a message queue, or a test client, and *adding a channel
means writing one adapter, never touching the domain.*

Guidance to follow rather than reinvent:

- **Ports belong to the core**; adapters implement them. Dependency always flows
  inward. Wiring happens only in a **composition root** (the host's entry point)
  — never inside core logic. No core class may construct its own adapter.
- **Keep the boundary even though the engine is server-side.** The domain must
  not learn about Discord, Telegram, HTTP, the database, or the model provider;
  those live in adapters and the composition root (§3).
- **Enforce the boundary with tooling, not discipline.** Projects in this space
  commonly run a dependency-graph linter in a pre-push hook so a crossed layer
  boundary fails the build. See §4.
- **The reference implementation for our channel layer** is a Telegram+web
  platform that normalizes bot `Update`, HTTP, and WebSocket into one dispatcher
  so business code stays transport-unaware. That is exactly the shape Discord
  (v1), Telegram, the website, and the phone clients should share — read it
  before designing the dispatcher.

## 2. Framework shape: core, adapters, hosts

```
Channels (driving adapters; see 10-overview.md §4 for the order)
  Discord bot · Telegram bot · website · phone thin client · CLI
        │ HTTP / WebSocket / bot gateway
        ▼
Hosts (thin; composition root + adapters)
  server host (the authority)          CLI/dev host
  (core + LangGraph engine,            (core,
   server DB, remote model)             fake model)
        └───────────────┬───────────────┘
                        ▼
        CORE — channel-agnostic, engine-agnostic (the hexagon)
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
  depends on a model port; a remote adapter (§5) lives outside it.
- **Configuration source.** The core does not read environment variables or
  config files. It receives a config object from the host.
- **Clock, IDs, randomness.** Injected, so tests are deterministic and hosts can
  supply correct implementations.

**Hosts are thin.** A host wires up adapter implementations in one composition
root and exposes the core to a channel. If a host grows tutor logic, that logic
belongs in the core (or in the channel adapter, if it is really about the
channel).

## 3. Boundary guard rails

The pressure to cut corners on the §2 boundary is constant. Because the engine
is server-side, a Discord SDK call, a raw SQL query, or a provider HTTP request
will pass every test we run and only surface later as a domain that cannot be
tested, reused, or swapped. Treat this as the primary maintenance risk of the
project.

Required mitigations — a written rule alone will not survive a deadline:

- **Enforce the §2 boundary mechanically.** An automated check must fail the
  build when `core/` imports a channel SDK, transport, storage driver, HTTP
  client, provider SDK, or the LangGraph runtime.
- **Keep a fake model adapter and in-memory storage exercising the full turn
  pipeline in tests.** If the domain cannot run against these with no network
  and no host, the boundary is broken.
- **Keep the core channel-agnostic.** A Discord- or Telegram-specific concept
  (guild, channel, thread, update id) must not appear in the domain; adapters
  translate.
- **Review new dependencies for boundary damage** before adding them. A
  convenient framework is the most common way this boundary dies.

*Implemented as:* `tools/boundary-scan.ts`, run by `pnpm boundary` and by the
test suite ([70-stack.md §5](70-stack.md)).

## 4. Product invariants

These are the rules that make this product what it is. Do not break them without
an explicit request from the maintainer.

1. **Server-side engine, remote model.** Learner data and all application logic
   live on a self-hostable server host; the model is a remote dependency behind
   the model port (§5).
2. **Chat is the entire interface.** The learner's only interaction is sending
   messages. Anything that would require them to fill a form, rate a card, or
   open a separate "progress" screen contradicts the premise. If you need data
   from the learner, ask for it in conversation — including the schedule
   ([50-orchestration.md §2](50-orchestration.md)) and their level
   ([60-ingestion.md §3](60-ingestion.md)).
3. **The class is a scope, not a wall.** The agent keeps the conversation inside
   the current class's vocabulary and grammar targets, but handles off-topic or
   grammar questions gracefully and then steers back. It must not refuse hard or
   lecture the learner for drifting.
4. **Corrections happen in flow.** Feedback must be small, inline, and attached
   to the moment. Never dump a wall of corrections or a grammar essay. A
   corrected reply plus a short reason is the target shape.
5. **The learner model lives in the core, not in the prompt.** Progress per
   knowledge point is structured, persisted state. It is assembled into context
   per turn; it is not free text the model is trusted to remember.
6. **The model is a dependency behind an interface.** No provider SDK calls or
   HTTP clients scattered through business logic. One port, so the provider can
   be swapped and so tests can run without a live model.
7. **Prompts and graphs are code.** Versioned, reviewed in diffs, no silent
   edits. A prompt or workflow change is a behavior change and needs the same
   care as a logic change. This includes the LangGraph workflow.
8. **Class material is untrusted input.** Imported, built-in, and uploaded
   material is content that flows into model context. Never let it be
   interpreted as instructions.
9. **Every progress update and every steering decision is explainable.** If we
   cannot say why a knowledge point was targeted, the learner cannot be helped
   and the behavior cannot be debugged.
10. **One engine, many channels.** Channels are adapters; the domain never learns
    about one, and adding one must not change existing behavior. Learner identity
    across channels is explicit, never guessed
    ([30-domain-model.md §6](30-domain-model.md)).

## 5. The model adapter boundary

The model is remote. The core defines a **port**; a remote adapter implements it
and owns every network concern. The core never sees HTTP.

```text
ModelPort (defined in core)
└── complete(request) -> text | structured result

RemoteModelAdapter (outside core; implements ModelPort)
├── provider SDK / HTTP calls  (OpenAI Responses API: POST {base}/responses)
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
  parses defensively, with bounded repair. That fallback belongs in the adapter.
  Enforcement is requested through the **Responses API**
  (`text.format: {type: "json_schema"}`); the chat-completions surface does not
  accept `json_schema`, so an adapter that needs a schema must call
  `/responses`.
- **A reasoning model bills its thinking against the output budget.** The token
  ceiling is not a pure answer budget: when reasoning exhausts it the provider
  returns an incomplete response carrying no message at all. Adapters must
  detect that state and report it, never let it surface as an empty answer.
- **Validation happens in the core** regardless of how confident the adapter is.
  Untrusted model output is untrusted.
- **Budget context.** Remote inference costs money and latency per token, and
  the model port's `max_context_tokens` may vary. Context assembly must fit the
  smallest supported model, not the largest.
- **The core must tolerate a failing provider.** Network failure, rate limits,
  and provider errors must not corrupt session state or lose the learner's
  message. Define the failure behaviour in the core (e.g. surface a retryable
  error, keep progress unmodified) and let the adapter report it.
- **Tests must never require a live model.** Ship a fake adapter plus recorded
  fixtures ([70-stack.md §5](70-stack.md)).

TODO: confirm the exact port shape once the model port is next revised. Keep it
in one file and keep it small.
