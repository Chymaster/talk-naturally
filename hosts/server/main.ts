/**
 * Server host — the authority for learner state (design/10-overview.md §3–4).
 *
 * This is the composition root: it reads configuration, constructs the
 * adapters, and wires them into the engine. No product logic lives here (design/20-architecture.md §2).
 *
 * pnpm start # needs at least one channel: DISCORD_TOKEN + DISCORD_APP_ID, or TELEGRAM_TOKEN
 */
import { resolve } from "node:path";
import { LayeredModelResolver } from "../../adapters/model-resolver.js";
import { RandomIdPort } from "../../adapters/random-ids.js";
import { SqliteStorage } from "../../adapters/sqlite-storage.js";
import { SystemClock } from "../../adapters/system-clock.js";
import { TextDocumentAdapter } from "../../adapters/text-documents.js";
import { createEngine } from "../../engine/index.js";
import { guardEngine } from "../../engine/access-guard.js";
import { createDiscordFrontend } from "../../frontends/discord/bot.js";
import type { ModelAdmin } from "../../frontends/model-admin.js";
import { createTelegramFrontend } from "../../frontends/telegram/bot.js";
import { FileLevelCatalog } from "../catalog-file.js";
import { describeModelSettings, ENV_NAMES, resolveAppConfig } from "../config.js";
import { startScheduler } from "../scheduler.js";

/**
 * The surface every chat channel exposes to the host, whatever the platform
 * (design/72-channels.md §1). The host starts, stops, and delivers through the
 * list without branching on the channel.
 */
interface ChannelFrontend {
 start(): Promise<void>;
 stop(): Promise<void>;
 sendToLearner(learnerId: string, text: string): Promise<boolean>;
}

/**
 * A failed start must be one actionable line, not a raw SDK payload dump
 * (AGENT.md AGENT.md §2.1, design/70-stack.md §4). Discord errors can carry the whole
 * request body.
 */
function describeStartupFailure(error: unknown): string {
 const code = (error as { status?: unknown; code?: unknown } | null)?.status ??
 (error as { code?: unknown } | null)?.code;
 if (code === 401 || code === "TokenInvalid") {
 return `A channel rejected the credentials (401). Check DISCORD_TOKEN/DISCORD_APP_ID or TELEGRAM_TOKEN.`;
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

 const discordToken = env[ENV_NAMES.discordToken];
 const discordApplicationId = env[ENV_NAMES.discordAppId];
 const discordGuildId = env[ENV_NAMES.discordGuildId];
 const telegramToken = env[ENV_NAMES.telegramToken];

 const hasDiscord =
 discordToken !== undefined &&
 discordToken.length > 0 &&
 discordApplicationId !== undefined &&
 discordApplicationId.length > 0;
 const hasTelegram = telegramToken !== undefined && telegramToken.length > 0;

 // Chat is the only interface, so at least one channel must be configured
 // (design/72-channels.md §4).
 if (!hasDiscord && !hasTelegram) {
 console.error(
 `the server host needs at least one channel: ${ENV_NAMES.discordToken} + ${ENV_NAMES.discordAppId}, or ${ENV_NAMES.telegramToken}. See .env.example and README.md.`,
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

 // The built-in language library and the document extractor are adapter choices the
 // composition root makes; onboarding and uploads reach them only through ports
 // (design/60-ingestion.md §3, §5; design/20-architecture.md §2).
 const builtinDir = resolve(env[ENV_NAMES.builtinDir] ?? "datasets/builtin");
 const ids = new RandomIdPort();
 const engine = createEngine({
 storage,
 models,
 clock,
 ids,
 catalog: new FileLevelCatalog(builtinDir),
 documents: new TextDocumentAdapter(),
 logger,
 });

 // The access guard is the mechanical guarantee that no workflow runs — and no
 // model call is made — for an unapproved learner (design/74-access.md §5). It
 // wraps the engine once here, so the channels and the scheduler both get it.
 const guardedEngine = guardEngine(engine, storage, ids);

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

 // One process serves every configured channel over one engine, one database,
 // and one scheduler (design/72-channels.md §4).
 const channels: { readonly name: string; readonly frontend: ChannelFrontend }[] = [];

 if (
 discordToken !== undefined &&
 discordToken.length > 0 &&
 discordApplicationId !== undefined &&
 discordApplicationId.length > 0
 ) {
 channels.push({
 name: "discord",
 frontend: createDiscordFrontend({
 token: discordToken,
 applicationId: discordApplicationId,
 guildId: discordGuildId,
 engine: guardedEngine,
 storage,
 logger,
 modelAdmin,
 }),
 });
 } else if (discordToken !== undefined || discordApplicationId !== undefined) {
 logger({
 event: "server.channel_skipped",
 channel: "discord",
 reason: `${ENV_NAMES.discordToken} and ${ENV_NAMES.discordAppId} must both be set`,
 });
 }

 if (telegramToken !== undefined && telegramToken.length > 0) {
 channels.push({
 name: "telegram",
 frontend: createTelegramFrontend({
 token: telegramToken,
 engine: guardedEngine,
 storage,
 logger,
 modelAdmin,
 }),
 });
 }

 logger({
 event: "server.starting",
 dbPath: config.dbPath,
 channels: channels.map((channel) => channel.name),
 model: describeModelSettings(config.model),
 builtinDir,
 scheduleHour: config.schedule.hourLocal,
 });

 if (config.model.apiKey === null) {
 logger({
 event: "server.no_deployer_model_key",
 note: "No TALK_MODEL_API_KEY: every turn will fail until a learner supplies a key with /model.",
 });
 }

 try {
 for (const channel of channels) {
 await channel.frontend.start();
 }
 } catch (error) {
 // Fail closed and clean: no half-open database, no scheduler racing a
 // channel that never connected.
 logger({ event: "server.start_failed", reason: describeStartupFailure(error) });
 await Promise.all(
 channels.map((channel) => channel.frontend.stop().catch(() => undefined)),
 );
 storage.close();
 process.exitCode = 1;
 return;
 }

 // Only schedule sessions once a channel can actually deliver them (design/50-orchestration.md §2).
 const scheduler = startScheduler({
 storage,
 engine: guardedEngine,
 clock,
 logger,
 send: async (learnerId, text) => {
 for (const channel of channels) {
 if (await channel.frontend.sendToLearner(learnerId, text)) {
 return true;
 }
 }
 return false;
 },
 });

 let shuttingDown = false;
 const shutdown = async (signal: string): Promise<void> => {
 if (shuttingDown) {
 return;
 }
 shuttingDown = true;
 logger({ event: "server.stopping", signal });
 scheduler.stop();
 await Promise.all(
 channels.map((channel) => channel.frontend.stop().catch(() => undefined)),
 );
 storage.close();
 process.exit(0);
 };

 process.on("SIGINT", () => void shutdown("SIGINT"));
 process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

await main();
