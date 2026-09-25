/**
 * CLI / dev host — AGENT.md §9.
 *
 * A second composition root over the same core: it wires the fake model and an
 * optional SQLite file, then drives the full loop (import a class, start a
 * session, handle learner turns, re-import). No channel SDK is involved, which
 * is what proves the core is channel-agnostic (§3).
 *
 *   pnpm demo:cli                  # fake model, in-memory storage
 *   pnpm demo:cli --live           # real provider from the environment
 */
import { resolve } from "node:path";
import { createAutoTutorModel } from "../../adapters/fake-model.js";
import { MemoryStorage } from "../../adapters/memory-storage.js";
import { LayeredModelResolver, StaticModelResolver } from "../../adapters/model-resolver.js";
import { RandomIdPort } from "../../adapters/random-ids.js";
import { SqliteStorage } from "../../adapters/sqlite-storage.js";
import { SystemClock } from "../../adapters/system-clock.js";
import type { StoragePort } from "../../core/ports/storage.js";
import { createEngine } from "../../engine/index.js";
import { importClassFile } from "../class-import.js";
import { describeModelSettings, resolveAppConfig } from "../config.js";

interface CliOptions {
  readonly dbPath: string;
  readonly classPath: string;
  readonly live: boolean;
}

function parseArgs(argv: readonly string[]): CliOptions {
  let dbPath = ":memory:";
  let classPath = resolve("datasets/german-a1-2-ch8.json");
  let live = false;

  for (const arg of argv) {
    if (arg === "--live") {
      live = true;
    } else if (arg.startsWith("--db=")) {
      dbPath = arg.slice("--db=".length);
    } else if (arg.startsWith("--class=")) {
      classPath = resolve(arg.slice("--class=".length));
    }
  }
  return { dbPath, classPath, live };
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
      console.log(`   · steering: ${String(event["steering"])}`);
    } else if (name === "turn.branch") {
      console.log(`   · branch: ${String(event["branch"])}`);
    } else if (name === "turn.unattributed_signals") {
      console.log(`   · unattributed signals dropped: ${JSON.stringify(event["signals"])}`);
    } else if (name.includes("error") || name.includes("invalid")) {
      console.log(`   · ${name}: ${String(event["message"] ?? event["detail"] ?? "")}`);
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

  const engine = createEngine({ storage, models, clock, ids: new RandomIdPort(), logger });

  console.log("talk-naturally — proof-of-concept CLI host");
  console.log(
    options.live
      ? `model          ${JSON.stringify(describeModelSettings(config.model))}`
      : "model          fake auto-tutor (no network; use --live for a real provider)",
  );
  console.log(`storage        ${options.dbPath}`);
  console.log(`class file     ${options.classPath}`);

  const learnerId = await storage.createLearner();
  await storage.linkChannel("cli", "local", learnerId);
  await storage.setSchedule(learnerId, {
    learnerId,
    hourLocal: config.schedule.hourLocal ?? 9,
    enabled: config.schedule.hourLocal !== null,
    lastSessionAt: null,
  });

  console.log("\n— import —");
  const first = await importClassFile(storage, learnerId, options.classPath, clock.now().toISOString());
  line("class", `${first.klass.id}  "${first.klass.title}"`);
  line("points", `${first.pointCount} (${first.klass.grammar.length} grammar, ${first.klass.sentenceStructure.length} structure, ${first.klass.vocab.length} vocab)`);
  line("re-import", String(first.reimport));

  console.log("\n— scheduled session start —");
  const opening = await engine.startSession({ learnerId, classId: first.klass.id, channel: "cli" });
  line("branch", opening.handledAs);
  line("agent", opening.reply);

  console.log("\n— conversation —");
  let last = opening;
  for (const message of DEMO_MESSAGES) {
    line("learner", message);
    last = await engine.handleTurn({
      learnerId,
      classId: first.klass.id,
      channel: "cli",
      text: message,
    });
    line("agent", last.reply);
    console.log(
      `   · branch=${last.branch} handledAs=${last.handledAs} targets=${last.targetIds.length} progressUpdates=${last.appliedDeltas} unattributed=${last.unattributedSignals}`,
    );
  }

  console.log("\n— re-import the same class (AGENT.md §6.4) —");
  const second = await importClassFile(storage, learnerId, options.classPath, clock.now().toISOString());
  line("re-import", String(second.reimport));
  line("added", String(second.added));
  line("retired", String(second.retired));
  line("unchanged", String(second.unchanged));

  console.log("\n— progress (persisted counters, derived state is computed) —");
  const progress = [...(await storage.getProgress(learnerId, first.klass.id))].sort(
    (left, right) => right.timesSeen - left.timesSeen,
  );
  for (const row of progress.slice(0, 8)) {
    const point = [...first.klass.grammar, ...first.klass.sentenceStructure, ...first.klass.vocab].find(
      (candidate) => candidate.id === row.knowledgePointId,
    );
    line(
      row.knowledgePointId,
      `seen=${row.timesSeen} used=${row.timesUsed} helped=${row.timesUsedWithHelp} wrong=${row.timesWrong}  ${point?.title ?? "?"}`,
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
