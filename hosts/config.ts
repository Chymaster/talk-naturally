/**
 * Configuration resolution — MVP.md §3.
 *
 * One place decides the effective settings, and it is the composition root, not
 * the core (AGENT.md §3 "the core does not read environment variables").
 *
 * Precedence, highest first: learner override → deployer environment → built-in
 * default. The key is never logged.
 */
import type { AppConfig, ModelSettings } from "../core/ports/config.js";
import { CONSERVATIVE_CAPABILITIES, type ModelCapabilities } from "../core/ports/model.js";

/**
 * The built-in default (MVP.md §3.1). It lives in the composition root, not in
 * `core/`, because a provider name and an endpoint are provider concepts that
 * the domain must not know (§3).
 *
 * Verified: google/gemma-4-26b-a4b-it on OpenRouter — 25.2B total / 3.8B active
 * MoE, 256K context, structured outputs and native function calling.
 */
export const DEFAULT_MODEL_BASE_URL = "https://openrouter.ai/api/v1";
export const DEFAULT_MODEL_ID = "google/gemma-4-26b-a4b-it";

/**
 * Declared capabilities of the default model (§8), never probed by failing. The
 * context ceiling sits well below the model's 256K window because the PoC fits
 * comfortably inside it ("fit the smallest supported model").
 */
export const DEFAULT_MODEL_CAPABILITIES: ModelCapabilities = {
  structuredOutput: true,
  toolCalls: true,
  streaming: false,
  maxContextTokens: 32768,
};

export interface EnvSource {
  readonly [name: string]: string | undefined;
}

/** Documented in README.md and .env.example — names only, never values (§12.7). */
export const ENV_NAMES = {
  dbPath: "TALK_DB_PATH",
  baseUrl: "TALK_MODEL_BASE_URL",
  modelId: "TALK_MODEL_ID",
  apiKey: "TALK_MODEL_API_KEY",
  capabilities: "TALK_MODEL_CAPABILITIES",
  scheduleHour: "TALK_SCHEDULE_HOUR",
  discordToken: "DISCORD_TOKEN",
  discordAppId: "DISCORD_APP_ID",
  discordGuildId: "DISCORD_GUILD_ID",
} as const;

function nonEmpty(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Declared capabilities, never probed by failing (§8). An unknown endpoint gets
 * the conservative set unless the deployer states otherwise.
 */
function resolveCapabilities(raw: string | undefined, isBuiltInDefault: boolean): ModelCapabilities {
  const stated = nonEmpty(raw);
  if (stated !== undefined) {
    try {
      const parsed = JSON.parse(stated) as Partial<ModelCapabilities>;
      return {
        structuredOutput: parsed.structuredOutput ?? false,
        toolCalls: parsed.toolCalls ?? false,
        streaming: parsed.streaming ?? false,
        maxContextTokens:
          typeof parsed.maxContextTokens === "number" && parsed.maxContextTokens > 0
            ? parsed.maxContextTokens
            : CONSERVATIVE_CAPABILITIES.maxContextTokens,
      };
    } catch {
      throw new Error(
        `${ENV_NAMES.capabilities} must be a JSON object with structuredOutput/toolCalls/streaming/maxContextTokens`,
      );
    }
  }
  return isBuiltInDefault ? DEFAULT_MODEL_CAPABILITIES : CONSERVATIVE_CAPABILITIES;
}

function resolveScheduleHour(raw: string | undefined): number | null {
  if (raw === undefined) {
    return 9;
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return null;
  }
  const hour = Number.parseInt(trimmed, 10);
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) {
    throw new Error(`${ENV_NAMES.scheduleHour} must be an hour 0-23, or empty to disable`);
  }
  return hour;
}

export interface ResolveOptions {
  /** A learner-supplied token, already obtained by a channel adapter. */
  readonly learnerApiKey?: string | null;
  readonly learnerModelId?: string | null;
  readonly learnerBaseUrl?: string | null;
}

export function resolveAppConfig(env: EnvSource, options: ResolveOptions = {}): AppConfig {
  const deployerBaseUrl = nonEmpty(env[ENV_NAMES.baseUrl]);
  const deployerModelId = nonEmpty(env[ENV_NAMES.modelId]);
  const deployerKey = nonEmpty(env[ENV_NAMES.apiKey]);
  const learnerKey = nonEmpty(options.learnerApiKey ?? undefined);

  const baseUrl = nonEmpty(options.learnerBaseUrl ?? undefined) ?? deployerBaseUrl ?? DEFAULT_MODEL_BASE_URL;
  const modelId = nonEmpty(options.learnerModelId ?? undefined) ?? deployerModelId ?? DEFAULT_MODEL_ID;
  const apiKey = learnerKey ?? deployerKey ?? null;
  const source: ModelSettings["source"] =
    learnerKey !== undefined
      ? "learner"
      : deployerKey !== undefined || deployerBaseUrl !== undefined || deployerModelId !== undefined
        ? "deployer"
        : "default";

  const isBuiltInDefault = baseUrl === DEFAULT_MODEL_BASE_URL && modelId === DEFAULT_MODEL_ID;

  return {
    dbPath: nonEmpty(env[ENV_NAMES.dbPath]) ?? "./var/talk-naturally.db",
    model: {
      baseUrl,
      modelId,
      apiKey,
      source,
      capabilities: resolveCapabilities(env[ENV_NAMES.capabilities], isBuiltInDefault),
    },
    schedule: { hourLocal: resolveScheduleHour(env[ENV_NAMES.scheduleHour]) },
  };
}

/** Safe to log: everything except the key. */
export function describeModelSettings(settings: ModelSettings): Record<string, unknown> {
  return {
    baseUrl: settings.baseUrl,
    modelId: settings.modelId,
    source: settings.source,
    hasKey: settings.apiKey !== null,
    capabilities: settings.capabilities,
  };
}
