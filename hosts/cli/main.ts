/**
 * CLI / dev host — design/70-stack.md §2.
 *
 * A second composition root over the same core: it wires the fake model and an
 * optional SQLite file, then drives the real loop — onboard through conversation,
 * start a session, handle learner turns, optionally import a class file. No
 * channel SDK is involved, which is what proves the core is channel-agnostic
 * (design/20-architecture.md §2).
 *
 * pnpm demo:cli # fake model, in-memory storage
 * pnpm demo:cli --live # real provider from the environment
 * pnpm demo:cli --level=B1 --chapter=3 # skip the onboarding questions
 * pnpm demo:cli --class=datasets/german-a1-2-ch8.json # also import a file
 */
import { resolve } from "node:path";
import { createAutoTutorModel } from "../../adapters/fake-model.js";
import { MemoryStorage } from "../../adapters/memory-storage.js";
import { LayeredModelResolver, StaticModelResolver } from "../../adapters/model-resolver.js";
import { RandomIdPort } from "../../adapters/random-ids.js";
import { SqliteStorage } from "../../adapters/sqlite-storage.js";
import { SystemClock } from "../../adapters/system-clock.js";
import { currentUnitOf } from "../../core/domain/settings.js";
import type { StoragePort } from "../../core/ports/storage.js";
import { createEngine } from "../../engine/index.js";
import { FileLevelCatalog } from "../catalog-file.js";
import { importClassFile } from "../class-import.js";
import { describeModelSettings, ENV_NAMES, resolveAppConfig } from "../config.js";

interface CliOptions {
 readonly dbPath: string;
 /** A class file to import in addition to the onboarding-selected built-in level. */
 readonly classPath: string | null;
 readonly level: string | null;
 readonly chapter: string | null;
 readonly live: boolean;
}

function parseArgs(argv: readonly string[]): CliOptions {
 let dbPath = ":memory:";
 let classPath: string | null = null;
 let level: string | null = null;
 let chapter: string | null = null;
 let live = false;

 for (const arg of argv) {
 if (arg === "--live") {
 live = true;
 } else if (arg.startsWith("--db=")) {
 dbPath = arg.slice("--db=".length);
 } else if (arg.startsWith("--class=")) {
 classPath = resolve(arg.slice("--class=".length));
 } else if (arg.startsWith("--level=")) {
 level = arg.slice("--level=".length);
 } else if (arg.startsWith("--chapter=")) {
 chapter = arg.slice("--chapter=".length);
 }
 }
 return { dbPath, classPath, level, chapter, live };
}

const DEMO_MESSAGES: readonly string[] = [
 "Hallo! Ich gehe mit der Bus zur Arbeit.",
 "Wie sagt man „I change trains\" auf Deutsch?",
 "Am Wochenende spiele ich Fußball mit Freunden.",
 "Ich fahre mit dem Fahrrad, das dauert zehn Minuten.",
];

function line(label: string, value: string): void {
 console.log(`${label.padEnd(14)} ${value}`);
}

