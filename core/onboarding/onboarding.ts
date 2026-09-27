/**
 * Deterministic onboarding — design/60-ingestion.md §3.
 *
 * Language, level and starting chapter are enumerable choices, so no model call
 * is needed and the same questions work on every channel. Parsing is tolerant,
 * and an answer that cannot be matched re-asks the same question.
 */
import type { LevelDescriptor } from "../ports/catalog.js";

export interface UnitChoice {
 readonly unit: string;
 readonly unitOrder: number;
}

/**
 * Spoken-language aliases so "Deutsch" and "de" mean "German", and "中文",
 * "zhongwen" or "mandarin" mean "Chinese".
 */
const LANGUAGE_ALIASES: Readonly<Record<string, readonly string[]>> = {
 german: ["german", "deutsch", "de"],
 english: ["english", "englisch", "en"],
 spanish: ["spanish", "spanisch", "espanol", "es"],
 french: ["french", "franzosisch", "francais", "fr"],
 italian: ["italian", "italienisch", "it"],
 chinese: [
 "chinese",
 "mandarin",
 "zh",
 "chinesisch",
 "chinois",
 "chino",
 "cinese",
 "zhongwen",
 "hanyu",
 "putonghua",
 "中文",
 "汉语",
 "普通话",
 ],
};

const UNSURE = [
 "not sure",
 "unsure",
 "dont know",
 "do not know",
 "no idea",
 "keine ahnung",
 "idk",
 "不知道",
 "不清楚",
 "不确定",
];
const LOWER_HINTS = [
 "beginner",
 "begin",
 "start",
 "anfanger",
 "new to",
 "just starting",
 "初学",
 "零基础",
 "入门",
];
const MIDDLE_HINTS = ["intermediate", "mittelstufe", "some", "中级", "中等"];
const UPPER_HINTS = ["advanced", "fortgeschritten", "proficient", "fluent", "高级", "流利"];
const START_HINTS = [
 "start",
 "beginning",
 "begin",
 "first",
 "anfang",
 "skip",
 "none",
 "from the top",
 "开始",
 "从头",
 "第一章",
];

/** True for an alias written with Chinese characters, which has no word breaks. */
function hasHanCharacters(text: string): boolean {
 return /\p{Script=Han}/u.test(text);
}

