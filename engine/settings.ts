/**
 * Settings commands — design/30-domain-model.md §8.
 *
 * Changing language, level, chapter or the review pool is a deterministic core
 * decision, so it makes no model call and works on any channel. The commands are
 * the "entry point to change settings" the product requires, kept in chat
 * (design/20-architecture.md §4.2).
 */
import { currentUnitOf, type LearnerSettings } from "../core/domain/settings.js";
import {
 chapterQuestion,
 levelQuestion,
 matchLanguage,
 matchLevel,
 matchUnit,
 isChapterStart,
} from "../core/onboarding/onboarding.js";
import type { LevelDescriptor } from "../core/ports/catalog.js";
import { importRawClass } from "./class-import.js";
import { provisionIncludedLevels, unitsOf, type OnboardingDeps } from "./onboarding.js";

export interface SettingsCommandOutcome {
 readonly reply: string;
 readonly handledAs: string;
}

function notSetUp(): string {
 return "Let's get you set up first — tell me which language you are learning.";
}

/** Current settings, rendered for chat (design/30-domain-model.md §8). */
export async function describeSettings(
 deps: OnboardingDeps,
 learnerId: string,
): Promise<string> {
 const settings = await deps.storage.getLearnerSettings(learnerId);
 if (settings === null || settings.onboardingStep !== "done") {
 return notSetUp();
 }
 const klass =
 settings.classId === null ? null : await deps.storage.getClass(learnerId, settings.classId);
 const chapter =
 klass === null
 ? null
 : currentUnitOf(
 klass,
 await deps.storage.getProgress(learnerId, klass.id),
 settings.knownThroughUnit,
 );
 const included =
 settings.includedLevels.length > 0 ? settings.includedLevels.join(", ") : "none";
 return [
 `Language: ${settings.targetLanguage ?? "not set"}`,
 `Level: ${settings.level ?? "not set"}${chapter === null ? "" : ` — ${chapter.unit}`}`,
 `Reviewing earlier levels: ${included}`,
 `Change any of this with /level <A1–C2>, /language <name>, /chapter <n|start>, /include <level>, /exclude <level>.`,
 ].join("\n");
}

