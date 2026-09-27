/**
 * Telegram driving adapter — design/72-channels.md §3.
 *
 * This is a thin translation layer: it turns Telegram updates into engine calls
 * and engine replies into messages, exactly as the Discord adapter does. All
 * product logic stays in the core. Learner identity is resolved here because only
 * this adapter knows a Telegram user id (design/30-domain-model.md §6).
 *
 * The adapter speaks the Bot API directly over `fetch` and long-polls
 * (`getUpdates`), so it needs no channel SDK and opens no inbound listener
 * (design/72-channels.md §3.1). `TelegramTransport` is injectable for the same
 * reason the Discord client is: the whole translation layer is tested with no
 * network and no bot token (design/72-channels.md §5).
 */
import type { StoragePort } from "../../core/ports/storage.js";
import type { ConversationEngine, EngineLogger, TurnOutcome } from "../../engine/types.js";
import { TURN_FAILED_REPLY } from "../../engine/types.js";
import {
 ACCESS_DENIED_REPLY,
 ACCESS_PENDING_REPLY,
 resolveChannelAccess,
 type ChannelAccess,
} from "../access.js";
import type { ModelAdmin } from "../model-admin.js";
import { TELEGRAM, telegramUserIdOf } from "./identity.js";

const TELEGRAM_MESSAGE_LIMIT = 4096;
const SAFE_MESSAGE_LIMIT = 4000;
const DEFAULT_POLL_TIMEOUT_SECONDS = 30;
const POLL_RETRY_MS = 3000;

/** A failed download is the learner's problem to retry, not a crash (design/60-ingestion.md §5). */
const ATTACHMENT_FAILED_REPLY =
 "Sorry — I could not download that file. Please try sending it again.";

/** What `/model` tells a learner whose deployment fixes the model. */
const MODEL_FIXED_REPLY = "Model configuration is fixed by the operator on this deployment.";

/**
 * The Bot API surface this adapter uses. Implementations own HTTP; the adapter
 * owns translation, so tests inject a fake and never touch the network.
 */
export interface TelegramTransport {
 call<T>(method: string, params?: Record<string, unknown>, signal?: AbortSignal): Promise<T>;
 /** Download a file resolved by `getFile` (design/72-channels.md §3.2). */
 download(filePath: string): Promise<Uint8Array>;
}

export interface TelegramFrontendOptions {
 readonly token: string;
 readonly engine: ConversationEngine;
 readonly storage: StoragePort;
 readonly logger?: EngineLogger;
 readonly modelAdmin?: ModelAdmin | undefined;
 readonly transport?: TelegramTransport;
 readonly pollTimeoutSeconds?: number;
}

export interface TelegramFrontend {
 start(): Promise<void>;
 stop(): Promise<void>;
 /** Deliver a scheduler-started session. Returns false when there is no chat to send. */
 sendToLearner(learnerId: string, text: string): Promise<boolean>;
}

interface TelegramUser {
 readonly id: number;
 readonly is_bot?: boolean;
 readonly first_name?: string;
 readonly last_name?: string;
 readonly username?: string;
}

interface TelegramChat {
 readonly id: number;
 readonly type: string;
}

interface TelegramDocument {
 readonly file_id: string;
 readonly file_name?: string;
 readonly mime_type?: string;
}

interface TelegramMessage {
 readonly message_id: number;
 readonly from?: TelegramUser;
 readonly chat: TelegramChat;
 readonly text?: string;
 readonly document?: TelegramDocument;
}

interface TelegramUpdate {
 readonly update_id: number;
 readonly message?: TelegramMessage;
}

/** Shown in the client's command menu; the text path works without it (design/72-channels.md §3.2). */
const COMMANDS = [
 { command: "new", description: "Start a new conversation — I will ask something new." },
 { command: "start", description: "Start a new conversation (same as /new)." },
 { command: "settings", description: "Show your language, level and chapter." },
 { command: "level", description: "Change the level you are studying." },
 { command: "language", description: "Change the language you are learning." },
 { command: "chapter", description: "Start at a chapter, or say start for the beginning." },
 { command: "model", description: "Show or change the model used for your sessions." },
] as const;

function clip(text: string): string {
 if (text.length <= TELEGRAM_MESSAGE_LIMIT) {
 return text;
 }
 return `${text.slice(0, SAFE_MESSAGE_LIMIT)}…`;
}

function describe(error: unknown): string {
 return error instanceof Error ? error.message : String(error);
}

/**
 * `/new@the_bot` is how Telegram addresses a command in a group; the engine's
 * command parser expects the bare `/new` (design/50-orchestration.md §2).
 */
function stripBotMention(text: string): string {
 return text.replace(/^(\/[A-Za-z0-9_]+)@[A-Za-z0-9_]+/u, "$1");
}

/**
 * The operator-facing label stored on a pending request. A name or username is
 * mutable and stays out of identity (design/74-access.md §6).
 */
function displayNameOf(user: TelegramUser): string | null {
 const name = [user.first_name ?? "", user.last_name ?? ""].join(" ").trim();
 const handle = (user.username ?? "").trim();
 const label = handle.length === 0 ? name : name.length === 0 ? `@${handle}` : `${name} (@${handle})`;
 return label.length > 0 ? label : null;
}

