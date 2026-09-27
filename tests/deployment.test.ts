/**
 * Deployment artifact conformance (design/75-deployment.md §5).
 *
 * The unit template, the installer, and the design doc have to agree, and the
 * unit must never carry a secret. Everything here is offline: no root, no
 * systemd, and no service is installed — `--dry-run` is what makes the installer
 * testable. Installing a unit on a real host is an operator action.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ENV_NAMES } from "../hosts/config.js";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const unitTemplate = readFileSync(`${repoRoot}deploy/talk-naturally.service.in`, "utf8");
const installer = `${repoRoot}deploy/install.sh`;

function runInstaller(args: string[]): string {
  return execFileSync("bash", [installer, ...args], { cwd: repoRoot, encoding: "utf8" });
}

describe("deployment: unit template (design/75-deployment.md §2.1)", () => {
  it("declares the deployment contract", () => {
    const required = [
      "Description=",
      "After=network-online.target",
      "Wants=network-online.target",
      "StartLimitIntervalSec=",
      "StartLimitBurst=",
      "Type=simple",
      "User=@RUN_USER@",
      "Group=@RUN_GROUP@",
      "WorkingDirectory=@REPO_DIR@",
      "ExecStart=@PNPM@ start",
      "Restart=on-failure",
      "RestartSec=",
      "KillSignal=SIGTERM",
      "TimeoutStopSec=",
      "StandardOutput=journal",
      "StandardError=journal",
      "NoNewPrivileges=yes",
      "PrivateTmp=yes",
      "ProtectSystem=full",
      "WantedBy=multi-user.target",
    ];
    for (const directive of required) {
      expect(unitTemplate, `unit template is missing ${directive}`).toContain(directive);
    }
    // The checkout and var/ may live under /home (design/75-deployment.md §2.1).
    expect(unitTemplate).not.toMatch(/^ProtectHome=/m);
  });

  it("carries no secret values or names", () => {
    for (const secret of ["DISCORD_TOKEN", "DISCORD_APP_ID", "TELEGRAM_TOKEN", "TALK_MODEL_API_KEY"]) {
      expect(unitTemplate, `unit template must not mention ${secret}`).not.toContain(secret);
    }
  });
});

describe("deployment: installer (design/75-deployment.md §2.2)", () => {
  it("is valid bash", () => {
    expect(() => execFileSync("bash", ["-n", installer], { encoding: "utf8" })).not.toThrow();
  });

  it("renders a placeholder-free unit in --dry-run", () => {
    const out = runInstaller(["--dry-run", "--repo", repoRoot]);

    expect(out).toContain(`WorkingDirectory=${repoRoot}`);
    expect(out).toMatch(/^ExecStart=\S+ start$/m);
    expect(out).toContain("Restart=on-failure");
    expect(out).not.toMatch(/@[A-Z_][A-Z_]*@/);
  });

  it("refuses a directory that is not the checkout", () => {
    const notACheckout = `${repoRoot}/tests/__not_a_checkout__`;
    expect(() => runInstaller(["--dry-run", "--repo", notACheckout])).toThrow();
  });
});

describe("deployment: the design doc is the specification", () => {
  it("is registered and replaced the stack TODO", () => {
    expect(readFileSync(`${repoRoot}design/00-index.md`, "utf8")).toContain("75-deployment.md");

    const stack = readFileSync(`${repoRoot}design/70-stack.md`, "utf8");
    expect(stack).toContain("75-deployment.md");
    expect(stack).not.toContain("Deployment / self-hosting:** TODO");
  });

  it("mentions only real environment variable names", () => {
    const known = new Set<string>(Object.values(ENV_NAMES));
    const sources = [unitTemplate, readFileSync(`${repoRoot}design/75-deployment.md`, "utf8")];

    for (const source of sources) {
      for (const match of source.matchAll(/\b((?:TALK|DISCORD|TELEGRAM)_[A-Z0-9_]+)\b/g)) {
        const name = match[1] ?? "";
        expect(known.has(name), `unknown environment variable ${name}`).toBe(true);
      }
    }
  });
});
