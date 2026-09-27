# 60 — Knowledge sources and ingestion

> Specification. Code is written from this document (`AGENT.md` §2).

Three sources feed one schema. A class is always *a class* — the `origin`
field distinguishes how it arrived, and nothing downstream special-cases it
([30-domain-model.md §3](30-domain-model.md)).

## 1. One schema, model-fitted

- The knowledge dataset has **one schema**, defined by the core
  ([30-domain-model.md §1](30-domain-model.md)). Every source — built-in,
  imported, or personal — is fitted into it; there is no per-source shape.
- The schema is **versioned**, and changing it requires tested migrations
  ([70-stack.md §5](70-stack.md)). Keep `raw_source` so a re-fit stays possible
  and debuggable.
- **Uploaded material is analysed by the model and fitted into the schema.**
  Fitting creates knowledge points whose IDs are derived deterministically from
  canonical content ([30-domain-model.md §4](30-domain-model.md)); **the model
  never assigns IDs**.
- **Model fitting must never attribute progress.** Creating a point from free
  text is fine; matching an upload onto an existing ID for progress is not
  ([30-domain-model.md §2](30-domain-model.md)). Unattributable signals are
  logged, not guessed.
- Fitting runs through the model port
  ([20-architecture.md §5](20-architecture.md)), and its output is validated in
  the core like any other model output. A failed or partial fit is surfaced in
  conversation, never a crash.
- **Where fitting runs.** Document text extraction happens in an adapter behind a
  new `core/ports/documents.ts` port; the fitting prompt and the validation of
  the model's proposed content live in `core/`; chunking, preview, confirmation,
  and import are orchestrated in `engine/` ([70-stack.md §2](70-stack.md); see
  §5). The model proposes content only — **ids are always assigned by the core**
  (`fitClass`).
- TODO: whether an "other/unclassified" kind is allowed beyond grammar, sentence
  structure, and vocab; the duplicate policy against existing points; the
  confirmation flow when a fit is uncertain.

## 2. Re-ingestion must preserve history

The reconciliation rules in [30-domain-model.md §4](30-domain-model.md) are the
contract: match by ID, insert genuinely new points, mark missing ones retired,
never delete, never reassign. The regression test is **"ingest twice → no
duplicate points, progress preserved."**

*Implemented as:* `core/classes/ingest.ts`, `core/classes/canonical.ts`.

## 3. Built-in language levels

- The server ships a **built-in library of languages for A1–C2**, one class per
  (language, level) ([30-domain-model.md §1](30-domain-model.md)). A built-in
  class is a class with `origin: "builtin"`; do not special-case it. The PoC
  ships hand-authored seed levels for **German A1/A2 and Chinese A1/A2**; the
  remaining levels are the target, and their sourcing is §3.1–§3.2.
- **On a fresh start the app asks which language and level the learner is
  studying now**, then optionally a starting chapter. The questions are asked in
  conversation and answered without a model call
  ([50-orchestration.md §3.2](50-orchestration.md)). "Not sure" starts at the
  lowest level and stays changeable ([30-domain-model.md §8](30-domain-model.md)).
  When the last answer completes setup, the app starts the first session and
  asks the first question in the same reply
  ([50-orchestration.md §2](50-orchestration.md)); if the provider is
  unavailable, the setup confirmation is delivered instead, so onboarding still
  completes without a model key.
- **Licensing stance: derive and attribute.** Every built-in source is
  copyrighted or otherwise restricted. The library ships derived knowledge points
  only: our own titles and explanations, `raw_source` pointers back to the
  source, and attribution in
  [`datasets/builtin/README.md`](../datasets/builtin/README.md). **No source
  PDF, word list, or character list is vendored into the repository.** The
  accepted risk for German is recorded as `D-019`, and the same stance extends to
  Chinese as `D-035` in [80-decisions.md](80-decisions.md).
- **How the library is versioned.** A level bundle is re-imported through the
  same reconciliation rules as any class: match by id, add, retire, revive, never
  reassign, progress preserved ([30-domain-model.md §4](30-domain-model.md)).
- The PoC ships one committed fixture class in `datasets/`, ingested through the
  same path a model fit will use (`MVP.md` §5.6).

### 3.1 German

- **Sources.** A1–B1 are derived from the Goethe-Institut Wortlisten (A1, A2, B1)
  and the DTZ list; B2 is derived from telc's lesson-organized *Wortschatzlisten*
  for *Einfach besser!* (B2 Beruf), whose Lektionen also supply unit labels. C1
  and C2 have **no official word list anywhere** — Goethe's own C2 handbook
  points at the commercial *Profile deutsch A1–C2 v2.0* — so their construction
  is an open question (TODO below).
- TODO: the **C1/C2 fallback**, not yet confirmed by the maintainer — frequency
  bands (A1 1k, A2 2k, B1 3k, B2 5k, C1 8k, C2 16k) plus CEFR descriptors,
  validated against the ÖSD C1 and Goethe C2 model papers, and labelled as an
  estimate. Until it is confirmed, C1/C2 bundles are not built; the risk of a
  purely frequency-derived C-level list is that it is not exam-aligned.

### 3.2 Chinese

- **Standard.** Chinese levels derive from the **Chinese Proficiency Grading
  Standards for International Chinese Language Education** (《国际中文教育中文水平
  等级标准》, GF 0025-2021), issued by the Ministry of Education and the State
  Language Commission, effective 2021-07-01. Its four lists — 音节表 (syllables),
  汉字表 (characters), 词汇表 (vocabulary), and 语法等级大纲 (grammar) — are the
  knowledge-point source. It is the successor to the 2010 汉语国际教育用音节汉字
  词汇等级划分 (GF 0015-2010), whose 初等/中等/高等 framework and cumulative
  counts it adopts.
