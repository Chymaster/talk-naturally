/**
 * Model resolution adapters — MVP.md design/20-architecture.md §2.
 *
 * Precedence, highest first:
 * 1. learner override (a token the learner supplied at runtime)
 * 2. deployer configuration (the operator's endpoint and model)
 * 3. built-in default (DeepSeek official API + deepseek-flash)
 *
 * The PoC keeps learner overrides in memory only, so it carries no
 * secret-at-rest obligation (MVP.md MVP.md §3.3). Persisting them is a v1 decision
 * that belongs to the identity layer (design/30-domain-model.md §6/30-domain-model §7).
 */
import type { ModelSettings } from "../core/ports/config.js";
import type { ModelPort, ModelResolverPort } from "../core/ports/model.js";
import { OpenAICompatibleModel } from "./openai-model.js";

export interface ModelResolverOptions {
 readonly fetchImpl?: typeof fetch;
 readonly timeoutMs?: number;
 readonly logger?: (event: Record<string, unknown>) => void;
}

/** One model for everyone; used by the CLI host and by tests. */
export class StaticModelResolver implements ModelResolverPort {
 readonly #model: ModelPort;

 constructor(model: ModelPort) {
 this.#model = model;
 }

 async forLearner(): Promise<ModelPort> {
 return this.#model;
 }
}

/** Deployer default plus in-memory learner overrides. Never logs a key. */
export class LayeredModelResolver implements ModelResolverPort {
 readonly #defaultSettings: ModelSettings;
 readonly #overrides = new Map<string, ModelSettings>();
 readonly #options: ModelResolverOptions;

 constructor(defaultSettings: ModelSettings, options: ModelResolverOptions = {}) {
 this.#defaultSettings = defaultSettings;
 this.#options = options;
 }

 setLearnerOverride(learnerId: string, settings: ModelSettings): void {
 this.#overrides.set(learnerId, settings);
 }

 clearLearnerOverride(learnerId: string): void {
 this.#overrides.delete(learnerId);
 }

 hasLearnerOverride(learnerId: string): boolean {
 return this.#overrides.has(learnerId);
 }

 /** The effective settings for a learner, without exposing the key. */
 describeFor(learnerId: string): { modelId: string; baseUrl: string; source: string } {
 const settings = this.#overrides.get(learnerId) ?? this.#defaultSettings;
 return { modelId: settings.modelId, baseUrl: settings.baseUrl, source: settings.source };
 }

 async forLearner(learnerId: string): Promise<ModelPort> {
 const settings = this.#overrides.get(learnerId) ?? this.#defaultSettings;
 return new OpenAICompatibleModel({
 settings,
 ...(this.#options.fetchImpl === undefined ? {} : { fetchImpl: this.#options.fetchImpl }),
 ...(this.#options.timeoutMs === undefined ? {} : { timeoutMs: this.#options.timeoutMs }),
 ...(this.#options.logger === undefined ? {} : { logger: this.#options.logger }),
 });
 }
}
