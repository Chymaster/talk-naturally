/**
 * The Telegram adapter, exercised without Telegram (design/72-channels.md §5).
 *
 * The frontend accepts an injectable `TelegramTransport` for exactly this
 * reason: first contact, identity resolution, onboarding, command parsing,
 * attachments, turn dispatch, and proactive delivery are tested with no network
 * and no bot token. The engine runs the real catalog and document adapters, so
 * the wiring the server host uses is the wiring under test.
 *
 * What this does NOT cover: the live Bot API. `start()` against the real
 * endpoint stays unverified until it runs against a real bot.
 */
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createScriptedModel } from "../adapters/fake-model.js";
import { MemoryStorage } from "../adapters/memory-storage.js";
import { StaticModelResolver } from "../adapters/model-resolver.js";
import { SequentialIdPort } from "../adapters/random-ids.js";
import { FixedClock } from "../adapters/system-clock.js";
import { TextDocumentAdapter } from "../adapters/text-documents.js";
import { blankSettings } from "../core/domain/settings.js";
import { ChannelIdentityError } from "../core/identity/identity.js";
import { createEngine } from "../engine/index.js";
import type { ModelAdmin } from "../frontends/model-admin.js";
import { createTelegramFrontend, type TelegramTransport } from "../frontends/telegram/bot.js";
import { TELEGRAM, telegramUserIdOf } from "../frontends/telegram/identity.js";
import { FileLevelCatalog } from "../hosts/catalog-file.js";
import { importClass } from "../hosts/class-import.js";
import { NOW, rawFixture } from "./fixtures.js";

const USER_ID = 123456789;
const CHAT_ID = 123456789;

interface FakeUpdate {
 readonly update_id: number;
 readonly message?: {
 readonly message_id: number;
 readonly from?: {
 readonly id: number;
 readonly is_bot?: boolean;
 readonly first_name?: string;
 readonly last_name?: string;
 readonly username?: string;
 };
 readonly chat: { readonly id: number; readonly type: string };
 readonly text?: string;
 readonly document?: {
 readonly file_id: string;
 readonly file_name?: string;
 readonly mime_type?: string;
 };
 };
}

interface FakeDocument {
 readonly fileId: string;
 readonly path: string;
 readonly bytes: Uint8Array;
}

class FakeTelegramTransport implements TelegramTransport {
 readonly calls: { method: string; params: Record<string, unknown> }[] = [];
 readonly documents: FakeDocument[] = [];
 downloadShouldFail = false;
 sendShouldFail = false;

 private readonly queue: FakeUpdate[] = [];
 private waiter: ((updates: FakeUpdate[]) => void) | null = null;
 private readonly sent: string[] = [];
 private readonly sendWaiters: ((text: string) => void)[] = [];

 async call<T>(
 method: string,
 params: Record<string, unknown> = {},
 signal?: AbortSignal,
 ): Promise<T> {
 this.calls.push({ method, params });
 switch (method) {
 case "getUpdates": {
 // The startup backlog skip asks for the last update only.
 if (params["offset"] === -1) {
 return [] as unknown as T;
 }
 if (this.queue.length > 0) {
 return this.queue.splice(0) as unknown as T;
 }
 return await new Promise<T>((resolve, reject) => {
 if (signal !== undefined) {
 signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
 }
 this.waiter = (updates) => resolve(updates as unknown as T);
 });
 }
 case "sendMessage": {
 if (this.sendShouldFail) {
 throw new Error("network down");
 }
 const text = String(params["text"] ?? "");
 const waiter = this.sendWaiters.shift();
 if (waiter !== undefined) {
 waiter(text);
 } else {
 this.sent.push(text);
 }
 return {} as T;
 }
 case "getFile": {
 const fileId = String(params["file_id"] ?? "");
 const document = this.documents.find((entry) => entry.fileId === fileId);
 return { file_path: document?.path } as unknown as T;
 }
 default:
 return {} as T;
 }
 }

 async download(filePath: string): Promise<Uint8Array> {
 if (this.downloadShouldFail) {
 throw new Error("network down");
 }
 const document = this.documents.find((entry) => entry.path === filePath);
 if (document === undefined) {
 throw new Error(`no document at ${filePath}`);
 }
 return document.bytes;
 }