export async function handleSettingsCommand(
 deps: OnboardingDeps,
 learnerId: string,
 text: string,
): Promise<SettingsCommandOutcome> {
 const trimmed = text.trim();
 const [head = "", ...rest] = trimmed.split(/\s+/u);
 const command = head.toLowerCase();
 const argument = rest.join(" ").trim();
 const nowIso = deps.clock.now().toISOString();

 if (command === "/settings" || command === "/help") {
 return { reply: await describeSettings(deps, learnerId), handledAs: "settings_shown" };
 }

 const settings: LearnerSettings =
 (await deps.storage.getLearnerSettings(learnerId)) ??
 ({
 learnerId,
 targetLanguage: null,
 level: null,
 classId: null,
 knownThroughUnit: 0,
 includedLevels: [],
 onboardingStep: "language",
 updatedAt: nowIso,
 } satisfies LearnerSettings);
 const language = settings.targetLanguage;

 if (command === "/language") {
 const languages = await deps.catalog.listLanguages();
 const choice = argument.length === 0 ? null : matchLanguage(argument, languages);
 if (choice === null) {
 return {
 reply: `Which language? (${languages.join(", ")})`,
 handledAs: "settings_language",
 };
 }
 const levels = await deps.catalog.listLevels(choice);
 await deps.storage.setLearnerSettings(learnerId, {
 ...settings,
 targetLanguage: choice,
 level: null,
 classId: null,
 knownThroughUnit: 0,
 includedLevels: [],
 onboardingStep: "level",
 updatedAt: nowIso,
 });
 return { reply: levelQuestion(choice, levels), handledAs: "onboarding_level" };
 }

 const withLevel = async (chosen: LevelDescriptor): Promise<SettingsCommandOutcome> => {
 const lang = language ?? "";
 const raw = await deps.catalog.loadBuiltIn(lang, chosen.level);
 if (raw === null) {
 return { reply: `I do not have ${chosen.title} yet.`, handledAs: "settings_level" };
 }
 const imported = await importRawClass(deps.storage, learnerId, raw, nowIso);
 const included = await provisionIncludedLevels(deps, learnerId, lang, chosen.level, nowIso);
 const units = unitsOf(imported.klass);
 await deps.storage.setLearnerSettings(learnerId, {
 ...settings,
 level: chosen.level,
 classId: imported.klass.id,
 knownThroughUnit: 0,
 includedLevels: included,
 onboardingStep: "done",
 updatedAt: nowIso,
 });
 deps.logger?.({
 event: "settings.level_changed",
 learnerId,
 level: chosen.level,
 classId: imported.klass.id,
 includedLevels: included,
 });
 const chapters =
 units.length === 0
 ? ""
 : ` Chapters: ${units.map((unit) => `${unit.unitOrder}. ${unit.unit}`).join("; ")}. Say /chapter <n> to start at one.`;
 return {
 reply: `You're now studying ${chosen.title}.${chapters}`,
 handledAs: "settings_level_changed",
 };
 };

 if (command === "/level") {
 if (language === null) {
 return { reply: notSetUp(), handledAs: "settings_level" };
 }
 const levels = await deps.catalog.listLevels(language);
 const offered = levels.map((level) => level.level).join(", ");
 const chosen = argument.length === 0 ? null : matchLevel(argument, levels);
 if (chosen === null) {
 return {
 reply: `Which level? (${offered})${settings.level === null ? "" : ` — you are on ${settings.level} now`}`,
 handledAs: "settings_level",
 };
 }
 return withLevel(chosen);
 }

 if (command === "/chapter") {
 if (settings.classId === null) {
 return { reply: "Pick a level first with /level.", handledAs: "settings_chapter" };
 }
 const klass = await deps.storage.getClass(learnerId, settings.classId);
 if (klass === null) {
 return { reply: notSetUp(), handledAs: "settings_chapter" };
 }
 const units = unitsOf(klass);
 // A named chapter wins over a bare "start" (design/60-ingestion.md §3).
 const named = units.length > 0 ? matchUnit(argument, units) : null;
 if (named !== null) {
 await deps.storage.setLearnerSettings(learnerId, {
 ...settings,
 knownThroughUnit: named.unitOrder,
 updatedAt: nowIso,
 });
 return { reply: `Starting at ${named.unit}.`, handledAs: "settings_chapter_changed" };
 }
 if (units.length > 0 && !isChapterStart(argument)) {
 return { reply: chapterQuestion(klass.title, units, true), handledAs: "settings_chapter" };
 }
 await deps.storage.setLearnerSettings(learnerId, {
 ...settings,
 knownThroughUnit: 0,
 updatedAt: nowIso,
 });
 return {
 reply: `Starting from the beginning of ${klass.title}.`,
 handledAs: "settings_chapter_changed",
 };
 }

 if (command === "/include" || command === "/exclude") {
 if (language === null || settings.level === null) {
 return { reply: "Pick a level first with /level.", handledAs: "settings_include" };
 }
 const levels = await deps.catalog.listLevels(language);
 const earlier = levels.filter((level) => level.level !== settings.level);
 const offered = earlier.map((level) => level.level).join(", ");
 const chosen = argument.length === 0 ? null : matchLevel(argument, earlier);
 if (chosen === null) {
 return {
 reply: `Which earlier level? (${offered.length > 0 ? offered : "none available"})`,
 handledAs: "settings_include",
 };
 }
 if (command === "/include") {
 const raw = await deps.catalog.loadBuiltIn(language, chosen.level);
 if (raw !== null) {
 await importRawClass(deps.storage, learnerId, raw, nowIso);
 }
 const included = [...new Set([...settings.includedLevels, chosen.level])];
 await deps.storage.setLearnerSettings(learnerId, {
 ...settings,
 includedLevels: included,
 updatedAt: nowIso,
 });
 return {
 reply: `${chosen.level} is now in scope for review.`,
 handledAs: "settings_include_changed",
 };
 }
 const included = settings.includedLevels.filter((level) => level !== chosen.level);
 await deps.storage.setLearnerSettings(learnerId, {
 ...settings,
 includedLevels: included,
 updatedAt: nowIso,
 });
 return {
 reply: `${chosen.level} is no longer in scope.`,
 handledAs: "settings_include_changed",
 };
 }

 if (command === "/class") {
 const classes = await deps.storage.listClasses(learnerId);
 if (classes.length === 0) {
 return {
 reply: "You have no classes yet. Upload material, or pick a built-in level with /level.",
 handledAs: "settings_class",
 };
 }
 if (argument.length === 0) {
 const list = classes
 .map(
 (klass) =>
 `- ${klass.title}${klass.level === null ? "" : ` (${klass.level})`} [${klass.origin}]`,
 )
 .join("\n");
 return {
 reply: `Your classes:\n${list}\nSwitch with /class <name>.`,
 handledAs: "settings_class_shown",
 };
 }
 const needle = argument.toLowerCase();
 const chosen = classes.find((klass) => klass.title.toLowerCase().includes(needle)) ?? null;
 if (chosen === null) {
 return {
 reply: `I could not find a class matching "${argument}".`,
 handledAs: "settings_class",
 };
 }
 await deps.storage.setLearnerSettings(learnerId, {
 ...settings,
 targetLanguage: chosen.targetLanguage,
 level: chosen.level ?? chosen.title,
 classId: chosen.id,
 knownThroughUnit: 0,
 onboardingStep: "done",
 updatedAt: nowIso,
 });
 deps.logger?.({ event: "settings.class_changed", learnerId, classId: chosen.id });
 return { reply: `You're now studying ${chosen.title}.`, handledAs: "settings_class_changed" };
 }

 return {
 reply: `I did not recognise that command.\n${await describeSettings(deps, learnerId)}`,
 handledAs: "settings_unknown",
 };
}
