/**
 * Server host — the authority for learner state (AGENT.md §1, §5).
 *
 * This is the composition root: it reads configuration, constructs the
 * adapters, and wires them into the engine. No product logic lives here (§3).
 *
 *   pnpm start        # needs DISCORD_TOKEN and DISCORD_APP_ID
 */
import { resolve } from "node:path";
import { LayeredModelResolver } from "../../adapters/model-resolver.js";
import { RandomIdPort } from "../../adapters/random-ids.js";
import { SqliteStorage } from "../../adapters/sqlite-storage.js";
import { SystemClock } from "../../adapters/system-clock.js";
import { createEngine } from "../../engine/index.js";
import { createDiscordFrontend, type ModelAdmin } from "../../frontends/discord/bot.js";
import { importClassFile } from "../class-import.js";
import { describeModelSettings, ENV_NAMES, resolveAppConfig } from "../config.js";
import { startScheduler } from "../scheduler.js";

/**
 * A failed start must be one actionable line, not a raw SDK payload dump
 * (AGENT.md §12.2, §13). Discord errors can carry the whole request body.
 */
function describeStartupFailure(error: unknown): string {
  const code = (error as { status?: unknown; code?: unknown } | null)?.status ??
    (error as { code?: unknown } | null)?.code;
  if (code === 401 || code === "TokenInvalid") {
    return "Discord rejected the credentials (401). Check DISCORD_TOKEN and DISCORD_APP_ID.";
  }
  if (code === 403) {
    return `Discord refused the request (403). Check that the bot is allowed in DISCORD_GUILD_ID.`;
  }
  if (error instanceof Error) {
    return `${error.name}: ${error.message}`;
  }
  return String(error);
}

async function main(): Promise<void> {
  const env = process.env;
  const config = resolveAppConfig(env);

  const token = env[ENV_NAMES.discordToken];
  const applicationId = env[ENV_NAMES.discordAppId];
  const guildId = env[ENV_NAMES.discordGuildId];

  if (token === undefined || token.trim().length === 0 || applicationId === undefined) {
    console.error(
      `the server host needs ${ENV_NAMES.discordToken} and ${ENV_NAMES.discordAppId}. See .env.example and README.md.`,
    );
    process.exitCode = 1;
    return;
  }

  const logger = (event: Record<string, unknown>): void => {
    console.log(JSON.stringify({ at: new Date().toISOString(), ...event }));
  };

  const storage = new SqliteStorage(config.dbPath);
  const clock = new SystemClock();
  const models = new LayeredModelResolver(config.model, { logger });
  const engine = createEngine({ storage, models, clock, ids: new RandomIdPort(), logger });

  // The PoC gives every new learner the same imported class (§19.2 out of scope).
  const classPath = resolve(env["TALK_CLASS_PATH"] ?? "datasets/german-a1-2-ch8.json");

  async function provision(learnerId: string): Promise<void> {
    const result = await importClassFile(storage, learnerId, classPath, clock.now().toISOString());
    await storage.setSchedule(learnerId, {
      learnerId,
      hourLocal: config.schedule.hourLocal ?? 9,
      enabled: config.schedule.hourLocal !== null,
      lastSessionAt: null,
    });
    logger({
      event: "server.provisioned",
      learnerId,
      classId: result.klass.id,
      points: result.pointCount,
    });
  }

  const modelAdmin: ModelAdmin = {
    describe: (learnerId) => models.describeFor(learnerId),
    setLearnerOverride: (learnerId, apiKey, modelId) => {
      const resolved = resolveAppConfig(env, {
        learnerApiKey: apiKey,
        ...(modelId === undefined ? {} : { learnerModelId: modelId }),
      });
      models.setLearnerOverride(learnerId, resolved.model);
      logger({
        event: "server.learner_model_override",
        learnerId,
        modelId: resolved.model.modelId,
      });
    },
    clearLearnerOverride: (learnerId) => {
      models.clearLearnerOverride(learnerId);
    },
  };

  const frontend = createDiscordFrontend({
    token,
    applicationId,
    guildId,
    engine,
    storage,
    logger,
    provision,
    modelAdmin,
  });

  logger({
    event: "server.starting",
    dbPath: config.dbPath,
    model: describeModelSettings(config.model),
    classPath,
    scheduleHour: config.schedule.hourLocal,
  });

  if (config.model.apiKey === null) {
    logger({
      event: "server.no_deployer_model_key",
      note: "No TALK_MODEL_API_KEY: every turn will fail until a learner supplies a key with /model.",
    });
  }

  try {
    await frontend.start();
  } catch (error) {
    // Fail closed and clean: no half-open database, no scheduler racing a
    // gateway that never connected.
    logger({ event: "server.start_failed", reason: describeStartupFailure(error) });
    await frontend.stop().catch(() => undefined);
    storage.close();
    process.exitCode = 1;
    return;
  }

  // Only schedule sessions once the channel can actually deliver them (§18.1).
  const scheduler = startScheduler({
    storage,
    engine,
    clock,
    logger,
    send: (learnerId, text) => frontend.sendToLearner(learnerId, text),
  });

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    logger({ event: "server.stopping", signal });
    scheduler.stop();
    await frontend.stop();
    storage.close();
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

await main();
