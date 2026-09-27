/**
 * Cross-level scope assembly — design/40-steering.md §3.
 *
 * Shared by the turn graph and the scheduled session so both rank the same pool:
 * the learner's level plus whichever earlier levels they keep in scope for
 * review, deduped by knowledge-point id.
 */
import type { ClassRecord } from "../core/domain/knowledge.js";
import type { UserProgress } from "../core/domain/progress.js";
import type { LearnerSettings } from "../core/domain/settings.js";
import type { StoragePort } from "../core/ports/storage.js";
import { resolveScope, type Scope, type ScopeLevel } from "../core/steering/scope.js";
import type { EngineLogger } from "./types.js";

export interface AssembledScope {
 readonly scope: Scope;
 /** Progress rows for every point in scope, deduped by knowledge-point id. */
 readonly progress: readonly UserProgress[];
}

export async function assembleScope(
 storage: StoragePort,
 learnerId: string,
 primary: ClassRecord,
 settings: LearnerSettings | null,
 logger?: EngineLogger,
): Promise<AssembledScope> {
 const levels: ScopeLevel[] = [
 {
 klass: primary,
 primary: true,
 knownThroughUnit: settings?.knownThroughUnit ?? 0,
 },
 ];
 const progressById = new Map<string, UserProgress>();
 for (const row of await storage.getProgress(learnerId, primary.id)) {
 progressById.set(row.knowledgePointId, row);
 }

 const classes = await storage.listClasses(learnerId);
 for (const levelTag of settings?.includedLevels ?? []) {
 const included = classes.find((klass) => klass.level === levelTag) ?? null;
 if (included === null) {
 logger?.({ event: "scope.included_level_missing", learnerId, level: levelTag });
 continue;
 }
 levels.push({ klass: included, primary: false, knownThroughUnit: 0 });
 for (const row of await storage.getProgress(learnerId, included.id)) {
 if (!progressById.has(row.knowledgePointId)) {
 progressById.set(row.knowledgePointId, row);
 }
 }
 }

 return { scope: resolveScope(levels), progress: [...progressById.values()] };
}
