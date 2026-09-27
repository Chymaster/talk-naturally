/**
 * Clock, ID, and config ports — design/20-architecture.md §2.
 *
 * Time, identity minting, and configuration arrive from the host so tests are
 * deterministic and the core stays free of platform and provider APIs.
 *
 * Note what is *not* here: no provider name, no endpoint, no default model id.
 * Those are composition-root decisions (MVP.md MVP.md §3.1); the core only receives the
 * resolved `ModelSettings`. The boundary test enforces this (design/20-architecture.md §3).
 */

/** Injected so tests are deterministic and hosts supply the real time (design/20-architecture.md §2). */
export interface ClockPort {
 now(): Date;
}

/** Opaque id minting for turns and messages. Learner ids come from storage. */
export interface IdPort {
 newId(): string;
}

/** Where a model setting came from (MVP.md MVP.md §3.1). */
export type ModelConfigSource = "learner" | "deployer" | "default";

export interface ModelSettings {
 readonly baseUrl: string;
 readonly modelId: string;
 /** null means no key configured; the adapter reports it as unavailable. */
 readonly apiKey: string | null;
 readonly source: ModelConfigSource;
 readonly capabilities: import("./model.js").ModelCapabilities;
}

export interface ScheduleSettings {
 /** null disables the proactive scheduler. */
 readonly hourLocal: number | null;
}

export interface AppConfig {
 readonly dbPath: string;
 readonly model: ModelSettings;
 readonly schedule: ScheduleSettings;
}
