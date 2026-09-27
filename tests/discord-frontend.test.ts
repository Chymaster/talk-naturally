/**
 * The Discord adapter, exercised without Discord.
 *
 * The frontend accepts an injectable client for exactly this reason: the whole
 * translation layer — first contact, identity resolution, onboarding, settings
 * commands, attachments, turn dispatch, DM delivery — is tested with no network
 * and no bot token. The engine runs the real catalog and document adapters, so
 * the wiring the server host uses is the wiring under test.
 *
 * What this does NOT cover: `start()`, which registers slash commands over REST
 * against the real API. That stays unverified until it runs against a real
 * application (MVP.md MVP.md §8.2).
 */
import { resolve } from "node:path";
import { Events, type Client } from "discord.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createScriptedModel } from "../adapters/fake-model.js";
import { MemoryStorage } from "../adapters/memory-storage.js";
import { StaticModelResolver } from "../adapters/model-resolver.js";
import { SequentialIdPort } from "../adapters/random-ids.js";
import { FixedClock } from "../adapters/system-clock.js";
import { TextDocumentAdapter } from "../adapters/text-documents.js";
import { blankSettings } from "../core/domain/settings.js";
import { ChannelIdentityError } from "../core/identity/identity.js";
import { createEngine } from "../engine/index.js";
import { createDiscordFrontend, type ModelAdmin } from "../frontends/discord/bot.js";
import { discordUserIdOf } from "../frontends/discord/identity.js";
import { FileLevelCatalog } from "../hosts/catalog-file.js";
import { importClass } from "../hosts/class-import.js";
import { NOW, rawFixture } from "./fixtures.js";

const USER_ID = "123456789012345678";

interface Deferred<T> {
 readonly promise: Promise<T>;
 readonly resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
 let resolve!: (value: T) => void;
 const promise = new Promise<T>((res) => {
 resolve = res;
 });
 return { promise, resolve };
}

/** A drift turn is two calls: classify, then the target-language response. */
function driftOutputs(): unknown[] {
 return [
 { branch: "drift", corrections: [], signals: [], answered_previous_question: false },
 { reply: "ok" },
 ];
}

class FakeClient {
 readonly handlers = new Map<string, ((...args: unknown[]) => void)[]>();
 readonly sent: { userId: string; content: string }[] = [];
 fetchShouldFail = false;
 loggedIn = false;
 destroyed = false;

 readonly users = {
 fetch: async (id: string): Promise<{ send: (content: string) => Promise<void> }> => {
 if (this.fetchShouldFail) {
 throw new Error("Cannot send messages to this user");
 }
 return {
 send: async (content: string): Promise<void> => {
 this.sent.push({ userId: id, content });
 },
 };
 },
 };

 on(event: string, handler: (...args: unknown[]) => void): this {
 const list = this.handlers.get(event) ?? [];
 list.push(handler);
 this.handlers.set(event, list);
 return this;
 }

 once(event: string, handler: (...args: unknown[]) => void): this {
 return this.on(event, handler);
 }

 async login(): Promise<string> {
 this.loggedIn = true;
 return "ok";
 }

 async destroy(): Promise<void> {
 this.destroyed = true;
 }

 emit(event: string, ...args: unknown[]): void {
 for (const handler of this.handlers.get(event) ?? []) {
 handler(...args);
 }
 }
}

interface FrontendHarnessOptions {
 readonly outputs?: readonly unknown[];
 readonly modelAdmin?: ModelAdmin;
}

async function makeFrontend(options: FrontendHarnessOptions = {}) {
 const storage = new MemoryStorage();
 const llm = createScriptedModel(options.outputs ?? []);
 const engine = createEngine({
 storage,
 models: new StaticModelResolver(llm),
 clock: new FixedClock(NOW),
 ids: new SequentialIdPort("turn"),
 catalog: new FileLevelCatalog(resolve("datasets/builtin")),
 documents: new TextDocumentAdapter(),
 });
 const client = new FakeClient();

 const frontend = createDiscordFrontend({
 token: "test-token",
 applicationId: "1",
 engine,
 storage,
 client: client as unknown as Client,
 ...(options.modelAdmin === undefined ? {} : { modelAdmin: options.modelAdmin }),
 });

 return { storage, client, frontend, llm };
}

/** A learner with onboarding complete, linked to the test Discord user. */
async function seedOnboarded(storage: MemoryStorage, level = "A1"): Promise<string> {
 const learnerId = await storage.createLearner();
 await storage.linkChannel("discord", USER_ID, learnerId);
 const imported = await importClass(storage, learnerId, rawFixture, NOW);
 await storage.setLearnerSettings(learnerId, {
 ...blankSettings(learnerId),
 targetLanguage: "German",
 level,
 classId: imported.klass.id,
 onboardingStep: "done",
 updatedAt: NOW,
 });
 return learnerId;
}

