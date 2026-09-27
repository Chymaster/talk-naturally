/**
 * Learner-settings persistence for both storage adapters, and cross-learner
 * isolation (design/30-domain-model.md §7–8, design/70-stack.md §5).
 */
import { rmSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { MemoryStorage } from "../adapters/memory-storage.js";
import { SqliteStorage } from "../adapters/sqlite-storage.js";
import type { StoragePort } from "../core/ports/storage.js";
import { NOW } from "./fixtures.js";

const createdPaths: string[] = [];
const opened: StoragePort[] = [];

afterEach(() => {
 for (const storage of opened.splice(0)) {
 if ("close" in storage && typeof storage.close === "function") {
 storage.close();
 }
 }
 for (const path of createdPaths.splice(0)) {
 for (const suffix of ["", "-wal", "-shm"]) {
 rmSync(`${path}${suffix}`, { force: true });
 }
 }
});

interface Adapter {
 readonly name: string;
 open(): StoragePort;
}

const adapters: readonly Adapter[] = [
 { name: "MemoryStorage", open: () => new MemoryStorage() },
 {
 name: "SqliteStorage",
 open: () => {
 const path = `./var/test-${globalThis.crypto.randomUUID()}.db`;
 createdPaths.push(path);
 return new SqliteStorage(path);
 },
 },
];

function openStorage(adapter: Adapter): StoragePort {
 const storage = adapter.open();
 opened.push(storage);
 return storage;
}

for (const adapter of adapters) {
 describe(`${adapter.name} learner settings`, () => {
 it("returns null for a learner with no settings", async () => {
 const storage = openStorage(adapter);
 const learnerId = await storage.createLearner();

 expect(await storage.getLearnerSettings(learnerId)).toBeNull();
 });

 it("round-trips settings and keeps learners isolated", async () => {
 const storage = openStorage(adapter);
 const alice = await storage.createLearner();
 const bob = await storage.createLearner();

 const aliceSettings = {
 learnerId: alice,
 targetLanguage: "German",
 level: "A2",
 classId: "cls_german_a2",
 knownThroughUnit: 4,
 includedLevels: ["A1", "A2"],
 onboardingStep: "done" as const,
 updatedAt: NOW,
 };
 await storage.setLearnerSettings(alice, aliceSettings);

 expect(await storage.getLearnerSettings(alice)).toEqual(aliceSettings);
 expect(await storage.getLearnerSettings(bob)).toBeNull();

 const bobSettings = {
 learnerId: bob,
 targetLanguage: "French",
 level: null,
 classId: null,
 knownThroughUnit: 0,
 includedLevels: [],
 onboardingStep: "language" as const,
 updatedAt: NOW,
 };
 await storage.setLearnerSettings(bob, bobSettings);

 expect(await storage.getLearnerSettings(bob)).toEqual(bobSettings);
 expect(await storage.getLearnerSettings(alice)).toEqual(aliceSettings);
 });

 it("overwrites the previous settings for the same learner", async () => {
 const storage = openStorage(adapter);
 const learnerId = await storage.createLearner();

 await storage.setLearnerSettings(learnerId, {
 learnerId,
 targetLanguage: "German",
 level: "A1",
 classId: "cls_german_a1",
 knownThroughUnit: 0,
 includedLevels: [],
 onboardingStep: "chapter",
 updatedAt: NOW,
 });
 await storage.setLearnerSettings(learnerId, {
 learnerId,
 targetLanguage: "German",
 level: "A2",
 classId: "cls_german_a2",
 knownThroughUnit: 2,
 includedLevels: ["A1"],
 onboardingStep: "done",
 updatedAt: NOW,
 });

 expect(await storage.getLearnerSettings(learnerId)).toMatchObject({
 level: "A2",
 classId: "cls_german_a2",
 knownThroughUnit: 2,
 includedLevels: ["A1"],
 onboardingStep: "done",
 });
 });
 });
}