async function main(): Promise<void> {
 const options = parseArgs(process.argv.slice(2));
 const config = resolveAppConfig(process.env);

 const storage: StoragePort =
 options.dbPath === ":memory:" ? new MemoryStorage() : new SqliteStorage(options.dbPath);
 const clock = new SystemClock();

 const logger = (event: Record<string, unknown>): void => {
 const name = String(event["event"] ?? "");
 if (name === "turn.targets_selected" || name === "session.targets_selected") {
 console.log(` · steering: ${String(event["steering"])}`);
 } else if (name === "turn.branch") {
 console.log(` · branch: ${String(event["branch"])}`);
 } else if (name === "turn.unattributed_signals") {
 console.log(` · unattributed signals dropped: ${JSON.stringify(event["signals"])}`);
 } else if (name.includes("error") || name.includes("invalid")) {
 console.log(` · ${name}: ${String(event["message"] ?? event["detail"] ?? "")}`);
 }
 };

 if (options.live && config.model.apiKey === null) {
 console.error(
 `--live needs a model key. Set TALK_MODEL_API_KEY (or TALK_MODEL_BASE_URL/TALK_MODEL_ID for another endpoint).`,
 );
 process.exitCode = 1;
 return;
 }

 const models = options.live
 ? new LayeredModelResolver(config.model, { logger })
 : new StaticModelResolver(createAutoTutorModel());

 // Onboarding resolves language and level through the same catalog the server
 // uses (design/60-ingestion.md §3; design/20-architecture.md §2).
 const builtinDir = resolve(process.env[ENV_NAMES.builtinDir] ?? "datasets/builtin");
 const engine = createEngine({
 storage,
 models,
 clock,
 ids: new RandomIdPort(),
 catalog: new FileLevelCatalog(builtinDir),
 logger,
 });

 console.log("talk-naturally — CLI host with the real onboarding flow");
 console.log(
 options.live
 ? `model ${JSON.stringify(describeModelSettings(config.model))}`
 : "model fake auto-tutor (no network; use --live for a real provider)",
 );
 console.log(`storage ${options.dbPath}`);
 console.log(`built-in catalog ${builtinDir}`);

 const learnerId = await storage.createLearner();
 await storage.linkChannel("cli", "local", learnerId);
 await storage.setSchedule(learnerId, {
 learnerId,
 hourLocal: config.schedule.hourLocal ?? 9,
 enabled: config.schedule.hourLocal !== null,
 lastSessionAt: null,
 });

 console.log("\n— onboarding —");
 if (options.level !== null || options.chapter !== null) {
 // Scripted setup goes through the same settings commands a channel sends
 // (design/30-domain-model.md §8). A chapter needs a level first.
 const level = options.level ?? "A1";
 const commands = ["/language German", `/level ${level}`];
 if (options.chapter !== null) {
 commands.push(`/chapter ${options.chapter}`);
 }
 for (const command of commands) {
 line("learner", command);
 const outcome = await engine.handleSettingsCommand({
 learnerId,
 text: command,
 channel: "cli",
 });
 line("agent", outcome.reply);
 }
 } else {
 // The deterministic onboarding questions: no model call (design/60-ingestion.md §3).
 for (const answer of ["German", "A1", "start"]) {
 line("learner", answer);
 const outcome = await engine.handleTurn({ learnerId, channel: "cli", text: answer });
 line("agent", outcome.reply);
 }
 }

 console.log("\n— resolved settings —");
 const settings = await engine.getSettings(learnerId);
 line("language", settings?.targetLanguage ?? "not set");
 line("level", settings?.level ?? "not set");
 line("class", settings?.classId ?? "not set");
 line("known through", String(settings?.knownThroughUnit ?? 0));
 line("reviewing", settings === null || settings.includedLevels.length === 0 ? "none" : settings.includedLevels.join(", "));
 const activeClass =
 settings?.classId == null ? null : await storage.getClass(learnerId, settings.classId);
 const chapter =
 activeClass === null
 ? null
 : currentUnitOf(
 activeClass,
 await storage.getProgress(learnerId, activeClass.id),
 settings?.knownThroughUnit ?? 0,
 );
 line("current chapter", chapter === null ? "none" : `${chapter.unitOrder}. ${chapter.unit}`);

 if (options.classPath !== null) {
 console.log("\n— import a class file —");
 const first = await importClassFile(storage, learnerId, options.classPath, clock.now().toISOString());
 line("class", `${first.klass.id} "${first.klass.title}"`);
 line(
 "points",
 `${first.pointCount} (${first.klass.grammar.length} grammar, ${first.klass.sentenceStructure.length} structure, ${first.klass.vocab.length} vocab)`,
 );

 console.log("\n— re-import the same file (design/30-domain-model.md §4) —");
 const second = await importClassFile(storage, learnerId, options.classPath, clock.now().toISOString());
 line("re-import", String(second.reimport));
 line("added", String(second.added));
 line("retired", String(second.retired));
 line("unchanged", String(second.unchanged));
 }

 console.log("\n— scheduled session start —");
 const opening = await engine.startSession({ learnerId, channel: "cli" });
 line("branch", opening.handledAs);
 line("agent", opening.reply);

 console.log("\n— conversation —");
 let last = opening;
 for (const message of DEMO_MESSAGES) {
 line("learner", message);
 last = await engine.handleTurn({ learnerId, channel: "cli", text: message });
 line("agent", last.reply);
 console.log(
 ` · branch=${last.branch} handledAs=${last.handledAs} targets=${last.targetIds.length} progressUpdates=${last.appliedDeltas} unattributed=${last.unattributedSignals}`,
 );
 }

 console.log("\n— start a new conversation (/new) —");
 // The learner's new-conversation entry point: the question on the table is
 // replaced and the app asks a new one (design/50-orchestration.md §2).
 line("learner", "/new");
 const fresh = await engine.handleSettingsCommand({
 learnerId,
 channel: "cli",
 text: "/new",
 });
 line("branch", fresh.handledAs);
 line("agent", fresh.reply);

 console.log("\n— progress (persisted counters, derived state is computed) —");
 const rows = activeClass === null ? [] : await storage.getProgress(learnerId, activeClass.id);
 const progress = [...rows].sort((left, right) => right.timesSeen - left.timesSeen);
 for (const row of progress.slice(0, 8)) {
 const point =
 activeClass === null
 ? undefined
 : [...activeClass.grammar, ...activeClass.sentenceStructure, ...activeClass.vocab].find(
 (candidate) => candidate.id === row.knowledgePointId,
 );
 line(
 row.knowledgePointId,
 `seen=${row.timesSeen} used=${row.timesUsed} helped=${row.timesUsedWithHelp} wrong=${row.timesWrong} ${point?.title ?? "?"}`,
 );
 }
 if (progress.length === 0) {
 console.log("(no progress rows — the model returned no attributable signals)");
 }

 console.log("\n— turn log —");
 line("last turn id", last.turnId);
 line("prompt version", last.promptVersion);
 line("steering reason", last.steeringReason.slice(0, 120));

 if (storage instanceof SqliteStorage) {
 storage.close();
 }
}

await main();
