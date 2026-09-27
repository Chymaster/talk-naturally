/**
 * Discord driving adapter — design/10-overview.md §4 (the v1 channel).
 *
 * This is a thin translation layer: it turns Discord events into engine calls
 * and engine replies into messages. All product logic stays in the core. Learner
 * identity is resolved here because only this adapter knows a Discord id (design/30-domain-model.md §6).
 *
 * Reading normal message text requires the Message Content intent (privileged);
 * `/new` (and its alias `/start`) works without it.
 */
import {
 ChannelType,
 Client,
 Events,
 GatewayIntentBits,
 MessageFlags,
 Partials,
 REST,
 Routes,
 SlashCommandBuilder,
} from "discord.js";
import type { StoragePort } from "../../core/ports/storage.js";
import type { ConversationEngine, EngineLogger } from "../../engine/types.js";
import { TURN_FAILED_REPLY } from "../../engine/types.js";
import {
 ACCESS_DENIED_REPLY,
 ACCESS_PENDING_REPLY,
 resolveChannelAccess,
 type ChannelAccess,
} from "../access.js";
import type { ModelAdmin } from "../model-admin.js";
import { DISCORD, discordUserIdOf } from "./identity.js";

const DISCORD_MESSAGE_LIMIT = 2000;
const SAFE_MESSAGE_LIMIT = 1900;

/** A failed download is the learner's problem to retry, not a crash (design/60-ingestion.md §5). */
const ATTACHMENT_FAILED_REPLY =
 "Sorry — I could not download that file. Please try sending it again.";

/**
 * The channel-neutral learner model contract lives in `../model-admin.ts` and is
 * re-exported here so existing imports keep working (design/72-channels.md §1).
 */
export type { ModelAdmin };

export interface DiscordFrontendOptions {
 readonly token: string;
 readonly applicationId: string;
 readonly guildId?: string | undefined;
 readonly engine: ConversationEngine;
 readonly storage: StoragePort;
 readonly logger?: EngineLogger;
 readonly modelAdmin?: ModelAdmin | undefined;
 readonly client?: Client;
}

export interface DiscordFrontend {
 start(): Promise<void>;
 stop(): Promise<void>;
 /** Deliver a scheduler-started session. Returns false when there is no DM to send. */
 sendToLearner(learnerId: string, text: string): Promise<boolean>;
}

/** The subset of a Discord attachment this adapter uses. */
interface AttachmentLike {
 readonly url: string;
 readonly name: string;
 readonly contentType?: string | null;
}

/** Message fields this adapter reads; kept structural so tests need no Discord client. */
interface MessageLike {
 readonly author: {
 readonly id: string;
 readonly bot: boolean;
 readonly username?: string | null;
 readonly globalName?: string | null;
 };
 readonly content: string;
 readonly channel: { sendTyping?: () => Promise<void> } & { type?: ChannelType };
 readonly attachments?: { first(): AttachmentLike | undefined } | undefined;
 reply(content: string): Promise<unknown>;
}

/**
 * The operator-facing label stored on a pending request. A display name is
 * mutable and stays out of identity (design/74-access.md §6).
 */
function displayNameOf(user: {
 readonly username?: string | null;
 readonly globalName?: string | null;
}): string | null {
 const name = (user.globalName ?? user.username ?? "").trim();
 return name.length > 0 ? name : null;
}

const SETTINGS_COMMANDS = ["settings", "level", "language", "chapter"] as const;

const COMMANDS = [
 new SlashCommandBuilder()
 .setName("new")
 .setDescription("Start a new conversation — I will ask something new."),
 new SlashCommandBuilder()
 .setName("start")
 .setDescription("Start a new conversation (same as /new)."),
 new SlashCommandBuilder()
 .setName("settings")
 .setDescription("Show your language, level and chapter."),
 new SlashCommandBuilder()
 .setName("level")
 .setDescription("Change the level you are studying.")
 .addStringOption((option) =>
 option.setName("value").setDescription("Level tag, e.g. A1.").setRequired(true),
 ),
 new SlashCommandBuilder()
 .setName("language")
 .setDescription("Change the language you are learning.")
 .addStringOption((option) =>
 option.setName("value").setDescription("Language name, e.g. German or Chinese.").setRequired(true),
 ),
 new SlashCommandBuilder()
 .setName("chapter")
 .setDescription("Start at a chapter, or say start for the beginning.")
 .addStringOption((option) =>
 option.setName("value").setDescription("Chapter number or label.").setRequired(true),
 ),
 new SlashCommandBuilder()
 .setName("model")
 .setDescription("Show or change the model used for your sessions.")
 .addStringOption((option) =>
 option
 .setName("api_key")
 .setDescription("Your own provider key. Kept in memory for this run only, never saved.")
 .setRequired(false),
 )
 .addStringOption((option) =>
 option.setName("model").setDescription("Optional model id to use.").setRequired(false),
 ),
];

