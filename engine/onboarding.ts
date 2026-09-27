/**
 * Onboarding orchestration — design/60-ingestion.md §3.
 *
 * The questions and their parsing are core logic (`core/onboarding/`). This file
 * reads and writes the learner's settings and loads built-in material through
 * the catalog port. It makes no model call, so onboarding works even when no
 * provider key is configured.
 */
import { allKnowledgePoints, type ClassRecord } from "../core/domain/knowledge.js";
import { blankSettings, type LearnerSettings } from "../core/domain/settings.js";
import {
 chapterQuestion,
 isChapterStart,
 languageQuestion,
 levelQuestion,
 matchLanguage,
 matchLevel,
 matchUnit,
 welcomeMessage,
 type UnitChoice,
} from "../core/onboarding/onboarding.js";
import type { LevelCatalogPort } from "../core/ports/catalog.js";
import type { ClockPort } from "../core/ports/config.js";
import type { StoragePort } from "../core/ports/storage.js";
import { importRawClass } from "./class-import.js";
import type { EngineLogger } from "./types.js";

export interface OnboardingDeps {
 readonly storage: StoragePort;
 readonly clock: ClockPort;
 readonly catalog: LevelCatalogPort;
 readonly logger?: EngineLogger;
}

export interface OnboardingTurnOutcome {
 readonly reply: string;
 readonly handledAs: string;
}

/** Distinct units of a class, in chapter order (design/30-domain-model.md §1). */
export function unitsOf(klass: ClassRecord): UnitChoice[] {
 const byOrder = new Map<number, string>();
 for (const point of allKnowledgePoints(klass)) {
 if (point.unit.length === 0 || point.unitOrder <= 0) {
 continue;
 }
 if (!byOrder.has(point.unitOrder)) {
 byOrder.set(point.unitOrder, point.unit);
 }
 }
 return [...byOrder.entries()]
 .map(([unitOrder, unit]) => ({ unit, unitOrder }))
 .sort((left, right) => left.unitOrder - right.unitOrder);
}

/**
 * Import the built-in class for every level before `level` and return the tags
 * that are actually available. Reviewing an earlier level needs that level's
 * points in scope (design/40-steering.md §3).
 */
export async function provisionIncludedLevels(
 deps: OnboardingDeps,
 learnerId: string,
 language: string,
 level: string,
 nowIso: string,
): Promise<readonly string[]> {
 const levels = await deps.catalog.listLevels(language);
 const index = levels.findIndex((candidate) => candidate.level === level);
 if (index <= 0) {
 return [];
 }
 const included: string[] = [];
 for (const previous of levels.slice(0, index)) {
 const raw = await deps.catalog.loadBuiltIn(language, previous.level);
 if (raw === null) {
 continue;
 }
 await importRawClass(deps.storage, learnerId, raw, nowIso);
 included.push(previous.level);
 }
 return included;
}

/**
 * The question the learner still has to answer, without changing any state.
 * A scheduled session uses this so it can ask rather than open
 * (design/50-orchestration.md §2).
 */
export async function nextOnboardingQuestion(
 deps: OnboardingDeps,
 learnerId: string,
): Promise<string> {
 const settings =
 (await deps.storage.getLearnerSettings(learnerId)) ?? blankSettings(learnerId);
 if (settings.onboardingStep === "language") {
 return languageQuestion(await deps.catalog.listLanguages());
 }
 if (settings.onboardingStep === "level") {
 const language = settings.targetLanguage ?? "";
 return levelQuestion(language, await deps.catalog.listLevels(language));
 }
 const klass =
 settings.classId === null ? null : await deps.storage.getClass(learnerId, settings.classId);
 const units = klass === null ? [] : unitsOf(klass);
 return chapterQuestion(klass?.title ?? "your level", units);
}

export async function handleOnboardingTurn(
 deps: OnboardingDeps,
 learnerId: string,
 text: string,
): Promise<OnboardingTurnOutcome> {
 const { storage, clock, catalog, logger } = deps;
 const nowIso = clock.now().toISOString();
 let settings: LearnerSettings =
 (await storage.getLearnerSettings(learnerId)) ?? blankSettings(learnerId);
 const save = async (next: LearnerSettings): Promise<void> => {
 settings = { ...next, updatedAt: nowIso };
 await storage.setLearnerSettings(learnerId, settings);
 };
 const answered = text.trim().length > 0;

 if (settings.onboardingStep === "language") {
 const languages = await catalog.listLanguages();
 const choice = matchLanguage(text, languages);
 if (choice === null) {
 return { reply: languageQuestion(languages, answered), handledAs: "onboarding_language" };
 }
 const levels = await catalog.listLevels(choice);
 if (levels.length === 0) {
 return {
 reply: `I do not have any ${choice} material on this server yet. Ask the operator to add it.`,
 handledAs: "onboarding_no_material",
 };
 }
 await save({ ...settings, targetLanguage: choice, onboardingStep: "level" });
 logger?.({ event: "onboarding.language_chosen", learnerId, language: choice });
 return { reply: levelQuestion(choice, levels), handledAs: "onboarding_level" };
 }

 if (settings.onboardingStep === "level") {
 const language = settings.targetLanguage ?? "";
 const levels = await catalog.listLevels(language);
 const chosen = matchLevel(text, levels);
 if (chosen === null) {
 return { reply: levelQuestion(language, levels, answered), handledAs: "onboarding_level" };
 }
 const raw = await catalog.loadBuiltIn(language, chosen.level);
 if (raw === null) {
 return {
 reply: `I do not have ${chosen.title} yet. Ask the operator to add it.`,
 handledAs: "onboarding_no_material",
 };
 }
 const imported = await importRawClass(storage, learnerId, raw, nowIso);
 const units = unitsOf(imported.klass);
 await save({
 ...settings,
 level: chosen.level,
 classId: imported.klass.id,
 knownThroughUnit: 0,
 onboardingStep: "chapter",
 });
 logger?.({
 event: "onboarding.level_chosen",
 learnerId,
 level: chosen.level,
 classId: imported.klass.id,
 points: imported.pointCount,
 units: units.length,
 });
 return { reply: chapterQuestion(chosen.title, units), handledAs: "onboarding_chapter" };
 }

 // The chapter step: "start" (or an empty answer) begins at the first chapter.
 const klass =
 settings.classId === null ? null : await storage.getClass(learnerId, settings.classId);
 const units = klass === null ? [] : unitsOf(klass);

 let cursor = 0;
 // A named chapter wins over a bare "start", so "start at chapter 4" is not
 // silently read as chapter 1 (design/60-ingestion.md §3).
 const named = units.length > 0 ? matchUnit(text, units) : null;
 if (named !== null) {
 cursor = named.unitOrder;
 } else if (units.length > 0 && !isChapterStart(text)) {
 return {
 reply: chapterQuestion(klass?.title ?? "your level", units, true),
 handledAs: "onboarding_chapter",
 };
 }

 const language = settings.targetLanguage ?? "";
 const level = settings.level ?? "";
 const included = await provisionIncludedLevels(deps, learnerId, language, level, nowIso);
 await save({
 ...settings,
 knownThroughUnit: cursor,
 includedLevels: included,
 onboardingStep: "done",
 });
 logger?.({
 event: "onboarding.completed",
 learnerId,
 language,
 level,
 knownThroughUnit: cursor,
 includedLevels: included,
 });
 const chapter = units.find((unit) => unit.unitOrder === cursor) ?? null;
 return { reply: welcomeMessage(language, level, chapter), handledAs: "onboarding_done" };
}
