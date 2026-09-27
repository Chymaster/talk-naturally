/**
 * Learner model configuration, as exposed to chat channels — design/72-channels.md §1.
 *
 * This contract is channel-neutral: every frontend that ships a `/model` command
 * uses the same shape, so the composition root wires one implementation and the
 * adapters stay free of provider concerns (design/20-architecture.md §5).
 * The key is supplied at runtime and never persisted (MVP.md §3.3).
 */
export interface ModelAdmin {
  describe(learnerId: string): { modelId: string; baseUrl: string; source: string };
  setLearnerOverride(learnerId: string, apiKey: string, modelId?: string): void;
  clearLearnerOverride(learnerId: string): void;
}
