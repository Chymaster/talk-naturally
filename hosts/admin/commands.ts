/**
 * Admin command logic — design/74-access.md §4.
 *
 * Approval is an operator tool, not a screen: every command is a single
 * non-interactive invocation that prints one JSON document with `--json`, so a
 * tool-calling operator can decide and read the result
 * (design/74-access.md §4). The logic lives here, separated from the entry
 * point, so it is tested offline through the storage port without spawning a
 * process (design/70-stack.md §5).
 */
import type { AccessRequest, StoragePort } from "../../core/ports/storage.js";

export interface AdminResult {
 readonly exitCode: number;
 readonly stdout: string;
 readonly stderr: string;
}

export interface ParsedAdminArgs {
 readonly command: string | null;
 readonly channel: string | null;
 readonly user: string | null;
 readonly json: boolean;
}

export const ADMIN_USAGE = `Approve or deny learner access (design/74-access.md §4).

Usage:
  pnpm admin pending [--json]
  pnpm admin list [--json]
  pnpm admin approve --channel <discord|telegram> --user <id> [--json]
  pnpm admin deny    --channel <discord|telegram> --user <id> [--json]

Options:
  --channel <name>   channel label, e.g. discord or telegram
  --user <id>        the channel's numeric user id
  --json             print one machine-readable JSON document
  -h, --help         show this help
`;

/** Parse `--flag value` and `--flag=value` without a dependency. */
export function parseAdminArgs(argv: readonly string[]): ParsedAdminArgs {
 let command: string | null = null;
 let channel: string | null = null;
 let user: string | null = null;
 let json = false;

 for (let index = 0; index < argv.length; index += 1) {
 const arg = argv[index] ?? "";
 if (arg === "--json") {
 json = true;
 continue;
 }
 if (arg.startsWith("--channel=")) {
 channel = arg.slice("--channel=".length).trim();
 continue;
 }
 if (arg.startsWith("--user=")) {
 user = arg.slice("--user=".length).trim();
 continue;
 }
 if (arg === "--channel" || arg === "--user") {
 const value = (argv[index + 1] ?? "").trim();
 index += 1;
 if (arg === "--channel") {
 channel = value;
 } else {
 user = value;
 }
 continue;
 }
 if (command === null) {
 command = arg.trim();
 }
 }
 return { command, channel: emptyToNull(channel), user: emptyToNull(user), json };
}

function emptyToNull(value: string | null): string | null {
 return value !== null && value.length > 0 ? value : null;
}

function formatTable(requests: readonly AccessRequest[]): string {
 const header = ["CHANNEL", "USER_ID", "STATUS", "NAME", "LEARNER", "REQUESTED", "DECIDED"];
 const rows = requests.map((request) => [
 request.channel,
 request.channelUserId,
 request.status,
 request.displayName ?? "-",
 request.learnerId ?? "-",
 request.requestedAt,
 request.decidedAt ?? "-",
 ]);
 const widths = header.map((title, column) =>
 Math.max(title.length, ...rows.map((row) => (row[column] ?? "").length)),
 );
 const render = (cells: readonly string[]): string =>
 cells.map((cell, column) => cell.padEnd(widths[column] ?? 0)).join("  ").trimEnd();
 return [render(header), ...rows.map(render)].join("\n") + "\n";
}

function summarize(request: AccessRequest): string {
 return `${request.status} ${request.channel}:${request.channelUserId}` +
 (request.learnerId === null ? "" : ` -> ${request.learnerId}`);
}

function failure(parsed: ParsedAdminArgs, error: string): AdminResult {
 const stdout = parsed.json ? `${JSON.stringify({ ok: false, error }, null, 2)}\n` : "";
 const stderr = parsed.json ? "" : `${error}\n`;
 return { exitCode: 1, stdout, stderr };
}

/**
 * Run one admin command against storage. Pure enough to test with the in-memory
 * adapter: no network, no clock, no process exit.
 */
export async function runAdminCommand(
 argv: readonly string[],
 storage: StoragePort,
): Promise<AdminResult> {
 const parsed = parseAdminArgs(argv);

 if (parsed.command === null || parsed.command === "help") {
 return { exitCode: 0, stdout: ADMIN_USAGE, stderr: "" };
 }

 const { command, channel, user, json } = parsed;

 if (command === "pending" || command === "list") {
 const all = await storage.listAccessRequests();
 const requests = command === "pending" ? all.filter((r) => r.status === "pending") : all;
 if (json) {
 return {
 exitCode: 0,
 stdout: `${JSON.stringify({ ok: true, command, requests }, null, 2)}\n`,
 stderr: "",
 };
 }
 if (requests.length === 0) {
 return {
 exitCode: 0,
 stdout: command === "pending" ? "no pending requests\n" : "no access requests\n",
 stderr: "",
 };
 }
 return { exitCode: 0, stdout: formatTable(requests), stderr: "" };
 }

 if (command === "approve" || command === "deny") {
 if (channel === null || user === null) {
 return failure(parsed, `${command} needs --channel <name> and --user <id>`);
 }
 const decided = await storage.decideAccess(
 channel,
 user,
 command === "approve" ? "approved" : "denied",
 );
 if (decided === null) {
 return failure(parsed, `no access request for ${channel}:${user}`);
 }
 if (json) {
 return {
 exitCode: 0,
 stdout: `${JSON.stringify({ ok: true, command, request: decided }, null, 2)}\n`,
 stderr: "",
 };
 }
 return {
 exitCode: 0,
 stdout: `${summarize(decided)}${decided.displayName === null ? "" : ` (${decided.displayName})`}\n`,
 stderr: "",
 };
 }

 return failure(parsed, `unknown command "${command}"\n\n${ADMIN_USAGE}`);
}
