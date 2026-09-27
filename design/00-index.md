# 00 — Design docs index

> **These documents are the specification.** Code is written *from* them, never
> the other way round. No feature or behavior change lands in `code` before it
> lands here (see `AGENT.md` §2). If code and a design doc disagree, the design
> doc is right and the code is a bug.

This directory was created by consolidating the design content that used to
live inside `AGENT.md`. `AGENT.md` now only carries the process rules for
agents, plus a map of where everything went.

## The documents

| Doc | Title | What it decides | Primary code |
|---|---|---|---|
| [00](00-index.md) | Index | Where everything lives; how to change a design | — |
| [10](10-overview.md) | Overview and shape | What the product is; server-side engine; channels; deployment modes and v1 scope | all |
| [20](20-architecture.md) | Architecture and invariants | Ports and Adapters, the core boundary, product invariants, the model port | `core/ports/` |
| [30](30-domain-model.md) | Domain model | Class dataset (one class per language+level), knowledge points, progress counters, learner settings and level scope, stable IDs, learner identity, access control | `core/domain/`, `core/classes/`, `core/progress/`, `core/identity/` |
| [40](40-steering.md) | Steering | The deterministic target-selection rule and its weights | `core/steering/` |
| [50](50-orchestration.md) | Conversation orchestration | Sessions on a schedule; the learner's `/new` entry point; the per-message LangGraph workflow (**the illustration**) | `engine/`, `hosts/scheduler.ts` |
| [60](60-ingestion.md) | Knowledge sources and ingestion | One schema, model-fitted; built-in German and Chinese levels; personal knowledge points | `core/classes/` |
| [70](70-stack.md) | Stack and repository layout | Language, engine, storage, tooling, layout, testing rules | whole repo |
| [72](72-channels.md) | Chat channels | The channel adapter contract; which channels exist; the Telegram adapter; one process, many channels; per-channel identity | `frontends/` |
| [75](75-deployment.md) | Deployment | The deployment contract; the v1 systemd pathway; install, upgrade, uninstall | `deploy/` |
| [80](80-decisions.md) | Decision log | Dated decisions and their status | — |

Process and working rules stay in [`AGENT.md`](../AGENT.md). Staged ideas go to
[`idea.md`](../idea.md) (see [90](90-ideas.md)). The proof-of-concept build
report lives in [`MVP.md`](../MVP.md) — it is a status record, **not** a
specification.

## How to change a design

A design change is a **design-doc-first** change, always:

1. **Discuss in `idea.md` first** if the change is not yet agreed. `idea.md` is
   the staging register for unreviewed ideas and is non-normative.
2. **Edit the design doc.** Say what behavior changes and what it replaces.
   Delete the old rule rather than leaving two contradictory statements.
3. **Record the decision** in [80-decisions.md](80-decisions.md) with a date and
   a status (`DECIDED`, `PROPOSED`, `OPEN`, `SUPERSEDED`).
4. **Only then write code**, with tests, referencing the design doc section.
5. **Update the code comments** that pointed at the old rule.

If the change is large, add a new design doc rather than growing an existing one
past the point where it can be read in one sitting.

## Where the old `AGENT.md` sections went

Design content used to live in `AGENT.md`. Historical references to those
section numbers still appear in commits and older notes, so the map is kept
here. (Code comments were updated to cite `design/` directly.)

| Old `AGENT.md` § | Now |
|---|---|
| §1 Project overview | [10-overview.md §1–2](10-overview.md) |
| §2 Prior art, §2.1 LangGraph, §2.2 server-side shape | [20-architecture.md §1](20-architecture.md), [10-overview.md §3](10-overview.md) |
| §3 Framework shape (core/adapters/hosts) | [20-architecture.md §2](20-architecture.md) |
| §4 Boundary guard rails | [20-architecture.md §3](20-architecture.md) |
| §5 Deployment modes and v1 scope | [10-overview.md §4](10-overview.md) |
| §6 Class dataset and progress model | [30-domain-model.md §1–2](30-domain-model.md), [40-steering.md](40-steering.md) |
| §6.3 Steering | [40-steering.md](40-steering.md) |
| §6.4 Stable knowledge-point identity | [30-domain-model.md §4](30-domain-model.md) |
| §6.5 Class lifecycle | [30-domain-model.md §3](30-domain-model.md) |
| §6.6 Learner identity, §6.7 Access control | [30-domain-model.md §6–7](30-domain-model.md) |
| §7 Product invariants | [20-architecture.md §4](20-architecture.md) |
| §8 Model adapter boundary | [20-architecture.md §5](20-architecture.md) |
| §9 Repository layout | [70-stack.md §2](70-stack.md) |
| §10 Tech stack | [70-stack.md §1](70-stack.md) |
| §11 Testing | [70-stack.md §5](70-stack.md) |
| §12 Working agreement | still `AGENT.md` §4 |
| §13 Code style | [70-stack.md §4](70-stack.md) |
| §14 Git conventions | `AGENT.md` §6 |
| §15 Boundaries — ask before touching | still `AGENT.md` §7 |
| §16 Definition of done | still `AGENT.md` §7 |
| §17 Gathering ideas | [90-ideas.md](90-ideas.md), `AGENT.md` §3 |
| §18 Orchestration | [50-orchestration.md](50-orchestration.md) |
| §18.1 Sessions on a schedule | [50-orchestration.md §2](50-orchestration.md) |
| §18.2 Per-message workflow | [50-orchestration.md §3](50-orchestration.md) |
| §19 Knowledge sources and ingestion | [60-ingestion.md](60-ingestion.md) |

## Conventions

- **Cite as `design/NN-title.md §X`** in code comments, commit messages, and
  other docs. Example: `design/40-steering.md §4`.
- **Numbers are stable within a document.** If you must renumber, update the
  `§` references across the repo in the same change.
- **TODOs live in the doc they belong to.** A TODO is not a rule; do not build on
  it as if it were.
- **Diagrams are Mermaid** (renders on GitHub). Keep the Mermaid source in a
  `.mmd` file next to the doc when the diagram is big enough to be maintained on
  its own, and always keep a plain-text fallback in the doc so the diagram is
  still readable where Mermaid does not render.