/**
 * A learner that has been approved. The channel link is the approval marker
 * (design/74-access.md §2), so seeding the link is enough.
 */
async function seedApproved(storage: MemoryStorage): Promise<string> {
 const learnerId = await storage.createLearner();
 await storage.linkChannel("discord", USER_ID, learnerId);
 return learnerId;
}

/** A learner message whose reply we can await deterministically. */
function learnerMessage(
 content: string,
 attachments: { url: string; name: string; contentType?: string | null }[] = [],
) {
 const replied = deferred<string>();
 let replyCount = 0;
 const message = {
 author: { id: USER_ID, bot: false, username: "test_learner" },
 content,
 channel: { sendTyping: async () => undefined },
 attachments: { first: () => attachments[0] },
 reply: async (text: string) => {
 replyCount += 1;
 replied.resolve(text);
 return {};
 },
 };
 return { message, replied, replyCount: () => replyCount };
}

function slashInteraction(commandName: string, options: Record<string, string | null> = {}) {
 const edits = deferred<string>();
 const replyDeferred = deferred<string>();
 const replies: string[] = [];
 return {
 edits,
 replies,
 /** Resolves on the first `reply`, so tests need not race the async handler. */
 replied: replyDeferred,
 interaction: {
 isChatInputCommand: () => true,
 isRepliable: () => true,
 commandName,
 user: { id: USER_ID },
 replied: false,
 deferred: false,
 options: { getString: (name: string) => options[name] ?? null },
 deferReply: async () => undefined,
 editReply: async (text: string) => {
 edits.resolve(text);
 return {};
 },
 reply: async (payload: string | { content: string }) => {
 const content = typeof payload === "string" ? payload : payload.content;
 replies.push(content);
 replyDeferred.resolve(content);
 return {};
 },
 },
 };
}

afterEach(() => {
 vi.unstubAllGlobals();
});

describe("discord identity", () => {
 it("accepts a numeric user id and rejects a username", () => {
 expect(discordUserIdOf(USER_ID)).toBe(USER_ID);
 expect(() => discordUserIdOf("some_username")).toThrow(ChannelIdentityError);
 expect(() => discordUserIdOf(" ")).toThrow(ChannelIdentityError);
 });
});

