# 74 — Learner access and approval

> Specification. Code is written from this document (`AGENT.md` §2).

This document specifies who may use the engine. Chat channels are reachable by
anyone who finds the bot, and every useful conversation contains a **remote,
billed model call** ([20-architecture.md §5](20-architecture.md)). An open bot is
therefore an open wallet: scanners and bots will find it, and each unknown
message could otherwise trigger inference. Access is gated so that **no
LLM-calling workflow runs for an identity an operator has not approved**.

## 1. The rule

**A channel identity may reach the engine only while it is approved.** Until
then the learner receives a deterministic, model-free reply and nothing else
happens:

- no learner record is created;
- no message reaches the engine, the turn graph, or the model port;
- no onboarding, session, settings command, upload, or `/model` is served;
- the scheduler never opens a session ([50-orchestration.md §2](50-orchestration.md)).

Onboarding is itself model-free ([60-ingestion.md §3](60-ingestion.md)), but it
completes into a session that calls the model (D-030), so approval precedes the
whole flow, not just the first billed turn.

## 2. The access record

Access is tracked per **channel identity**, the same unit that becomes a linked
credential ([30-domain-model.md §6](30-domain-model.md)):

```
AccessRequest
├── channel            # "discord" | "telegram" | … (opaque label, see 72-channels.md §1)
├── channel_user_id    # the platform's numeric id; the record key
├── status             # pending | approved | denied
├── display_name       # a mutable label for the operator, never identity (§6)
├── requested_at
├── decided_at
└── learner_id         # null until approved; kept across a revoke
```

**A learner exists only after approval.** A pending identity has no
`learner_id`, no channel link, no settings, and no schedule, so there is nothing
for any workflow to act on. This is deliberate: an unknown scanner must not even
be able to create learner rows.

State transitions:

| From | To | Meaning |
|---|---|---|
| *(none)* | `pending` | first contact creates the request |
| `pending` | `approved` | operator approves: create the learner, link the channel |
| `pending` | `denied` | operator declines |
| `approved` | `denied` | revoked: drop the channel link, keep the learner and all progress |
| `denied` | `approved` | a later approval re-links the same learner; progress survives |

`denied` is terminal only until an operator changes it. Re-approving a revoked
identity restores access to the **same** learner, because the record keeps
`learner_id`.

*Implemented as:* `core/ports/storage.ts` (`AccessRequest`, the access methods)
and the storage adapters.

## 3. First contact

When a message arrives from a channel identity that is not linked
([30-domain-model.md §6](30-domain-model.md)), the adapter resolves access
instead of creating a learner:

- **no record** → create a `pending` request (recording the display label the
  platform provides) and reply that the request is waiting for an operator;
- **`pending`** → reply the same; do not create a second request;
- **`denied`** → reply that access was declined;
- **`approved`** (or already linked) → proceed normally.

The user-facing replies are fixed, model-free strings. They never disclose the
learner's record or any other learner.

*Implemented as:* `frontends/access.ts`, used by every channel adapter
(`frontends/discord/bot.ts`, `frontends/telegram/bot.ts`).

## 4. Approval happens at the CLI

An operator decides with the admin host (`pnpm admin`,
[70-stack.md §3](70-stack.md)): `hosts/admin/main.ts`. It opens the same
database the server uses ([75-deployment.md §1.5](75-deployment.md)) and needs no
network.

| Command | Effect |
|---|---|
| `pnpm admin pending` | list identities waiting for a decision |
| `pnpm admin list` | list every known identity with its status |
| `pnpm admin approve --channel <c> --user <id>` | approve (create + link the learner if needed) |
| `pnpm admin deny --channel <c> --user <id>` | decline, or revoke an approved identity |

Rules:

- **Every subcommand accepts `--json`** and prints one JSON document, so a
  tool-calling operator (an agent, a script, a workflow engine) can decide and
  read the result without parsing prose. Errors go to stderr, exit non-zero, and
  are JSON too. This is the "ability for tool calling": approval is a small,
  typed, non-interactive tool, not a screen.
- **The operator identifies people by the stored display label.** The pending
  list shows `channel`, `channel_user_id`, and `display_name`; the numeric id is
  the key and the label is decoration (§6).
- **Approval takes effect on the learner's next message.** The admin host holds
  no channel connection, so it cannot push a notification; the adapter reads the
  decision from storage on every message. Proactive notification is a TODO.
- **The admin host trusts local database access.** It has no authentication of
  its own: whoever can run it or open the SQLite file is the operator. Access to
  the host is the security boundary ([`AGENT.md`](../AGENT.md) §5).

## 5. Enforcement is two layers

The rule in §1 is enforced twice on purpose, because the cost of a mistake is a
bill:

1. **Channel adapters gate entry.** An unapproved identity is answered by the
   adapter and never reaches the engine (§3). This is where the learner-facing
   reply comes from.
2. **An engine guard gates every workflow.** The server host wraps the engine in
   a guard (`engine/access-guard.ts`) that checks approval before delegating any
   call: `handleTurn`, `startSession`, `startConversation`,
   `handleSettingsCommand`, and `fitDocument` return a deterministic
   `not_approved` outcome without touching the inner engine. This is what makes
   the scheduler safe: a learner whose access was revoked after onboarding still
   has a schedule, and the guard stops the session **before** the opening model
   call.

No path — adapter, scheduler, or a future host — can reach the model port for a
non-approved learner. The guard is the mechanical guarantee; the adapter reply
is the UX.

## 6. Identity and the display label

[30-domain-model.md §6](30-domain-model.md) forbids storing a username or
display name **as identity**, because both change. This document does not weaken
that rule: the storage key is the platform's numeric id, always.

It does allow one exception, for operator review only:

- **A display label may be recorded on an `AccessRequest`** so the human
  approving access can recognise the person. It is mutable, it is never a key,
  never a lookup, and never used for access control, and it is not copied into
  the channel link or any domain record.
- A learner's identity is still the opaque `learner_id` behind the numeric
  channel id ([30-domain-model.md §6–7](30-domain-model.md)).
- The label is personal data and inherits the retention TODO in
  [30-domain-model.md §7](30-domain-model.md).

## 7. Revocation keeps history

Revoking removes the channel link, so the identity can no longer reach the
engine, and the guard stops any scheduled workflow. The learner's classes,
settings, conversations, and progress are **not deleted**: they are keyed by
`learner_id` ([30-domain-model.md §5](30-domain-model.md)), and re-approving the
same identity attaches the same learner again. Deleting learner data stays a
separate, deliberate act.

## 8. Migration and grandfathering

The access table is new. On first open, every existing `channel_links` row is
backfilled as an `approved` request for its learner, so learners who were using
the bot before this change keep working; nobody is locked out by the upgrade.
The backfill is idempotent and runs inside the same open path as the existing
class-schema migration ([70-stack.md §5](70-stack.md)).

## 9. Out of scope

Each item is a TODO, not an implied capability:

- **Rate limiting pending requests.** A scanner can still create one request row
  per identity; the rows are cheap and create no learner, but bounding the write
  rate is a real follow-up ([`AGENT.md`](../AGENT.md) §5).
- **Proactive approval notification** (§4): the learner learns on their next
  message, or out of band.
- **Multiple operators, roles, and an audit log** of who approved what.
- **Admin authentication** beyond local database access (§4).
- **Deleting learner data** and the retention policy
  ([30-domain-model.md §7](30-domain-model.md)).