 push(...updates: FakeUpdate[]): void {
 const waiter = this.waiter;
 if (waiter !== null) {
 this.waiter = null;
 waiter(updates);
 return;
 }
 this.queue.push(...updates);
 }

 /** Resolves with the next message the adapter sends. */
 nextSend(): Promise<string> {
 const existing = this.sent.shift();
 if (existing !== undefined) {
 return Promise.resolve(existing);
 }
 return new Promise<string>((resolveSend) => {
 this.sendWaiters.push(resolveSend);
 });
 }

 methods(): string[] {
 return this.calls.map((call) => call.method);
 }
}

let nextUpdateId = 1;

function incoming(text: string, overrides: Partial<NonNullable<FakeUpdate["message"]>> = {}): FakeUpdate {
 return {
 update_id: nextUpdateId++,
 message: {
 message_id: nextUpdateId++,
 from: { id: USER_ID, is_bot: false, first_name: "Test", username: "test_learner" },
 chat: { id: CHAT_ID, type: "private" },
 text,
 ...overrides,
 },
 };
}

const running: { stop(): Promise<void> }[] = [];

afterEach(async () => {
 await Promise.all(running.splice(0).map((frontend) => frontend.stop().catch(() => undefined)));
});

interface HarnessOptions {
 readonly outputs?: readonly unknown[];
 readonly modelAdmin?: ModelAdmin;
}

async function makeFrontend(options: HarnessOptions = {}) {
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
 const transport = new FakeTelegramTransport();
 const frontend = createTelegramFrontend({
 token: "test-token",
 engine,
 storage,
 transport,
 ...(options.modelAdmin === undefined ? {} : { modelAdmin: options.modelAdmin }),
 });
 await frontend.start();
 running.push(frontend);
 return { storage, transport, frontend, llm };
}

/** A learner with onboarding complete, linked to the test Telegram user. */
async function seedOnboarded(storage: MemoryStorage, level = "A1"): Promise<string> {
 const learnerId = await storage.createLearner();
 await storage.linkChannel(TELEGRAM, String(USER_ID), learnerId);
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
 await storage.linkChannel(TELEGRAM, String(USER_ID), learnerId);
 return learnerId;
}

describe("telegram identity", () => {
 it("accepts a numeric user id and rejects a username", () => {
 expect(telegramUserIdOf(String(USER_ID))).toBe(String(USER_ID));
 expect(TELEGRAM).toBe("telegram");
 expect(() => telegramUserIdOf("some_username")).toThrow(ChannelIdentityError);
 expect(() => telegramUserIdOf(" ")).toThrow(ChannelIdentityError);
 });
});