describe("discord message handling", () => {
 it("asks for approval on first contact, creating no learner and no model call", async () => {
 const { storage, client, llm } = await makeFrontend({ outputs: [] });

 const { message, replied } = learnerMessage("Hallo!");
 client.emit(Events.MessageCreate, message);

 expect(await replied.promise).toContain("waiting for the operator");
 await expect(storage.findLearnerId("discord", USER_ID)).resolves.toBeNull();
 const request = await storage.getAccessRequest("discord", USER_ID);
 expect(request?.status).toBe("pending");
 // The display label is stored for the operator, never as identity (design/74-access.md §6).
 expect(request?.displayName).toBe("test_learner");
 expect(llm.requests).toHaveLength(0);
 });

 it("onboards only after an operator approves the request", async () => {
 const { storage, client, llm } = await makeFrontend({ outputs: [] });

 const first = learnerMessage("Hallo!");
 client.emit(Events.MessageCreate, first.message);
 await first.replied.promise;

 await storage.decideAccess("discord", USER_ID, "approved");

 const second = learnerMessage("Hallo!");
 client.emit(Events.MessageCreate, second.message);
 expect(await second.replied.promise).toContain("Which language");
 await expect(storage.findLearnerId("discord", USER_ID)).resolves.not.toBeNull();
 expect(llm.requests).toHaveLength(0);
 });

 it("routes a leading-slash message to the settings commands", async () => {
 const { storage, client, llm } = await makeFrontend({ outputs: [] });
 await seedApproved(storage);

 const { message, replied } = learnerMessage("/language German");
 client.emit(Events.MessageCreate, message);

 expect(await replied.promise).toContain("Which level of German");
 expect(llm.requests).toHaveLength(0);
 });

 it("starts a new conversation from a typed /new", async () => {
 const { storage, client, llm } = await makeFrontend({
 outputs: [{ reply: "Hallo! Was machst du am Wochenende?" }],
 });
 await seedOnboarded(storage);

 const { message, replied } = learnerMessage("/new");
 client.emit(Events.MessageCreate, message);

 expect(await replied.promise).toContain("Was machst du am Wochenende?");
 expect(llm.requests).toHaveLength(1);
 expect(llm.requests[0]?.schemaName).toBe("OpeningMessage");
 });

 it("runs a normal turn once settings are seeded", async () => {
 const { storage, client, llm } = await makeFrontend({
 outputs: [
 { branch: "drift", corrections: [], signals: [], answered_previous_question: false },
 { reply: "Fußball ist toll!" },
 ],
 });
 await seedOnboarded(storage);

 const { message, replied } = learnerMessage("Am Wochenende spiele ich Fußball.");
 client.emit(Events.MessageCreate, message);

 expect(await replied.promise).toBe("Fußball ist toll!");
 // Classify, then the prose call.
 expect(llm.requests).toHaveLength(2);
 expect(llm.requests[0]?.messages.at(-1)?.content).toBe("Am Wochenende spiele ich Fußball.");
 });

 it("links a returning learner once, without creating a second one", async () => {
 const { storage, client } = await makeFrontend({
 outputs: [
 { branch: "drift", corrections: [], signals: [], answered_previous_question: false },
 { reply: "one" },
 { branch: "drift", corrections: [], signals: [], answered_previous_question: false },
 { reply: "two" },
 ],
 });
 await seedOnboarded(storage);

 const first = learnerMessage("hallo");
 client.emit(Events.MessageCreate, first.message);
 await first.replied.promise;

 const second = learnerMessage("nochmal");
 client.emit(Events.MessageCreate, second.message);
 await second.replied.promise;

 expect(storage.learnerCount()).toBe(1);
 });

 it("ignores other bots and empty messages", async () => {
 const { storage, client, llm } = await makeFrontend({ outputs: driftOutputs() });
 const silent = { reply: async () => ({}) };

 client.emit(Events.MessageCreate, {
 author: { id: "999999999999999999", bot: true },
 content: "beep",
 channel: {},
 ...silent,
 });
 client.emit(Events.MessageCreate, {
 author: { id: USER_ID, bot: false },
 content: " ",
 channel: {},
 ...silent,
 });

 expect(llm.requests).toHaveLength(0);
 // Nothing was linked either: these never reach the engine.
 await expect(storage.findLearnerId("discord", USER_ID)).resolves.toBeNull();
 });

 it("answers with the retryable failure message when the model is unavailable", async () => {
 const { storage, client } = await makeFrontend({ outputs: [] });
 await seedOnboarded(storage);

 const { message, replied } = learnerMessage("hallo");
 client.emit(Events.MessageCreate, message);

 expect(await replied.promise).toContain("Try again");
 });

 it("fits an uploaded document and replies with the preview", async () => {
 const { storage, client, llm } = await makeFrontend({
 outputs: [
 {
 points: [{ kind: "vocab", title: "der Bahnhof", detail: "station", raw_source: "notes", unit: "" }],
 },
 ],
 });
 const learnerId = await storage.createLearner();
 await storage.linkChannel("discord", USER_ID, learnerId);
 await storage.setLearnerSettings(learnerId, {
 ...blankSettings(learnerId),
 targetLanguage: "German",
 updatedAt: NOW,
 });

 const fetched: string[] = [];
 vi.stubGlobal("fetch", async (url: string) => {
 fetched.push(url);
 return { arrayBuffer: async () => new TextEncoder().encode("# Unit 1\nBahnhof").buffer };
 });

 const { message, replied } = learnerMessage("", [
 { url: "https://cdn.test/notes.txt", name: "notes.txt", contentType: "text/plain" },
 ]);
 client.emit(Events.MessageCreate, message);

 const reply = await replied.promise;
 expect(reply).toContain("notes.txt");
 expect(reply).toContain("knowledge points");
 expect(fetched).toEqual(["https://cdn.test/notes.txt"]);
 expect(llm.requests[0]?.schemaName).toBe("FittedMaterial");
 });

 it("apologises when the attachment cannot be downloaded", async () => {
 const { storage, client, llm } = await makeFrontend({ outputs: [] });
 const learnerId = await storage.createLearner();
 await storage.linkChannel("discord", USER_ID, learnerId);

 vi.stubGlobal("fetch", async () => {
 throw new Error("network down");
 });

 const { message, replied } = learnerMessage("", [
 { url: "https://cdn.test/notes.txt", name: "notes.txt", contentType: "text/plain" },
 ]);
 client.emit(Events.MessageCreate, message);

 expect(await replied.promise).toContain("could not download");
 expect(llm.requests).toHaveLength(0);
 });
});

