# Built-in catalog — seed content

This directory holds the **built-in level catalog**: `manifest.json` plus one
JSON file per level under `german/` and `chinese/`. It is read by
[`hosts/catalog-file.ts`](../../hosts/catalog-file.ts) (`FileLevelCatalog`),
which implements the core's `LevelCatalogPort`
([`core/ports/catalog.ts`](../../core/ports/catalog.ts)).

## What this content is

- It is **hand-authored seed content, written for this repository**. The titles
  and the one-sentence explanations are original text, and every point carries a
  `raw_source` of the form `"seed: A1 unit 2"` so its provenance is honest: it
  is seed content, not a copy of an official list.
- It is **not an official word list, character list, or exam list** for either
  language. It does not claim to cover any exam, and it must not be presented to
  a learner as official material.
- **German A1/A2** is derived from the Goethe-Institut Wortlisten (A1, A2), the
  DTZ list, and telc's lesson-organized B2-Beruf *Wortschatzlisten*. See
  [`design/60-ingestion.md` §3.1](../../design/60-ingestion.md).
- **Chinese A1/A2** is derived from the *Chinese Proficiency Grading Standards
  for International Chinese Language Education* (《国际中文教育中文水平等级标准》,
  GF 0025-2021), bands 1–3. The CEFR labels are our own estimate — the standard
  publishes no official CEFR conversion — so a level tag here is a curriculum
  choice, not an exam equivalence. See
  [`design/60-ingestion.md` §3.2](../../design/60-ingestion.md).
- The real content pipeline — where built-in material comes from, how it is
  licensed and attributed, and how it is fitted into the one class schema — is
  specified in [`design/60-ingestion.md`](../../design/60-ingestion.md) §3. That
  section still has open questions (the licensing decisions `D-019` for German
  and `D-035` for Chinese in
  [`design/80-decisions.md`](../../design/80-decisions.md) are not clean
  licences), so this seed catalog is a placeholder for the PoC, not the finished
  library.
- **Not every level ships.** German has no official C1/C2 source, and the
  Chinese B1–C2 bundles are not built yet. Adding them requires the source and
  licensing decisions in `design/60-ingestion.md` §3 first (`AGENT.md` §2).

## Manifest shape

```jsonc
{
  "version": 1,
  "languages": [
    {
      "language": "German",
      "sourceLanguage": "English",
      "levels": [
        {
          "level": "A1",
          "title": "German A1",
          "file": "german/A1.json", // relative to this directory
          "units": ["<label>", "..."]
        }
      ]
    }
  ]
}
```

Levels are listed **lowest first**. That order is load-bearing: it defines which
levels count as "previous" for the review pool
([`design/40-steering.md`](../../design/40-steering.md) §3), so do not reorder
them. Each level file is a `RawClassInput`
([`core/classes/schema.ts`](../../core/classes/schema.ts)) with
`origin: "builtin"`, `source_language: "English"`, a `target_language` that
matches the manifest (`"German"` or `"Chinese"`), and a `unit` / `unit_order` on
every point that matches the manifest's `units`.

A missing or malformed manifest or level file is a deployment error: the
adapter throws with the offending path rather than returning `null`. Only an
unknown language or level returns `null` / an empty list.