/** Lowercase, NFC, collapse whitespace, drop Latin and CJK punctuation. */
export function normalizeAnswer(text: string): string {
 return text
 .normalize("NFC")
 .toLowerCase()
 .replace(/[.,;:!?"'`()]+/gu, " ")
 .replace(/[。，、；：！？…—～·《》〈〉「」『』【】〔〕（）［］｛｝“”‘’　]+/gu, " ")
 .replace(/\s+/gu, " ")
 .trim();
}

/** Match a typed answer to an offered language, or null to re-ask. */
export function matchLanguage(text: string, languages: readonly string[]): string | null {
 const answer = normalizeAnswer(text);
 if (answer.length === 0) {
 return null;
 }
 // Match whole words only: a two-letter alias like "de" must not match inside
 // an unrelated word (design/60-ingestion.md §3).
 const tokens = answer.split(" ");
 const matches = (candidate: string): boolean => {
 if (answer === candidate || tokens.includes(candidate)) {
 return true;
 }
 // Chinese is written without spaces, so a Han alias such as 中文 appears
 // inside the sentence ("我想学中文") instead of as its own token; the
 // two-letter hazard the whole-word rule guards against cannot arise there.
 return hasHanCharacters(candidate) && answer.includes(candidate);
 };
 for (const language of languages) {
 if (matches(normalizeAnswer(language))) {
 return language;
 }
 }
 for (const language of languages) {
 const aliases = LANGUAGE_ALIASES[normalizeAnswer(language)] ?? [];
 if (aliases.some((alias) => matches(alias))) {
 return language;
 }
 }
 return null;
}

/**
 * Match a typed answer to an offered level. "Not sure" resolves to the lowest
 * level offered, and beginner/intermediate/advanced map to low/middle/high
 * (design/60-ingestion.md §3).
 */
export function matchLevel(
 text: string,
 levels: readonly LevelDescriptor[],
): LevelDescriptor | null {
 if (levels.length === 0) {
 return null;
 }
 const answer = normalizeAnswer(text);
 if (answer.length === 0) {
 return null;
 }
 if (UNSURE.some((phrase) => answer.includes(phrase))) {
 return levels[0] ?? null;
 }
 const compact = answer.replace(/[\s.]+/gu, "");
 for (const level of levels) {
 const tag = normalizeAnswer(level.level).replace(/[\s.]+/gu, "");
 if (tag.length > 0 && (compact === tag || compact.startsWith(tag) || answer === tag)) {
 return level;
 }
 }
 if (LOWER_HINTS.some((hint) => answer.includes(hint))) {
 return levels[0] ?? null;
 }
 if (UPPER_HINTS.some((hint) => answer.includes(hint))) {
 return levels[levels.length - 1] ?? null;
 }
 if (MIDDLE_HINTS.some((hint) => answer.includes(hint))) {
 return levels[Math.floor((levels.length - 1) / 2)] ?? null;
 }
 return null;
}

/** True when the learner asked to start at the beginning rather than name a chapter. */
export function isChapterStart(text: string): boolean {
 const answer = normalizeAnswer(text);
 if (answer.length === 0) {
 return true;
 }
 return START_HINTS.some((word) => answer === word || answer.includes(word));
}

/** Match "chapter 4", "kapitel 4", "4" or a unit label to a declared unit. */
export function matchUnit(text: string, units: readonly UnitChoice[]): UnitChoice | null {
 if (units.length === 0) {
 return null;
 }
 const answer = normalizeAnswer(text);
 if (answer.length === 0) {
 return null;
 }
 const digits = answer.match(/\d+/u);
 if (digits !== null) {
 const order = Number.parseInt(digits[0] ?? "", 10);
 const byOrder = units.find((unit) => unit.unitOrder === order);
 if (byOrder !== undefined) {
 return byOrder;
 }
 }
 for (const unit of units) {
 const label = normalizeAnswer(unit.unit);
 if (label.length === 0) {
 continue;
 }
 if (answer === label || answer.includes(label) || label.includes(answer)) {
 return unit;
 }
 }
 return null;
}

function retryPrefix(retry: boolean): string {
 return retry ? "Sorry, I did not catch that. " : "";
}

export function languageQuestion(languages: readonly string[], retry = false): string {
 return (
 retryPrefix(retry) +
 `Which language are you learning? (${languages.join(", ")})`
 );
}

export function levelQuestion(
 language: string,
 levels: readonly LevelDescriptor[],
 retry = false,
): string {
 const offered = levels.map((level) => level.level).join(", ");
 return (
 retryPrefix(retry) +
 `Which level of ${language} are you studying? (${offered}) ` +
 `If you are not sure, say "not sure" and I will start you at ${levels[0]?.level ?? "the beginning"}.`
 );
}

export function chapterQuestion(
 title: string,
 units: readonly UnitChoice[],
 retry = false,
): string {
 if (units.length === 0) {
 return retryPrefix(retry) + `Ready when you are — write to me and we will start.`;
 }
 const offered = units.map((unit) => `${unit.unitOrder}. ${unit.unit}`).join("; ");
 return (
 retryPrefix(retry) +
 `Where are you in ${title}? Say "start" to begin at the beginning, or name a chapter: ${offered}`
 );
}

export function welcomeMessage(
 language: string,
 level: string,
 chapter: UnitChoice | null,
): string {
 const where = chapter === null ? "" : ` — ${chapter.unit}`;
 return (
 `You're set up for ${language} ${level}${where}. ` +
 `Write to me in ${language} whenever you like and we will practise. ` +
 `You can change language, level or chapter any time with /settings.`
 );
}