class HttpTelegramTransport implements TelegramTransport {
 constructor(private readonly token: string) {}

 async call<T>(
 method: string,
 params: Record<string, unknown> = {},
 signal?: AbortSignal,
 ): Promise<T> {
 const response = await fetch(`https://api.telegram.org/bot${this.token}/${method}`, {
 method: "POST",
 headers: { "content-type": "application/json" },
 body: JSON.stringify(params),
 ...(signal === undefined ? {} : { signal }),
 });
 const payload = (await response.json()) as {
 ok?: boolean;
 result?: T;
 description?: string;
 };
 if (!response.ok || payload.ok !== true) {
 throw new Error(
 `telegram ${method} failed (${response.status}): ${payload.description ?? "unknown error"}`,
 );
 }
 return payload.result as T;
 }

 async download(filePath: string): Promise<Uint8Array> {
 const response = await fetch(`https://api.telegram.org/file/bot${this.token}/${filePath}`);
 if (!response.ok) {
 throw new Error(`telegram file download failed (${response.status})`);
 }
 return new Uint8Array(await response.arrayBuffer());
 }
}

export function createTelegramFrontend(options: TelegramFrontendOptions): TelegramFrontend {
 const { engine, storage, logger, token, modelAdmin } = options;
 const transport = options.transport ?? new HttpTelegramTransport(token);
 const pollTimeoutSeconds = options.pollTimeoutSeconds ?? DEFAULT_POLL_TIMEOUT_SECONDS;

 let controller: AbortController | null = null;
 let polling: Promise<void> | null = null;
 let nextOffset = 0;

 /**
  * First contact creates a pending access request, never a learner
  * (design/74-access.md §3); linking stays explicit
  * (design/30-domain-model.md §6).
  */
 async function resolveAccess(telegramUserId: string, displayName: string | null): Promise<ChannelAccess> {
 const telegramId = telegramUserIdOf(telegramUserId);
 const access = await resolveChannelAccess(storage, TELEGRAM, telegramId, displayName);
 if (access.kind !== "granted") {
 logger?.({ event: "telegram.access", status: access.kind });
 }
 return access;
 }

 async function send(chatId: number, text: string): Promise<void> {
 await transport.call("sendMessage", { chat_id: chatId, text });
 }

 async function registerCommands(signal: AbortSignal): Promise<void> {
 // Commands appear in the private-chat menu; the text path works without this
 // (design/72-channels.md §3.2).
 await transport.call(
 "setMyCommands",
 { commands: COMMANDS, scope: { type: "all_private_chats" } },
 signal,
 );
 logger?.({ event: "telegram.commands_registered", scope: "private_chats" });
 }

 /**
 * Do not replay the backlog after a restart (design/72-channels.md §3.1). The
 * offset itself is in-memory in the PoC; a durable one is a TODO.
 */
 async function skipBacklog(signal: AbortSignal): Promise<void> {
 try {
 const latest = await transport.call<TelegramUpdate[]>(
 "getUpdates",
 { offset: -1, limit: 1, timeout: 0 },
 signal,
 );
 const newest = latest[0];
 if (newest !== undefined) {
 nextOffset = newest.update_id + 1;
 }
 } catch (error) {
 logger?.({ event: "telegram.backlog_skip_failed", message: describe(error) });
 }
 }

 function delay(ms: number, signal: AbortSignal): Promise<void> {
 return new Promise((resolve) => {
 const timer = setTimeout(resolve, ms);
 signal.addEventListener(
 "abort",
 () => {
 clearTimeout(timer);
 resolve();
 },
 { once: true },
 );
 });
 }

 async function fitDocument(learnerId: string, document: TelegramDocument): Promise<string> {
 try {
 const file = await transport.call<{ file_path?: string }>(
 "getFile",
 { file_id: document.file_id },
 controller?.signal,
 );
 const filePath = file.file_path;
 if (filePath === undefined) {
 throw new Error("getFile returned no file_path");
 }
 const bytes = await transport.download(filePath);
 const outcome = await engine.fitDocument({
 learnerId,
 filename: document.file_name ?? "telegram-document",
 mediaType: document.mime_type ?? "application/octet-stream",
 bytes,
 });
 // The file name is learner data; never log it at info level (AGENT.md §4.7).
 logger?.({ event: "telegram.document", handledAs: outcome.handledAs });
 return outcome.reply;
 } catch (error) {
 logger?.({ event: "telegram.document_failed", message: describe(error) });
 return ATTACHMENT_FAILED_REPLY;
 }
 }

 function modelCommandReply(learnerId: string, command: string): string {
 if (modelAdmin === undefined) {
 return MODEL_FIXED_REPLY;
 }
 const argument = command.split(/\s+/u).slice(1).join(" ").trim();
 if (argument.length === 0) {
 const described = modelAdmin.describe(learnerId);
 return (
 `Model: ${described.modelId} (${described.source}) at ${described.baseUrl}.\n` +
 "Send /model <api_key> [model_id] to use your own provider key."
 );
 }
 const [apiKey = "", ...rest] = argument.split(/\s+/u);
 const modelId = rest.join(" ").trim();
 modelAdmin.setLearnerOverride(
 learnerId,
 apiKey,
 modelId.length === 0 ? undefined : modelId,
 );
 const described = modelAdmin.describe(learnerId);
 return (
 `Using your own key with ${described.modelId}.\n` +
 "It is held in memory for this run only and is never written to storage. " +
 "Telegram keeps this message in the chat, so delete it to remove the key from the history."
 );
 }

 /** A slash command is the engine's one text-command path, plus the model command (design/30-domain-model.md §8). */
 async function handleCommand(learnerId: string, chatId: number, text: string): Promise<void> {
 const command = stripBotMention(text);
 const head = command.split(/\s+/u)[0]?.toLowerCase() ?? "";
 if (head === "/model") {
 await send(chatId, modelCommandReply(learnerId, command));
 return;
 }
 // `/new`/`/start` are routed to the new-conversation entry point by the engine
 // before the settings dispatcher sees them (design/50-orchestration.md §2).
 const outcome: TurnOutcome = await engine.handleSettingsCommand({
 learnerId,
 channel: TELEGRAM,
 text: command,
 });
 logger?.({ event: "telegram.command", handledAs: outcome.handledAs });
 await send(chatId, clip(outcome.reply));
 }

 async function handleUpdate(update: TelegramUpdate): Promise<void> {
 const message = update.message;
 if (message === undefined) {
 return;
 }
 const from = message.from;
 if (from === undefined || from.is_bot === true) {
 return;
 }
 // Private chats only: a group would put several learners behind one identity (design/72-channels.md §3.2).
 if (message.chat.type !== "private") {
 return;
 }
 const text = (message.text ?? "").trim();
 const document = message.document ?? null;
 if (text.length === 0 && document === null) {
 return;
 }

 const chatId = message.chat.id;
 try {
 // Unapproved identities are answered here and never reach the engine
 // (design/74-access.md §3).
 const access = await resolveAccess(String(from.id), displayNameOf(from));
 if (access.kind !== "granted") {
 await send(chatId, access.kind === "pending" ? ACCESS_PENDING_REPLY : ACCESS_DENIED_REPLY);
 return;
 }
 const learnerId = access.learnerId;
 await transport
 .call("sendChatAction", { chat_id: chatId, action: "typing" }, controller?.signal)
 .catch(() => undefined);

 if (document !== null) {
 await send(chatId, clip(await fitDocument(learnerId, document)));
 return;
 }

 if (text.startsWith("/")) {
 await handleCommand(learnerId, chatId, text);
 return;
 }

 const outcome = await engine.handleTurn({ learnerId, channel: TELEGRAM, text });
 // Never log message content at info level (AGENT.md §4.7).
 logger?.({
 event: "telegram.turn",
 branch: outcome.branch,
 handledAs: outcome.handledAs,
 appliedDeltas: outcome.appliedDeltas,
 unattributedSignals: outcome.unattributedSignals,
 });
 await send(chatId, clip(outcome.reply));
 } catch (error) {
 logger?.({ event: "telegram.update_failed", message: describe(error) });
 await send(chatId, TURN_FAILED_REPLY).catch(() => undefined);
 }
 }

 async function poll(signal: AbortSignal): Promise<void> {
 while (!signal.aborted) {
 let updates: TelegramUpdate[];
 try {
 updates = await transport.call<TelegramUpdate[]>(
 "getUpdates",
 { offset: nextOffset, timeout: pollTimeoutSeconds, allowed_updates: ["message"] },
 signal,
 );
 } catch (error) {
 if (signal.aborted) {
 return;
 }
 logger?.({ event: "telegram.poll_failed", message: describe(error) });
 await delay(POLL_RETRY_MS, signal);
 continue;
 }
 // Sequential on purpose: a learner's messages keep their order.
 for (const update of updates) {
 nextOffset = Math.max(nextOffset, update.update_id + 1);
 await handleUpdate(update);
 }
 }
 }

 return {
 async start(): Promise<void> {
 controller = new AbortController();
 const signal = controller.signal;
 await registerCommands(signal);
 await skipBacklog(signal);
 polling = poll(signal).catch((error: unknown) => {
 logger?.({ event: "telegram.poll_crashed", message: describe(error) });
 });
 },
 async stop(): Promise<void> {
 controller?.abort();
 await polling?.catch(() => undefined);
 polling = null;
 controller = null;
 },
 async sendToLearner(learnerId: string, text: string): Promise<boolean> {
 const chatUserId = await storage.findChannelUserId(learnerId, TELEGRAM);
 if (chatUserId === null) {
 return false;
 }
 const chatId = Number.parseInt(chatUserId, 10);
 if (!Number.isInteger(chatId)) {
 return false;
 }
 try {
 await send(chatId, clip(text));
 return true;
 } catch (error) {
 logger?.({
 event: "telegram.send_failed",
 learnerId,
 message: describe(error),
 });
 return false;
 }
 },
 };
}