describe("telegram message handling", () => {
 it("asks for approval on first contact, creating no learner and no model call", async () => {
 const { storage, transport, llm } = await makeFrontend({ outputs: [] });

 transport.push(incoming("Hallo!"));

 expect(await transport.nextSend()).toContain("waiting for the operator");
 await expect(storage.findLearnerId(TELEGRAM, String(USER_ID))).resolves.toBeNull();
 const request = await storage.getAccessRequest(TELEGRAM, String(USER_ID));
 expect(request?.status).toBe("pending");
 // The display label is stored for the operator, never as identity (design/74-access.md §6).
 expect(request?.displayName).toBe("Test (@test_learner)");
 expect(llm.requests).toHaveLength(0);
 });

 it("onboards only after an operator approves the request", async () => {
 const { storage, transport, llm } = await makeFrontend({ outputs: [] });

 transport.push(incoming("Hallo!"));
 await transport.nextSend();

 await storage.decideAccess(TELEGRAM, String(USER_ID), "approved");

 transport.push(incoming("Hallo!"));
 expect(await transport.nextSend()).toContain("Which language");
 expect(llm.requests).toHaveLength(0);
 });

 it("links a returning learner once, without creating a second one", async () => {
 const { storage, transport } = await makeFrontend({
 outputs: [
 { branch: "drift", corrections: [], signals: [], answered_previous_question: false },
 { reply: "one" },
 { branch: "drift", corrections: [], signals: [], answered_previous_question: false },
 { reply: "two" },
 ],
 });
 await seedOnboarded(storage);

 transport.push(incoming("hallo"));
 await transport.nextSend();
 transport.push(incoming("nochmal"));
 await transport.nextSend();

 expect(storage.learnerCount()).toBe(1);
 });

 it("runs a normal turn once settings are seeded", async () => {
 const { storage, transport, llm } = await makeFrontend({
 outputs: [
 { branch: "drift", corrections: [], signals: [], answered_previous_question: false },
 { reply: "Fußball ist toll!" },
 ],
 });
 await seedOnboarded(storage);

 transport.push(incoming("Am Wochenende spiele ich Fußball."));

 expect(await transport.nextSend()).toBe("Fußball ist toll!");
 expect(llm.requests).toHaveLength(2);
 // Types the action before answering, so the learner sees activity.
 expect(transport.methods()).toContain("sendChatAction");
 });

 it("routes a slash command to the settings commands", async () => {
 const { storage, transport, llm } = await makeFrontend({ outputs: [] });
 await seedOnboarded(storage);

 transport.push(incoming("/language German"));

 expect(await transport.nextSend()).toContain("Which level of German");
 expect(llm.requests).toHaveLength(0);
 });

 it("strips a bot mention from a command", async () => {
 const { storage, transport } = await makeFrontend({
 outputs: [{ reply: "Hallo! Etwas Neues?" }],
 });
 await seedOnboarded(storage);

 transport.push(incoming("/new@talk_bot"));

 expect(await transport.nextSend()).toContain("Etwas Neues?");
 });

 it("ignores other bots, empty messages, and group chats", async () => {
 const { storage, transport, llm } = await makeFrontend({ outputs: [] });

 transport.push(
 { update_id: 9001, message: { message_id: 1, from: { id: 5, is_bot: true }, chat: { id: 5, type: "private" }, text: "beep" } },
 { update_id: 9002, message: { message_id: 2, from: { id: USER_ID, is_bot: false }, chat: { id: CHAT_ID, type: "private" }, text: "   " } },
 { update_id: 9003, message: { message_id: 3, from: { id: USER_ID, is_bot: false }, chat: { id: -1000, type: "group" }, text: "Hallo!" } },
 // A normal private message from a different user proves the queue was
 // drained sequentially: once it is answered, the three above were handled.
 { update_id: 9004, message: { message_id: 4, from: { id: 777, is_bot: false }, chat: { id: 777, type: "private" }, text: "Hallo!" } },
 );

 expect(await transport.nextSend()).toContain("waiting for the operator");
 expect(llm.requests).toHaveLength(0);
 await expect(storage.findLearnerId(TELEGRAM, "5")).resolves.toBeNull();
 await expect(storage.findLearnerId(TELEGRAM, String(USER_ID))).resolves.toBeNull();
 // The group message never created anything; the unrelated private user only
 // reached the access gate, so it is a pending request, not a learner.
 await expect(storage.findLearnerId(TELEGRAM, "777")).resolves.toBeNull();
 expect((await storage.getAccessRequest(TELEGRAM, "777"))?.status).toBe("pending");
 });

 it("answers with the retryable failure message when the model is unavailable", async () => {
 const { storage, transport } = await makeFrontend({ outputs: [] });
 await seedOnboarded(storage);

 transport.push(incoming("hallo"));

 expect(await transport.nextSend()).toContain("Try again");
 });

 it("clips a reply that exceeds the Telegram message limit", async () => {
 const { storage, transport, frontend } = await makeFrontend({ outputs: [] });
 await seedOnboarded(storage);
 const learnerId = await storage.findLearnerId(TELEGRAM, String(USER_ID));

 expect(await frontend.sendToLearner(learnerId!, "x".repeat(5000))).toBe(true);
 const sent = await transport.nextSend();

 expect(sent.length).toBe(4001);
 expect(sent.endsWith("…")).toBe(true);
 });

 it("fits an uploaded document and replies with the preview", async () => {
 const { storage, transport, llm } = await makeFrontend({
 outputs: [
 {
 points: [
 { kind: "vocab", title: "der Bahnhof", detail: "station", raw_source: "notes", unit: "" },
 ],
 },
 ],
 });
 transport.documents.push({
 fileId: "file-1",
 path: "documents/notes.txt",
 bytes: new TextEncoder().encode("# Unit 1\nBahnhof"),
 });
 const learnerId = await storage.createLearner();
 await storage.linkChannel(TELEGRAM, String(USER_ID), learnerId);
 await storage.setLearnerSettings(learnerId, {
 ...blankSettings(learnerId),
 targetLanguage: "German",
 updatedAt: NOW,
 });

 transport.push(
 incoming("", {
 document: { file_id: "file-1", file_name: "notes.txt", mime_type: "text/plain" },
 }),
 );

 const reply = await transport.nextSend();
 expect(reply).toContain("notes.txt");
 expect(reply).toContain("knowledge points");
 expect(transport.methods()).toContain("getFile");
 expect(llm.requests[0]?.schemaName).toBe("FittedMaterial");
 });

 it("apologises when the attachment cannot be downloaded", async () => {
 const { storage, transport, llm } = await makeFrontend({ outputs: [] });
 transport.documents.push({
 fileId: "file-1",
 path: "documents/notes.txt",
 bytes: new Uint8Array(),
 });
 transport.downloadShouldFail = true;
 const learnerId = await storage.createLearner();
 await storage.linkChannel(TELEGRAM, String(USER_ID), learnerId);

 transport.push(
 incoming("", { document: { file_id: "file-1", file_name: "notes.txt" } }),
 );

 expect(await transport.nextSend()).toContain("could not download");
 expect(llm.requests).toHaveLength(0);
 });
});

