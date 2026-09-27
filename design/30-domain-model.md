# 30 — Domain model

> Specification. Code is written from this document (`AGENT.md` §2).

This is the heart of the core, and the part not covered by prior art
([20-architecture.md §1](20-architecture.md)). A **class** is one target language
at one CEFR level (e.g. *German A2*, *German B1*). A chapter inside a level is
not a separate class: it is metadata on the knowledge points, and where the
learner is in it is a per-learner cursor (§8). Each class has a dataset of
knowledge points grouped under three keys: **grammar**, **sentence structure**,
and **vocab**.

## 1. Structure

```
Class (one target language × one CEFR level; imported, built-in, or personal)
├── id, title, source language, target language, level, imported_at, origin
├── grammar[]            ─┐
├── sentence_structure[]  ├─ each entry is a Knowledge Point
└── vocab[]              ─┘

KnowledgePoint (stable identity — see §4)
├── id            # stable, deterministic
├── kind          # grammar | sentence_structure | vocab
├── title         # e.g. "Dativ: mit + dem/der"
├── detail        # explanation / example / translation as imported
├── unit          # chapter label inside the level, e.g. "A2.2 Kapitel 4"
├── unit_order    # numeric order of the unit inside the level
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
self-hostable ([10-overview.md §4](10-overview.md)). A class can be shared or
exported, and progress is personal: it is never silently merged across learners.
A learner's identity spans channels — see §6.

**Keep raw counters, derive the rest.** Store countable facts (`times_seen`,
`times_used`, `times_wrong`, …). Do not store a `mastery` float, a `confidence`
score, or a `next_review_at` as the source of truth — compute those from the
counters so the reasoning stays inspectable and the formula can change without
losing history. A short `notes` string is fine to keep, but it is a hint, not the
model.

## 2. How progress is updated

- Updates happen **once per turn**, at the end of the workflow, from the model's
  structured output — not by the model writing to storage.
- The model identifies *knowledge points by ID*. Matching corrections or targets
  back to IDs by fuzzy text matching is a bug factory; if the model cannot
  supply an ID, treat the signal as unattributed and log it.
- A learner attempt can legitimately produce several facts at once (used
  correctly → `times_used += 1`; also seen → `times_seen += 1`). Define the
  mapping in one place and test it.
- Re-reading a message, retrying a failed turn, or replaying a session **must
  not** double-count. Make updates idempotent per (turn, knowledge point).
- Progress is never reset by a re-ingestion; see §4.

*Implemented as:* `core/progress/apply.ts` (`mapTurnDecisionToDeltas`) and the
idempotent `applyProgressDeltas` storage operation.

## 3. Class lifecycle

- **Imported:** a class imported from learner-supplied material.
- **Built-in:** the server ships a library of default classes the learner picks
  from instead of importing, starting with German and Chinese A1–C2
  ([60-ingestion.md §3](60-ingestion.md)). A built-in class is just a class with
  `origin: "builtin"`; do not special-case it. The PoC ships hand-authored seed
  levels for German A1/A2 and Chinese A1/A2 only; the remaining levels are the
  target in [60-ingestion.md §3](60-ingestion.md).
- **Personal:** a custom level is a personal class (`origin: "personal"`), seeded
  from a built-in level or created empty; its mapping is its set of knowledge
  points ([60-ingestion.md §5](60-ingestion.md)).
- Material may be messy or incomplete. Parsing and normalizing it into knowledge
  points is a real, testable unit, and failures are surfaced to the learner in
  conversation rather than crashing the session.

## 4. Stable knowledge-point identity (critical)

Progress is worthless if IDs move. When the same class is re-imported, or the
same material is ingested twice, knowledge points **must map to the same IDs** or
the learner's history is silently orphaned.

- Derive IDs deterministically from stable content (e.g. a normalized hash of
  kind + canonical title), not from import order or a fresh UUID per ingestion.
- Re-importing or re-fitting a class must **reconcile**: match existing IDs, add
  genuinely new points, and mark removed ones as retired rather than deleting
  them — progress rows reference them.
- Never rewrite or reassign an existing knowledge-point ID.
- A test must cover "ingest twice → no duplicate points, progress preserved."

*Implemented as:* `core/identity/` and `core/classes/canonical.ts`; the exact
scheme and worked example are recorded in
[80-decisions.md](80-decisions.md) and `MVP.md` §5.3. Changing this scheme later
orphans history — changing the scheme is an ask-first change.

## 5. One learner, one progress record

Regardless of channel or source, progress belongs to one learner (§6). A point
present in both the built-in library and a personal upload must not split the
learner's counters (§4).

Progress is keyed per (learner, knowledge point), not per class. A knowledge
point that appears in two levels of the same language — a review item carried
from A1 into A2 — therefore has one id and one set of counters, so including an
earlier level in the current scope (§8) reviews the learner's real history
instead of starting a second one.

## 6. Learner identity across channels

One learner may reach the engine through Discord today and through Telegram, the
website, or a phone client later. Progress is per learner, so identity must be
resolved before progress is read or written.

- **The anchor is an opaque `learner_id` generated by the server.** It is not a
  channel id, so adding a channel never rewrites existing rows.
- **Channel identities are linked credentials.** A Discord user id and a Telegram
  user id each map to exactly one `learner_id`. The link table belongs to the
  identity/storage layer, never to the domain.
- **Store the channel's own numeric id.** Use the Discord user id (snowflake) or
  the Telegram user id, never a username, handle, or display name — those change.
- **A display label may be stored on a pending access request only.** It exists
  so the human operator can recognise the person asking for access; it is mutable
  decoration for review, never a key, a lookup, or an identity
  ([74-access.md §6](74-access.md)). It is not copied into the channel link or any
  domain record.
- **Linking is explicit, and v1 links one credential per learner.** Never guess
  that two channel identities are the same person. First contact on each channel
  creates its own learner, so the same person using Discord and Telegram is two
  learners until an explicit linking feature exists
  ([72-channels.md §4.1](72-channels.md)).
- **v1:** the Discord user id and the Telegram user id are each a linked
  credential for the learner they created. How a learner is provisioned on first
  contact is specified in §7.

*Implemented as:* `core/identity/identity.ts`.

## 7. Access control

- **Material and progress are persisted server-side and scoped to one
  `learner_id`.** Every read and every write resolves the caller's identity first
  and is filtered by it.
- **Cross-learner access must be impossible by construction, not by
  convention.** Queries take the `learner_id` as a required argument at the
  storage boundary, so a forgotten filter fails loudly instead of leaking rows.
- **A channel identity is a credential, not a password.** Trust comes from the
  channel's authenticated sender plus the bot token; state the blast radius if
  the token leaks (`AGENT.md` §5).
- **Access is gated before any workflow runs.** A channel identity may reach the
  engine only while an operator has approved it; a pending or denied identity
  creates no learner, has no schedule, and triggers no model call
  ([74-access.md](74-access.md)). This is a spend control as much as an access
  control: an open bot is an open wallet.
- **Revoking access drops the channel link, never the learner.** Classes,
  settings, conversations, and progress are keyed by `learner_id` and survive a
  revoke, so re-approval restores the same learner
  ([74-access.md §7](74-access.md)).
- **Only the `learner_id` is domain data.** Channel ids, and any display names or
  usernames, stay in the identity layer.
- TODO: retention and deletion policy for learner data and channel ids; whether
  channel ids are ever logged; rate-limiting pending access requests; explicit
  account linking, so one person can reach one learner from more than one
  channel ([72-channels.md §4.1](72-channels.md)); and access control for the
  website and phone channels once a channel id alone is not sufficient (a
  session/token layer). First-contact provisioning is no longer open: it is the
  approval gate in [74-access.md](74-access.md).

## 8. Learner settings and level scope

A learner's target language, level, and chapter are persisted state, not a prompt
convention. There is one settings record per learner, stored behind the storage
port ([20-architecture.md §2](20-architecture.md)) and scoped by `learner_id`
like every other table (§7).

```
LearnerSettings
├── learner_id
├── target_language      # e.g. "German"
├── level                # the current class's CEFR level, e.g. "A2"
├── class_id             # the current built-in or personal class
├── known_through_unit   # units before this cursor are assumed known
├── included_levels[]    # previous levels in scope for review, in order
├── onboarding_step      # language | level | chapter | done
└── updated_at
```

- **The current chapter is derived, never stored.** It is the lowest
  `unit_order` at or above `known_through_unit` that still has unseen points
  ([40-steering.md §2](40-steering.md)). Storing it would create a second source
  of truth for a fact the counters already answer (§1).
- **`known_through_unit` is the learner's statement, not a measurement.** It
  skips chapters the learner has already studied; lowering it brings earlier
  chapters back into scope.
- **`included_levels` widens the steering scope, not the class.** The candidate
  pool is the current class plus these classes, deduped by knowledge-point id
  ([40-steering.md §2](40-steering.md)); unseen points in an included level are
  background and are never taught as new material.
- **First-run onboarding writes this record.** Until it is complete, no session
  opens ([50-orchestration.md §2](50-orchestration.md)) and no teaching turn runs
  ([50-orchestration.md §3.2](50-orchestration.md)).
- **Settings are personal data.** They describe what a learner is studying and
  are covered by the retention and deletion policy TODO in §7, like progress and
  conversations.
