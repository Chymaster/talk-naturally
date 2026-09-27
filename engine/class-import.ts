/**
 * Class import — design/60-ingestion.md §2.
 *
 * Fitting and reconciliation belong to the core; persisting the result belongs
 * to whoever holds the storage port. Both a host and onboarding need it, so it
 * lives in the engine rather than in one composition root.
 */
import { fitClass, reconcileClass } from "../core/classes/ingest.js";
import type { RawClassInput } from "../core/classes/schema.js";
import type { ClassRecord } from "../core/domain/knowledge.js";
import type { StoragePort } from "../core/ports/storage.js";

export interface ImportResult {
 readonly klass: ClassRecord;
 readonly pointCount: number;
 readonly added: number;
 readonly retired: number;
 readonly revived: number;
 readonly unchanged: number;
 readonly reimport: boolean;
}

function countPoints(klass: ClassRecord): number {
 return klass.grammar.length + klass.sentenceStructure.length + klass.vocab.length;
}

export async function importRawClass(
 storage: StoragePort,
 learnerId: string,
 raw: RawClassInput,
 nowIso: string,
): Promise<ImportResult> {
 const incoming = fitClass(raw, { ownerLearnerId: learnerId, nowIso });
 const existing = await storage.getClass(learnerId, incoming.id);

 if (existing === null) {
 await storage.saveClass(learnerId, incoming);
 const pointCount = countPoints(incoming);
 return {
 klass: incoming,
 pointCount,
 added: pointCount,
 retired: 0,
 revived: 0,
 unchanged: 0,
 reimport: false,
 };
 }

 const { klass, summary } = reconcileClass(existing, incoming, nowIso);
 await storage.saveClass(learnerId, klass);
 return { klass, pointCount: countPoints(klass), ...summary, reimport: true };
}
