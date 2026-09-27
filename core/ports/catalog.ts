/**
 * Built-in level catalog — design/60-ingestion.md §3.
 *
 * The core asks which languages and levels exist and loads the raw material for
 * one of them. Reading files, directories, or a remote store is an adapter
 * concern, behind this port (design/20-architecture.md §2).
 */
import type { RawClassInput } from "../classes/schema.js";

export interface LevelDescriptor {
 /** Target language, e.g. "German". */
 readonly language: string;
 /** CEFR level tag, e.g. "A1". */
 readonly level: string;
 /** Class title used for the built-in class, e.g. "German A1". */
 readonly title: string;
 /** Ordered unit labels; empty when the level has no chapters (design/30-domain-model.md §1). */
 readonly units: readonly string[];
}

export interface LevelCatalogPort {
 listLanguages(): Promise<readonly string[]>;
 /**
  * Levels for one language, lowest first. The order defines which levels count
  * as "previous" for the review pool (design/40-steering.md §3).
  */
 listLevels(language: string): Promise<readonly LevelDescriptor[]>;
 /** Raw material for one level, or null when the catalog does not ship it. */
 loadBuiltIn(language: string, level: string): Promise<RawClassInput | null>;
}