function clip(text: string): string {
 if (text.length <= DISCORD_MESSAGE_LIMIT) {
 return text;
 }
 return `${text.slice(0, SAFE_MESSAGE_LIMIT)}…`;
}

export function createDiscordFrontend(options: DiscordFrontendOptions): DiscordFrontend {
 const { engine, storage, logger, token, applicationId, guildId, modelAdmin } = options;

 const client =
 options.client ??
 new Client({
 intents: [
 GatewayIntentBits.Guilds,
 GatewayIntentBits.GuildMessages,
 GatewayIntentBits.DirectMessages,
 GatewayIntentBits.MessageContent,
 ],
 partials: [Partials.Channel],
 });

 /**
  * First contact creates a pending access request, never a learner
  * (design/74-access.md §3); linking stays explicit
  * (design/30-domain-model.md §6).
  */
 async function resolveAccess(
 channelUserId: string,
 displayName: string | null,
 ): Promise<ChannelAccess> {
 const discordId = discordUserIdOf(channelUserId);
 const access = await resolveChannelAccess(storage, DISCORD, discordId, displayName);
 if (access.kind !== "granted") {
 logger?.({ event: "discord.access", status: access.kind });
 }
 return access;
 }

 async function registerCommands(): Promise<void> {
 const rest = new REST({ version: "10" }).setToken(token);
 const body = COMMANDS.map((command) => command.toJSON());
 if (guildId !== undefined && guildId.length > 0) {
 // Guild commands appear immediately, which is what a PoC wants.
 await rest.put(Routes.applicationGuildCommands(applicationId, guildId), { body });
 logger?.({ event: "discord.commands_registered", scope: "guild" });
 return;
 }
 await rest.put(Routes.applicationCommands(applicationId), { body });
 logger?.({ event: "discord.commands_registered", scope: "global" });
 }

 /** Fetch a learner-uploaded file and hand it to the engine's fitting pipeline (design/60-ingestion.md §5). */
 async function fitAttachment(
 learnerId: string,
 attachment: AttachmentLike,
 ): Promise<string> {
 try {
 const response = await fetch(attachment.url);
 const bytes = new Uint8Array(await response.arrayBuffer());
 const outcome = await engine.fitDocument({
 learnerId,
 filename: attachment.name,
 mediaType: attachment.contentType ?? "application/octet-stream",
 bytes,
 });
 // The file name is learner data; never log it at info level (AGENT.md §4.7).
 logger?.({ event: "discord.attachment", handledAs: outcome.handledAs });
 return outcome.reply;
 } catch (error) {
 logger?.({
 event: "discord.attachment_failed",
 message: error instanceof Error ? error.message : String(error),
 });
 return ATTACHMENT_FAILED_REPLY;
 }
 }

 async function handleMessage(message: MessageLike): Promise<void> {
 if (message.author.bot) {
 return;
 }
 const text = message.content.trim();
 const attachment = message.attachments?.first() ?? null;
 if (text.length === 0 && attachment === null) {
 return;
 }

 try {
 // Unapproved identities are answered here and never reach the engine
 // (design/74-access.md §3).
 const access = await resolveAccess(message.author.id, displayNameOf(message.author));
 if (access.kind !== "granted") {
 await message.reply(
 access.kind === "pending" ? ACCESS_PENDING_REPLY : ACCESS_DENIED_REPLY,
 );
 return;
 }
 const learnerId = access.learnerId;
 await message.channel.sendTyping?.().catch(() => undefined);

 if (attachment !== null) {
 await message.reply(clip(await fitAttachment(learnerId, attachment)));
 return;
 }

 // A leading slash is a chat command: `/new`/`/start` open a new conversation,
 // everything else is a settings change; the rest is a teaching turn
 // (design/30-domain-model.md §8, design/50-orchestration.md §2–§3).
 const outcome = text.startsWith("/")
 ? await engine.handleSettingsCommand({ learnerId, text: message.content, channel: DISCORD })
 : await engine.handleTurn({ learnerId, channel: DISCORD, text: message.content });

 // Never log message content at info level (AGENT.md §4.7).
 logger?.({
 event: "discord.turn",
 branch: outcome.branch,
 handledAs: outcome.handledAs,
 appliedDeltas: outcome.appliedDeltas,
 unattributedSignals: outcome.unattributedSignals,
 });
 await message.reply(clip(outcome.reply));
 } catch (error) {
 logger?.({
 event: "discord.turn_failed",
 message: error instanceof Error ? error.message : String(error),
 });
 await message.reply(TURN_FAILED_REPLY).catch(() => undefined);
 }
 }

 client.on(Events.MessageCreate, (message) => {
 void handleMessage(message as unknown as MessageLike);
 });

 client.on(Events.InteractionCreate, (interaction) => {
 void (async () => {
 if (!interaction.isChatInputCommand()) {
 return;
 }
 try {
 const access = await resolveAccess(interaction.user.id, displayNameOf(interaction.user));
 if (access.kind !== "granted") {
 await interaction.reply({
 content: access.kind === "pending" ? ACCESS_PENDING_REPLY : ACCESS_DENIED_REPLY,
 flags: MessageFlags.Ephemeral,
 });
 return;
 }
 const learnerId = access.learnerId;

 if (interaction.commandName === "new" || interaction.commandName === "start") {
 // The learner starts a new conversation: the question on the table is
 // replaced and the app asks a new one (design/50-orchestration.md §2).
 await interaction.deferReply();
 const outcome = await engine.startConversation({
 learnerId,
 channel: DISCORD,
 incoming: `/${interaction.commandName}`,
 });
 await interaction.editReply(clip(outcome.reply));
 return;
 }

 if ((SETTINGS_COMMANDS as readonly string[]).includes(interaction.commandName)) {
 // One text command is the single settings entry point on every channel
 // (design/30-domain-model.md §8): synthesize it and reply with the engine's answer.
 const name = interaction.commandName;
 const value = interaction.options.getString("value");
 const text =
 value === null || value.trim().length === 0 ? `/${name}` : `/${name} ${value.trim()}`;
 const outcome = await engine.handleSettingsCommand({ learnerId, text, channel: DISCORD });
 logger?.({ event: "discord.settings_command", handledAs: outcome.handledAs });
 await interaction.reply(clip(outcome.reply));
 return;
 }

 if (interaction.commandName === "model") {
 if (modelAdmin === undefined) {
 await interaction.reply({
 content: "Model configuration is fixed by the operator on this deployment.",
 flags: MessageFlags.Ephemeral,
 });
 return;
 }
 const apiKey = interaction.options.getString("api_key");
 const modelId = interaction.options.getString("model");
 if (apiKey !== null && apiKey.trim().length > 0) {
 modelAdmin.setLearnerOverride(
 learnerId,
 apiKey.trim(),
 modelId === null ? undefined : modelId.trim(),
 );
 const described = modelAdmin.describe(learnerId);
 await interaction.reply({
 content:
 `Using your own key with \`${described.modelId}\`.\n` +
 "It is held in memory for this run only and is never written to storage.",
 flags: MessageFlags.Ephemeral,
 });
 return;
 }
 const described = modelAdmin.describe(learnerId);
 await interaction.reply({
 content:
 `Model: \`${described.modelId}\` (${described.source}) at ${described.baseUrl}.\n` +
 "Pass `api_key` to use your own provider key.",
 flags: MessageFlags.Ephemeral,
 });
 return;
 }
 } catch (error) {
 logger?.({
 event: "discord.interaction_failed",
 message: error instanceof Error ? error.message : String(error),
 });
 if (interaction.isRepliable() && !interaction.replied && !interaction.deferred) {
 await interaction.reply({ content: TURN_FAILED_REPLY, flags: MessageFlags.Ephemeral }).catch(() => undefined);
 }
 }
 })();
 });

 client.once(Events.ClientReady, (readyClient) => {
 logger?.({ event: "discord.ready", user: readyClient.user.tag });
 });

 return {
 async start(): Promise<void> {
 await registerCommands();
 await client.login(token);
 },
 async stop(): Promise<void> {
 await client.destroy();
 },
 async sendToLearner(learnerId: string, text: string): Promise<boolean> {
 const channelUserId = await storage.findChannelUserId(learnerId, DISCORD);
 if (channelUserId === null) {
 return false;
 }
 try {
 const user = await client.users.fetch(channelUserId);
 await user.send(clip(text));
 return true;
 } catch (error) {
 logger?.({
 event: "discord.dm_failed",
 learnerId,
 message: error instanceof Error ? error.message : String(error),
 });
 return false;
 }
 },
 };
}
