/**
 * Learner settings — design/30-domain-model.md §8.
 *
 * What the learner is studying and how far along: target language, CEFR level,
 * the class that level resolved to, the chapter cursor, and which earlier levels
 * are in scope for review. The current *chapter* is derived from counters
 * (`currentUnitOf`) and is never stored (design/30-domain-model.md §1).
 */
import { activeKnowledgePoints, type ClassRecord } from "./knowledge.js";
import type { UserProgress } from "./progress.js";

/** The onboarding questions, in order; "done" means a level resolved to a class. */
export const ONBOARDING_STEPS = ["language", "level", "chapter", "done"] as const;
export type OnboardingStep = (typeof ONBOARDING_STEPS)[number];

export interface LearnerSettings {
 readonly learnerId: string;
 /** Target language, e.g. "German". null before the learner has chosen. */
 readonly targetLanguage: string | null;
 /** CEFR level tag, e.g. "A2". null before the learner has chosen. */
 readonly level: string | null;
 /** The class this level resolved to. null until onboarding completes. */
 readonly classId: string | null;
 /**
  * Units below this order are treated as already known (design/30-domain-model.md §8).
  * 0 means "start at the beginning".
  */
 readonly knownThroughUnit: number;
 /** Level tags kept in scope for review, ordered lowest first. */
 readonly includedLevels: readonly string[];
 readonly onboardingStep: OnboardingStep;
 readonly updatedAt: string;
}

export function blankSettings(learnerId: string): LearnerSettings {
 return {
 learnerId,
 targetLanguage: null,
 level: null,
 classId: null,
 knownThroughUnit: 0,
 includedLevels: [],
 onboardingStep: "language",
 updatedAt: "",
 };
}

/** Onboarding is complete when a level resolved to a class (design/60-ingestion.md §3). */
export function isOnboarded(settings: LearnerSettings | null): boolean {
 return (
 settings !== null &&
 settings.onboardingStep === "done" &&
 settings.classId !== null &&
 settings.level !== null &&
 settings.targetLanguage !== null
 );
}

export interface CurrentUnit {
 readonly unit: string;
 readonly unitOrder: number;
}

/**
 * The chapter the learner is working through: the lowest unit at or above the
 * cursor that still has unseen points. Derived, never stored
 * (design/30-domain-model.md §1, §8).
 */
export function currentUnitOf(
 klass: ClassRecord,
 progress: readonly UserProgress[],
 knownThroughUnit: number,
): CurrentUnit | null {
 const seen = new Set(
 progress.filter((row) => row.timesSeen > 0).map((row) => row.knowledgePointId),
 );
 const candidates = activeKnowledgePoints(klass)
 .filter(
 (point) =>
 point.unit.length > 0 &&
 point.unitOrder >= knownThroughUnit &&
 !seen.has(point.id),
 )
 .sort((left, right) => {
 if (left.unitOrder !== right.unitOrder) {
 return left.unitOrder - right.unitOrder;
 }
 return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
 });
 const top = candidates[0];
 return top === undefined ? null : { unit: top.unit, unitOrder: top.unitOrder };
}

/** Highest unit order declared by a class; 0 when the material has no units. */
export function highestUnitOrder(klass: ClassRecord): number {
 return activeKnowledgePoints(klass).reduce(
 (highest, point) => (point.unitOrder > highest ? point.unitOrder : highest),
 0,
 );
}