describe("telegram delivery", () => {
 it("reports failure for a learner with no linked channel identity", async () => {
 const { frontend } = await makeFrontend({});
 expect(await frontend.sendToLearner("lrn_unknown", "hello")).toBe(false);
 });

 it("sends to the linked chat, and reports failure when the send fails", async () => {
 const { storage, transport, frontend } = await makeFrontend({ outputs: [] });
 await seedOnboarded(storage);
 const learnerId = await storage.findLearnerId(TELEGRAM, String(USER_ID));

 expect(await frontend.sendToLearner(learnerId!, "session time")).toBe(true);
 expect(await transport.nextSend()).toBe("session time");

 transport.sendShouldFail = true;
 expect(await frontend.sendToLearner(learnerId!, "again")).toBe(false);
 });
});

describe("telegram /model command", () => {
 it("reports the effective model and applies a learner override", async () => {
 const overrides: { learnerId: string; apiKey: string; modelId?: string }[] = [];
 let currentModelId = "deployer-model";
 const modelAdmin: ModelAdmin = {
 describe: () => ({
 modelId: currentModelId,
 baseUrl: "https://example.test/v1",
 source: currentModelId === "deployer-model" ? "deployer" : "learner",
 }),
 setLearnerOverride: (learnerId, apiKey, modelId) => {
 overrides.push({ learnerId, apiKey, ...(modelId === undefined ? {} : { modelId }) });
 if (modelId !== undefined) {
 currentModelId = modelId;
 }
 },
 clearLearnerOverride: () => undefined,
 };
 const { storage, transport } = await makeFrontend({ outputs: [], modelAdmin });
 await seedOnboarded(storage);

 transport.push(incoming("/model"));
 expect(await transport.nextSend()).toContain("deployer-model");

 transport.push(incoming("/model learner-key my-model"));
 expect(await transport.nextSend()).toContain("my-model");
 expect(overrides).toHaveLength(1);
 expect(overrides[0]?.apiKey).toBe("learner-key");
 expect(overrides[0]?.modelId).toBe("my-model");
 expect(overrides[0]?.learnerId).toMatch(/^lrn_/u);
 });

 it("explains itself when the deployment fixes the model", async () => {
 const { storage, transport } = await makeFrontend({});
 await seedApproved(storage);

 transport.push(incoming("/model"));

 expect(await transport.nextSend()).toContain("fixed by the operator");
 });
});

describe("telegram startup", () => {
 it("registers commands and skips the backlog before polling", async () => {
 const { transport } = await makeFrontend({});

 expect(transport.methods()).toContain("setMyCommands");
 const backlog = transport.calls.find(
 (call) => call.method === "getUpdates" && call.params["offset"] === -1,
 );
 expect(backlog).toBeDefined();
 });
});
