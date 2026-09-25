/**
 * Discord driving adapter — AGENT.md §5 (the v1 channel).
 *
 * This is a thin translation layer: it turns Discord events into engine calls
 * and engine replies into messages. All product logic stays in the core. Learner
 * identity is resolved here because only this adapter knows a Discord id (§6.6).
 *
 * Reading normal message text requires the Message Content intent (privileged);
 * `/start` works without it.
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
import { DISCORD, discordUserIdOf } from "./identity.js";

const DISCORD_MESSAGE_LIMIT = 2000;
const SAFE_MESSAGE_LIMIT = 1900;

/** What this adapter is allowed to do to model configuration (MVP.md §3). */
export interface ModelAdmin {
  describe(learnerId: string): { modelId: string; baseUrl: string; source: string };
  setLearnerOverride(learnerId: string, apiKey: string, modelId?: string): void;
  clearLearnerOverride(learnerId: string): void;
}

export interface DiscordFrontendOptions {
  readonly token: string;
  readonly applicationId: string;
  readonly guildId?: string | undefined;
  readonly engine: ConversationEngine;
  readonly storage: StoragePort;
  readonly logger?: EngineLogger;
  /** First contact: give the learner something to study. Owned by the host. */
  readonly provision?: (learnerId: string) => Promise<void>;
  readonly modelAdmin?: ModelAdmin | undefined;
  readonly client?: Client;
}

export interface DiscordFrontend {
  start(): Promise<void>;
  stop(): Promise<void>;
  /** Deliver a scheduler-started session. Returns false when there is no DM to send. */
  sendToLearner(learnerId: string, text: string): Promise<boolean>;
}

const COMMANDS = [
  new SlashCommandBuilder().setName("start").setDescription("Start a practice session now."),
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
  const { engine, storage, logger, token, applicationId, guildId, provision, modelAdmin } = options;

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

  /** First contact provisions a learner on the server; linking is never guessed (§6.6). */
  async function resolveLearner(channelUserId: string): Promise<string> {
    const discordId = discordUserIdOf(channelUserId);
    const existing = await storage.findLearnerId(DISCORD, discordId);
    if (existing !== null) {
      return existing;
    }
    const learnerId = await storage.createLearner();
    await storage.linkChannel(DISCORD, discordId, learnerId);
    if (provision !== undefined) {
      await provision(learnerId);
    }
    logger?.({ event: "discord.learner_provisioned", learnerId });
    return learnerId;
  }

  async function currentClassId(learnerId: string): Promise<string | null> {
    const classes = await storage.listClasses(learnerId);
    return classes[0]?.id ?? null;
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

  async function handleMessage(message: {
    author: { id: string; bot: boolean };
    content: string;
    channel: { sendTyping?: () => Promise<void> } & { type?: ChannelType };
    reply: (content: string) => Promise<unknown>;
  }): Promise<void> {
    if (message.author.bot || message.content.trim().length === 0) {
      return;
    }

    try {
      const learnerId = await resolveLearner(message.author.id);
      const classId = await currentClassId(learnerId);
      if (classId === null) {
        await message.reply(
          "I do not have any study material for you on this server yet. Ask the operator to import your class.",
        );
        return;
      }

      await message.channel.sendTyping?.().catch(() => undefined);

      const outcome = await engine.handleTurn({
        learnerId,
        classId,
        channel: DISCORD,
        text: message.content,
      });

      // Never log message content at info level (§12.7).
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
    void handleMessage(message);
  });

  client.on(Events.InteractionCreate, (interaction) => {
    void (async () => {
      if (!interaction.isChatInputCommand()) {
        return;
      }
      try {
        const learnerId = await resolveLearner(interaction.user.id);

        if (interaction.commandName === "start") {
          const classId = await currentClassId(learnerId);
          if (classId === null) {
            await interaction.reply("I have no material for you yet.");
            return;
          }
          await interaction.deferReply();
          const outcome = await engine.startSession({ learnerId, classId, channel: DISCORD });
          await interaction.editReply(clip(outcome.reply));
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
