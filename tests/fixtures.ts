/**
 * Shared test fixtures. No network, no host, no database (design/70-stack.md §5).
 */
import { fitClass } from "../core/classes/ingest.js";
import type { ClassOrigin, ClassRecord } from "../core/domain/knowledge.js";
import type { UserProgress } from "../core/domain/progress.js";
import type { LearnerSettings } from "../core/domain/settings.js";
import type { LevelCatalogPort, LevelDescriptor } from "../core/ports/catalog.js";
import type { RawClassInput } from "../core/classes/schema.js";

export const NOW = "2026-09-25T09:00:00.000Z";

export const rawFixture: RawClassInput = {
 title: "Test Chapter",
 source_language: "English",
 target_language: "German",
 origin: "imported",
 points: [
 { kind: "grammar", title: "Dativ: mit + dem/der", detail: "mit + dative", raw_source: "t1" },
 { kind: "vocab", title: "der Bus", detail: "bus", raw_source: "t2" },
 { kind: "vocab", title: "die Bahn", detail: "train", raw_source: "t3" },
 { kind: "sentence_structure", title: "Womit fährst du?", detail: "question", raw_source: "t4" },
 ],
};

export function makeClass(ownerLearnerId: string | null = "lrn_a"): ClassRecord {
 return fitClass(rawFixture, { ownerLearnerId, nowIso: NOW });
}

export function allIds(klass: ClassRecord): string[] {
 return [...klass.grammar, ...klass.sentenceStructure, ...klass.vocab].map((point) => point.id);
}

export function progressRow(
 knowledgePointId: string,
 overrides: Partial<UserProgress> = {},
): UserProgress {
 return {
 learnerId: "lrn_a",
 knowledgePointId,
 timesSeen: 0,
 timesUsed: 0,
 timesUsedWithHelp: 0,
 timesWrong: 0,
 lastSeenAt: null,
 lastWrongAt: null,
 notes: "",
 ...overrides,
 };
}

/** A level with several units; `unitOrder` follows the declared order from 1. */
export interface LevelClassSpec {
 readonly level: string;
 readonly units: readonly string[];
 readonly language?: string;
 readonly title?: string;
 readonly origin?: ClassOrigin;
 readonly ownerLearnerId?: string | null;
}

/**
 * Raw material for one level: one vocab point per unit. The title is the unit
 * label alone, so the same unit label in two levels resolves to the same
 * knowledge-point id — the cross-level review case
 * (design/30-domain-model.md §5, design/40-steering.md §2).
 */
export function rawLevel(spec: LevelClassSpec): RawClassInput {
 const language = spec.language ?? "German";
 return {
 title: spec.title ?? `${language} ${spec.level}`,
 source_language: "English",
 target_language: language,
 level: spec.level,
 origin: spec.origin ?? "builtin",
 points: spec.units.map((unit, index) => ({
 kind: "vocab",
 title: unit,
 detail: `${language} ${spec.level} ${unit}`,
 unit,
 unit_order: index + 1,
 raw_source: `fixture:${spec.level}:${unit}`,
 })),
 };
}

/** A fitted class with several units and `unitOrder` ascending from 1. */
export function makeLevelClass(spec: LevelClassSpec): ClassRecord {
 return fitClass(rawLevel(spec), {
 ownerLearnerId: spec.ownerLearnerId ?? null,
 nowIso: NOW,
 });
}

export interface StubCatalogLevel {
 readonly level: string;
 readonly units: readonly string[];
}

/**
 * A tiny in-memory `LevelCatalogPort` for onboarding tests: one language, the
 * listed levels lowest first, raw material built by `rawLevel`
 * (design/60-ingestion.md §3). No filesystem and no network.
 */
export function stubCatalog(
 language: string,
 levels: readonly StubCatalogLevel[],
): LevelCatalogPort {
 const descriptors: readonly LevelDescriptor[] = levels.map((entry) => ({
 language,
 level: entry.level,
 title: `${language} ${entry.level}`,
 units: [...entry.units],
 }));
 return {
 async listLanguages(): Promise<readonly string[]> {
 return [language];
 },
 async listLevels(requested: string): Promise<readonly LevelDescriptor[]> {
 return requested === language ? descriptors : [];
 },
 async loadBuiltIn(requested: string, level: string): Promise<RawClassInput | null> {
 if (requested !== language) {
 return null;
 }
 const entry = levels.find((candidate) => candidate.level === level);
 if (entry === undefined) {
 return null;
 }
 return rawLevel({ level: entry.level, units: entry.units, language });
 },
 };
}

export interface OnboardedSettingsSpec {
 readonly level: string;
 readonly classId: string;
 readonly knownThroughUnit?: number;
 readonly includedLevels?: readonly string[];
 readonly targetLanguage?: string;
 readonly updatedAt?: string;
}

/** Completed onboarding settings for a learner (design/30-domain-model.md §8). */
export function onboardedSettings(
 learnerId: string,
 spec: OnboardedSettingsSpec,
): LearnerSettings {
 return {
 learnerId,
 targetLanguage: spec.targetLanguage ?? "German",
 level: spec.level,
 classId: spec.classId,
 knownThroughUnit: spec.knownThroughUnit ?? 0,
 includedLevels: spec.includedLevels ?? [],
 onboardingStep: "done",
 updatedAt: spec.updatedAt ?? NOW,
 };
}
