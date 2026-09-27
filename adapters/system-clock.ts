/**
 * Real clock. Injected by the host; the core never reads the time itself
 * (design/20-architecture.md §2).
 */
import type { ClockPort } from "../core/ports/config.js";

export class SystemClock implements ClockPort {
 now(): Date {
 return new Date();
 }
}

/** Fixed clock for tests and reproducible demo transcripts. */
export class FixedClock implements ClockPort {
 #current: Date;

 constructor(startIso: string) {
 this.#current = new Date(startIso);
 }

 now(): Date {
 return new Date(this.#current);
 }

 advanceMs(milliseconds: number): void {
 this.#current = new Date(this.#current.getTime() + milliseconds);
 }
}
