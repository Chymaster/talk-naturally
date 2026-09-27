/**
 * Learner access and approval — design/74-access.md.
 *
 * Offline throughout: the in-memory adapter covers the state machine, the real
 * SQLite adapter covers persistence and the grandfathering backfill, the guard is
 * checked with a stub engine and with the real engine plus the fake model, and
 * the admin commands are driven directly. No network, no channel, no live model.
 */
import { rmSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { createScriptedModel } from "../adapters/fake-model.js";
import { MemoryStorage } from "../adapters/memory-storage.js";
import { StaticModelResolver } from "../adapters/model-resolver.js";
import { SequentialIdPort } from "../adapters/random-ids.js";
import { SqliteStorage } from "../adapters/sqlite-storage.js";
import { FixedClock } from "../adapters/system-clock.js";
import { TextDocumentAdapter } from "../adapters/text-documents.js";
import { guardEngine } from "../engine/access-guard.js";
import { createEngine } from "../engine/index.js";
import { commandOutcome, type ConversationEngine, type TurnOutcome } from "../engine/types.js";
import { resolveChannelAccess } from "../frontends/access.js";
import { ADMIN_USAGE, runAdminCommand } from "../hosts/admin/commands.js";
import { FileLevelCatalog } from "../hosts/catalog-file.js";
import { NOW } from "./fixtures.js";

const created: string[] = [];

function tempPath(): string {
 const path = `./var/test-access-${globalThis.crypto.randomUUID()}.db`;
 created.push(path);
 return path;
}

afterEach(() => {
 for (const path of created.splice(0)) {
 for (const suffix of ["", "-wal", "-shm"]) {
 rmSync(`${path}${suffix}`, { force: true });
 }
 }
});

describe("access records (design/74-access.md §2)", () => {
 it("creates a pending request without a learner", async () => {
 const storage = new MemoryStorage();
 const request = await storage.requestAccess("telegram", "123", "Alice (@alice)");

 expect(request.status).toBe("pending");
 expect(request.learnerId).toBeNull();
 expect(request.displayName).toBe("Alice (@alice)");
 await expect(storage.findLearnerId("telegram", "123")).resolves.toBeNull();
 expect(storage.learnerCount()).toBe(0);
 });

 it("does not duplicate a request and keeps the first display label", async () => {
 const storage = new MemoryStorage();
 const first = await storage.requestAccess("telegram", "123", "Alice");
 const second = await storage.requestAccess("telegram", "123", "Alice Renamed");

 expect(second.requestedAt).toBe(first.requestedAt);
 expect(second.displayName).toBe("Alice");
 expect(await storage.listAccessRequests()).toHaveLength(1);
 });

 it("approving creates and links the learner", async () => {
 const storage = new MemoryStorage();
 await storage.requestAccess("discord", "42", "Bob");
 const approved = await storage.decideAccess("discord", "42", "approved");

 const learnerId = approved?.learnerId ?? "";
 expect(approved?.status).toBe("approved");
 expect(learnerId).toMatch(/^lrn_/u);
 await expect(storage.findLearnerId("discord", "42")).resolves.toBe(learnerId);
 await expect(storage.isLearnerApproved(learnerId)).resolves.toBe(true);
 });

 it("denying revokes the link but keeps the learner, and re-approval reuses it", async () => {
 const storage = new MemoryStorage();
 await storage.requestAccess("discord", "42", "Bob");
 const approved = await storage.decideAccess("discord", "42", "approved");
 const learnerId = approved?.learnerId ?? "";

 const denied = await storage.decideAccess("discord", "42", "denied");
 expect(denied?.status).toBe("denied");
 await expect(storage.findLearnerId("discord", "42")).resolves.toBeNull();
 await expect(storage.isLearnerApproved(learnerId)).resolves.toBe(false);
 // Progress is keyed by learner_id, so the learner must survive a revoke
 // (design/74-access.md §7).
 expect(storage.learnerCount()).toBe(1);

 const again = await storage.decideAccess("discord", "42", "approved");
 expect(again?.learnerId).toBe(learnerId);
 });

 it("returns null when there is nothing to decide", async () => {
 const storage = new MemoryStorage();
 await expect(storage.decideAccess("discord", "nobody", "approved")).resolves.toBeNull();
 });
});

describe("resolveChannelAccess (design/74-access.md §3)", () => {
 it("creates a pending request for an unknown identity", async () => {
 const storage = new MemoryStorage();
 const access = await resolveChannelAccess(storage, "telegram", "9", "Nine");

 expect(access.kind).toBe("pending");
 expect((await storage.getAccessRequest("telegram", "9"))?.status).toBe("pending");
 });

 it("returns denied for a declined identity", async () => {
 const storage = new MemoryStorage();
 await storage.requestAccess("telegram", "9", "Nine");
 await storage.decideAccess("telegram", "9", "denied");

 expect((await resolveChannelAccess(storage, "telegram", "9", "Nine")).kind).toBe("denied");
 });

 it("grants an approved, linked learner", async () => {
 const storage = new MemoryStorage();
 const learnerId = await storage.createLearner();
 await storage.linkChannel("telegram", "9", learnerId);

 expect(await resolveChannelAccess(storage, "telegram", "9", "Nine")).toEqual({
 kind: "granted",
 learnerId,
 });
 });
});

/** A stub engine that records delegation, so the guard is tested in isolation. */
function stubEngine(): { engine: ConversationEngine; calls: string[] } {
 const calls: string[] = [];
 const outcome = (handledAs: string): TurnOutcome =>
 commandOutcome(`inner:${handledAs}`, handledAs, "settings", "turn_inner", "test-v1");
 const engine: ConversationEngine = {
 async handleTurn() {
 calls.push("handleTurn");
 return outcome("handleTurn");
 },
 async startSession() {
 calls.push("startSession");
 return outcome("startSession");
 },
 async startConversation() {
 calls.push("startConversation");
 return outcome("startConversation");
 },
 async handleSettingsCommand() {
 calls.push("handleSettingsCommand");
 return outcome("handleSettingsCommand");
 },
 async fitDocument() {
 calls.push("fitDocument");
 return outcome("fitDocument");
 },
 async getSettings() {
 calls.push("getSettings");
 return null;
 },
 };
 return { engine, calls };
}

describe("guardEngine (design/74-access.md §5)", () => {
 it("blocks every workflow for an unapproved learner without delegating", async () => {
 const storage = new MemoryStorage();
 const { engine, calls } = stubEngine();
 const guarded = guardEngine(engine, storage, new SequentialIdPort("turn"));
 const learnerId = "lrn_missing";

 const turn = await guarded.handleTurn({ learnerId, channel: "discord", text: "hi" });
 expect(turn.branch).toBe("blocked");
 expect(turn.handledAs).toBe("not_approved");

 await guarded.startSession({ learnerId, channel: "discord" });
 await guarded.startConversation({ learnerId, channel: "discord" });
 await guarded.handleSettingsCommand({ learnerId, channel: "discord", text: "/settings" });
 await guarded.fitDocument({
 learnerId,
 filename: "a.txt",
 mediaType: "text/plain",
 bytes: new Uint8Array(),
 });
 await expect(guarded.getSettings(learnerId)).resolves.toBeNull();

 expect(calls).toEqual([]);
 });

 it("delegates once the learner is approved", async () => {
 const storage = new MemoryStorage();
 const { engine, calls } = stubEngine();
 const guarded = guardEngine(engine, storage, new SequentialIdPort("turn"));

 await storage.requestAccess("discord", "1", "Alice");
 const decided = await storage.decideAccess("discord", "1", "approved");
 const learnerId = decided?.learnerId ?? "";

 const turn = await guarded.handleTurn({ learnerId, channel: "discord", text: "hi" });
 expect(calls).toEqual(["handleTurn"]);
 expect(turn.branch).toBe("settings");
 });

 it("makes no model call through the real engine for an unapproved learner", async () => {
 const storage = new MemoryStorage();
 const llm = createScriptedModel([
 { branch: "drift", corrections: [], signals: [], answered_previous_question: false },
 { reply: "inner" },
 ]);
 const inner = createEngine({
 storage,
 models: new StaticModelResolver(llm),
 clock: new FixedClock(NOW),
 ids: new SequentialIdPort("turn"),
 catalog: new FileLevelCatalog(resolve("datasets/builtin")),
 documents: new TextDocumentAdapter(),
 });
 const guarded = guardEngine(inner, storage, new SequentialIdPort("guard"));

 const outcome = await guarded.handleTurn({
 learnerId: "lrn_missing",
 channel: "discord",
 text: "Hallo",
 });

 expect(outcome.branch).toBe("blocked");
 expect(llm.requests).toHaveLength(0);
 });
});

describe("sqlite access storage (design/74-access.md §8)", () => {
 it("grandfathers an existing channel link as approved on reopen", async () => {
 const path = tempPath();
 const first = new SqliteStorage(path);
 const learnerId = await first.createLearner();
 await first.linkChannel("discord", "123456789012345678", learnerId);
 first.close();

 const second = new SqliteStorage(path);
 const backfilled = await second.getAccessRequest("discord", "123456789012345678");
 expect(backfilled?.status).toBe("approved");
 expect(backfilled?.learnerId).toBe(learnerId);
 await expect(second.isLearnerApproved(learnerId)).resolves.toBe(true);
 second.close();
 });

 it("approves, revokes and re-approves through SQLite", async () => {
 const storage = new SqliteStorage(":memory:");
 await storage.requestAccess("telegram", "777", "Carol");

 const approved = await storage.decideAccess("telegram", "777", "approved");
 const learnerId = approved?.learnerId ?? "";
 await expect(storage.findLearnerId("telegram", "777")).resolves.toBe(learnerId);

 await storage.decideAccess("telegram", "777", "denied");
 await expect(storage.findLearnerId("telegram", "777")).resolves.toBeNull();
 await expect(storage.isLearnerApproved(learnerId)).resolves.toBe(false);

 const again = await storage.decideAccess("telegram", "777", "approved");
 expect(again?.learnerId).toBe(learnerId);
 storage.close();
 });

 it("repairs an approved record whose channel link is missing", async () => {
 const path = tempPath();
 const storage = new SqliteStorage(path);
 await storage.requestAccess("telegram", "9", "Nine");
 const approved = await storage.decideAccess("telegram", "9", "approved");
 const learnerId = approved?.learnerId ?? "";
 storage.close();

 // Simulate a link lost outside the storage API.
 const raw = new DatabaseSync(path);
 raw.prepare("DELETE FROM channel_links WHERE channel = ? AND channel_user_id = ?").run("telegram", "9");
 raw.close();

 const reopened = new SqliteStorage(path);
 expect(await resolveChannelAccess(reopened, "telegram", "9", "Nine")).toEqual({
 kind: "granted",
 learnerId,
 });
 await expect(reopened.findLearnerId("telegram", "9")).resolves.toBe(learnerId);
 reopened.close();
 });
});

describe("admin commands (design/74-access.md §4)", () => {
 async function seeded(): Promise<MemoryStorage> {
 const storage = new MemoryStorage();
 await storage.requestAccess("telegram", "111", "Alice (@alice)");
 await storage.requestAccess("discord", "222", "Bob");
 await storage.decideAccess("discord", "222", "approved");
 await storage.requestAccess("telegram", "333", "Spam Bot");
 await storage.decideAccess("telegram", "333", "denied");
 return storage;
 }

 it("lists pending requests as machine-readable JSON", async () => {
 const storage = await seeded();
 const result = await runAdminCommand(["pending", "--json"], storage);

 expect(result.exitCode).toBe(0);
 const payload = JSON.parse(result.stdout) as {
 ok: boolean;
 requests: { channel: string; channelUserId: string; displayName: string | null }[];
 };
 expect(payload.ok).toBe(true);
 expect(payload.requests).toHaveLength(1);
 expect(payload.requests[0]?.channel).toBe("telegram");
 expect(payload.requests[0]?.channelUserId).toBe("111");
 expect(payload.requests[0]?.displayName).toBe("Alice (@alice)");
 });

 it("lists every status", async () => {
 const storage = await seeded();
 const result = await runAdminCommand(["list", "--json"], storage);
 const payload = JSON.parse(result.stdout) as { requests: unknown[] };
 expect(payload.requests).toHaveLength(3);
 });

 it("approves by channel and user", async () => {
 const storage = await seeded();
 const result = await runAdminCommand(
 ["approve", "--channel", "telegram", "--user", "111", "--json"],
 storage,
 );

 expect(result.exitCode).toBe(0);
 const payload = JSON.parse(result.stdout) as {
 request: { status: string; learnerId: string | null };
 };
 expect(payload.request.status).toBe("approved");
 await expect(storage.isLearnerApproved(payload.request.learnerId ?? "")).resolves.toBe(true);
 });

 it("denies (revokes) an approved identity", async () => {
 const storage = await seeded();
 const result = await runAdminCommand(
 ["deny", "--channel=discord", "--user=222", "--json"],
 storage,
 );

 expect(result.exitCode).toBe(0);
 const payload = JSON.parse(result.stdout) as { request: { status: string } };
 expect(payload.request.status).toBe("denied");
 await expect(storage.findLearnerId("discord", "222")).resolves.toBeNull();
 });

 it("fails loudly on a missing flag, an unknown identity, and an unknown command", async () => {
 const storage = await seeded();

 const missing = await runAdminCommand(["approve", "--channel", "telegram", "--json"], storage);
 expect(missing.exitCode).toBe(1);
 expect((JSON.parse(missing.stdout) as { ok: boolean }).ok).toBe(false);

 const unknown = await runAdminCommand(
 ["approve", "--channel", "telegram", "--user", "999"],
 storage,
 );
 expect(unknown.exitCode).toBe(1);
 expect(unknown.stderr).toContain("no access request");

 const bad = await runAdminCommand(["frobnicate"], storage);
 expect(bad.exitCode).toBe(1);
 expect(bad.stderr).toContain("unknown command");
 });

 it("prints a human table, including the display label", async () => {
 const storage = await seeded();
 const result = await runAdminCommand(["pending"], storage);

 expect(result.stdout).toContain("CHANNEL");
 expect(result.stdout).toContain("Alice (@alice)");
 });

 it("prints usage with no arguments", async () => {
 const storage = new MemoryStorage();
 const result = await runAdminCommand([], storage);
 expect(result.exitCode).toBe(0);
 expect(result.stdout).toBe(ADMIN_USAGE);
 });
});