describe("discord delivery", () => {
 it("reports failure for a learner with no linked channel identity", async () => {
 const { frontend } = await makeFrontend({});
 expect(await frontend.sendToLearner("lrn_unknown", "hello")).toBe(false);
 });

 it("DMs the linked user, and reports failure when the DM cannot be sent", async () => {
 const { storage, client, frontend } = await makeFrontend({ outputs: driftOutputs() });
 await seedOnboarded(storage);

 const { message, replied } = learnerMessage("hallo");
 client.emit(Events.MessageCreate, message);
 await replied.promise;
 const learnerId = await storage.findLearnerId("discord", USER_ID);

 expect(await frontend.sendToLearner(learnerId!, "session time")).toBe(true);
 expect(client.sent.at(-1)).toEqual({ userId: USER_ID, content: "session time" });

 client.fetchShouldFail = true;
 expect(await frontend.sendToLearner(learnerId!, "again")).toBe(false);
 });
});

describe("discord slash commands", () => {
 it("/new opens a new conversation and records the command", async () => {
 const { storage, client, llm } = await makeFrontend({
 outputs: [{ reply: "Hallo! Etwas Neues?" }],
 });
 const learnerId = await seedOnboarded(storage);
 const { interaction, edits } = slashInteraction("new");

 client.emit(Events.InteractionCreate, interaction);
 expect(await edits.promise).toContain("Etwas Neues?");
 expect(llm.requests).toHaveLength(1);
 expect(llm.requests[0]?.schemaName).toBe("OpeningMessage");
 expect(storage.turnsOf(learnerId).at(-1)?.incoming).toBe("/new");
 });

 it("/start opens a session with a target-backed message", async () => {
 const { storage, client } = await makeFrontend({ outputs: [{ reply: "Hallo! Womit fährst du?" }] });
 await seedOnboarded(storage);
 const { interaction, edits } = slashInteraction("start");

 client.emit(Events.InteractionCreate, interaction);
 expect(await edits.promise).toContain("Womit");
 });

 it("/settings shows the learner's seeded settings", async () => {
 const { storage, client } = await makeFrontend({});
 await seedOnboarded(storage);
 const { interaction, replied } = slashInteraction("settings");

 client.emit(Events.InteractionCreate, interaction);
 expect(await replied.promise).toContain("Language: German");
 });

 it("/level changes the level through the settings command", async () => {
 const { storage, client, llm } = await makeFrontend({ outputs: [] });
 const learnerId = await storage.createLearner();
 await storage.linkChannel("discord", USER_ID, learnerId);
 await storage.setLearnerSettings(learnerId, {
 ...blankSettings(learnerId),
 targetLanguage: "German",
 onboardingStep: "level",
 updatedAt: NOW,
 });
 const { interaction, replied } = slashInteraction("level", { value: "A2" });

 client.emit(Events.InteractionCreate, interaction);
 expect(await replied.promise).toContain("German A2");
 const settings = await storage.getLearnerSettings(learnerId);
 expect(settings?.level).toBe("A2");
 expect(llm.requests).toHaveLength(0);
 });

 it("/model reports the effective model and applies a learner override", async () => {
 const overrides: { learnerId: string; apiKey: string; modelId?: string }[] = [];
 const modelAdmin: ModelAdmin = {
 describe: () => ({
 modelId: "deployer-model",
 baseUrl: "https://example.test/v1",
 source: "deployer",
 }),
 setLearnerOverride: (learnerId, apiKey, modelId) => {
 overrides.push({ learnerId, apiKey, ...(modelId === undefined ? {} : { modelId }) });
 },
 clearLearnerOverride: () => undefined,
 };
 const { storage, client } = await makeFrontend({ modelAdmin });
 await seedApproved(storage);

 const show = slashInteraction("model");
 client.emit(Events.InteractionCreate, show.interaction);
 expect(await show.replied.promise).toContain("deployer-model");

 const set = slashInteraction("model", { api_key: "learner-key", model: "my-model" });
 client.emit(Events.InteractionCreate, set.interaction);
 await set.replied.promise;
 expect(overrides).toHaveLength(1);
 expect(overrides[0]?.apiKey).toBe("learner-key");
 expect(overrides[0]?.modelId).toBe("my-model");
 expect(overrides[0]?.learnerId).toMatch(/^lrn_/u);
 });

 it("/model explains itself when the deployment fixes the model", async () => {
 const { storage, client } = await makeFrontend({});
 await seedApproved(storage);
 const { interaction, replied } = slashInteraction("model");

 client.emit(Events.InteractionCreate, interaction);
 expect(await replied.promise).toContain("fixed by the operator");
 });
});
