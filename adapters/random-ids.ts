/**
 * Opaque id minting for turns and messages (design/20-architecture.md §2).
 *
 * Learner ids are minted by storage, not here, because the anchor belongs to the
 * identity layer (design/30-domain-model.md §6).
 */
import type { IdPort } from "../core/ports/config.js";

export class RandomIdPort implements IdPort {
 newId(): string {
 return globalThis.crypto.randomUUID();
 }
}

/** Deterministic ids for tests: t1, t2, t3, … */
export class SequentialIdPort implements IdPort {
 #counter = 0;
 readonly #prefix: string;

 constructor(prefix = "t") {
 this.#prefix = prefix;
 }

 newId(): string {
 this.#counter += 1;
 return `${this.#prefix}${this.#counter}`;
 }
}