- **Bands and size.** The standard has three stages and nine bands: 初等
  (elementary, bands 1–3), 中等 (intermediate, 4–6), 高等 (advanced, 7–9).
  Cumulative vocabulary is 500 / 1272 / 2245 / 3245 / 4316 / 5456 / 11092 words;
  characters are 300 per band through 1800 at band 6, then 3000 for bands 7–9;
  the grammar syllabus lists 48 / 129 / 210 / 286 / 357 / 424 / 572 cumulative
  points. Bands 7–9 are published as **one merged band and one word list**, not
  three.
- **CEFR mapping (our estimate).** The repo labels Chinese classes A1–C2 like any
  other language, so the nine bands are mapped onto six classes: **A1 = bands
  1–2, A2 = band 3, B1 = band 4, B2 = band 5, C1 = band 6, C2 = bands 7–9**.
  This is a widely published third-party alignment (for example Mandarin Zone's
  chart), and it uses each band exactly once. It is **not official**: the test
  authority has published no band-by-band HSK↔CEFR table, the standard's own
  三等 grouping places bands 4–6 in 中等 and 7–9 in 高等, and published
  third-party charts disagree from band 2 upward. The mapping is therefore
  recorded as `PROPOSED` in `D-035` and must not be presented to a learner as an
  official equivalence.
- **Exam-facing cross-check.** Chinese Testing International publishes the HSK
  3.0 syllabus, the exam-facing document derived from the standard; a revised
  syllabus (November 2025, for implementation from July 2026) carries different
  per-band counts (roughly 300 / 500 / 1000 / 2000 / 3600 / 5400 for bands 1–6,
  about 11000 in total). Which edition the level bundles follow is a TODO below.
- **Seed scope.** The PoC ships hand-authored **Chinese A1** (bands 1–2) and
  **Chinese A2** (band 3) seed levels, mirroring the German seed; B1–C2 are the
  target.
- TODO: build the **B1–C2 Chinese bundles**, and decide whether level content
  tracks the 2021 standard or the 2025 exam syllabus. Bands 7–9 are one merged
  list, so Chinese C2 is that whole band: unlike German, no C-level source is
  missing, and the only open question is which edition to follow.

## 4. Personal knowledge points

- The learner can also bring **their own knowledge points**: as a custom level,
  which is a personal class seeded from a built-in level or created empty, or as
  an uploaded document fitted into the same schema (§5).
- Personal points take part in progress and steering like any other point; if
  they are not selectable, they are invisible to the loop
  ([50-orchestration.md §2](50-orchestration.md)).
- TODO: the collision policy against built-in points when a personal point has
  the same canonical key; the ID interop story for a class exported from another
  deployment.

## 5. Document upload and model fitting

A learner can bring material as an uploaded document. The pipeline turns it into
knowledge points in a personal class ([30-domain-model.md §3](30-domain-model.md)),
using the model port ([20-architecture.md §5](20-architecture.md)).

1. **Receive.** A channel adapter receives the file (pdf, docx, pptx, txt) and
   hands it to the host. Channel size limits apply; a file that cannot be
   received is reported to the learner in conversation.
2. **Extract.** Text extraction runs in an **adapter behind the
   `core/ports/documents.ts` port**. PDF, docx, and pptx parsers are adapter
   dependencies and must not enter `core/`
   ([70-stack.md §1](70-stack.md), [20-architecture.md §2](20-architecture.md)).
   The PoC wires text and markdown only; the other formats are refused in
   conversation until those dependencies are chosen. A scanned PDF with no text
   layer is **out of scope**: OCR is not part of this pipeline.
3. **Chunk.** The engine splits extracted text into bounded chunks that fit the
   model's context floor.
4. **Fit.** Each chunk goes through the model port with a fitting prompt and
   schema that live in `core/`. The model proposes content; it never assigns ids
   (§1).
5. **Validate and dedupe.** The proposed points are validated with zod in `core/`
   and deduped by canonical key, exactly like an imported class.
6. **Preview and confirm.** The learner is shown what was found and confirms in
   conversation before anything is written. A failed or partial fit is surfaced
   in conversation, never a crash.
7. **Import.** Confirmed points are fitted into the personal class and reconciled
   like any re-import ([30-domain-model.md §4](30-domain-model.md)).

Rules:

- **The model never attributes progress.** Fitting creates points; matching an
  upload onto an existing id for progress is not allowed (§1).
- **Cost and abuse are bounded.** A per-document page or token cap and a
  per-learner rate limit apply, and usage is logged. A document over the cap is
  refused in conversation rather than silently truncated.
- **Uploaded text is learner data and is sent to the model provider.** The
  document's text leaves the server for the configured provider; `README.md`
  states this next to the conversation disclaimer. What is retained, and for how
  long, is part of the retention policy TODO in
  [30-domain-model.md §7](30-domain-model.md).
- **Units may come from the document.** A heading, slide, or chapter structure
  may supply `unit`/`unit_order`; when it does not, the personal class has a
  single unit.
- **The pending preview is in memory for now.** If the process restarts between
  the preview and the confirmation, the preview is dropped and nothing was
  written. Persisting it behind the storage port, and making the per-learner rate
  limit durable, are TODOs.
