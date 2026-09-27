/**
 * Admin host — approve or deny learner access (design/74-access.md §4).
 *
 * The operator's entry point for the access gate. It opens the same SQLite file
 * the server uses and needs no network or channel connection; a decision takes
 * effect on the learner's next message. Every command is scriptable so a
 * tool-calling operator can drive it.
 *
 * pnpm admin pending
 * pnpm admin approve --channel telegram --user 123456789 --json
 * pnpm admin deny --channel discord --user 123456789012345678
 */
import { SqliteStorage } from "../../adapters/sqlite-storage.js";
import { ENV_NAMES } from "../config.js";
import { ADMIN_USAGE, runAdminCommand } from "./commands.js";

async function main(): Promise<void> {
 const argv = process.argv.slice(2);
 // Help must not create a database file.
 if (argv.length === 0 || argv.includes("--help") || argv.includes("-h")) {
 process.stdout.write(ADMIN_USAGE);
 return;
 }

 const dbPath = process.env[ENV_NAMES.dbPath] ?? "./var/talk-naturally.db";
 const storage = new SqliteStorage(dbPath);
 try {
 const result = await runAdminCommand(argv, storage);
 if (result.stdout.length > 0) {
 process.stdout.write(result.stdout);
 }
 if (result.stderr.length > 0) {
 process.stderr.write(result.stderr);
 }
 process.exitCode = result.exitCode;
 } finally {
 storage.close();
 }
}

await main();
