# 75 — Deployment

> Specification. Code is written from this document (`AGENT.md` §2).

This is the official deployment pathway promised by
[70-stack.md §1](70-stack.md) and the v1 shape in
[10-overview.md §4](10-overview.md). It states the **contract** every deployment
must satisfy (§1) and the **v1 reference implementation** that satisfies it (§2):
a systemd unit template and an installer under `deploy/`.

## 1. The deployment contract

A talk-naturally deployment is **one long-lived server process**. Whatever runs
it — systemd today, a container or an orchestrator later — must provide all of
the following.

1. **Exactly one instance per database file, and per bot token.** Two processes
   writing one SQLite file is unsupported, and two processes on one bot token
   fight over the platform session. One process serves every configured channel
   over one engine and one database ([72-channels.md §4](72-channels.md)), so
   this is an operational invariant, not a preference.
2. **An unprivileged user and no inbound listener.** The server opens no
   listening socket; it only dials out (the Discord gateway, Telegram long
   polling, the model provider). It must not run as root and needs no port or
   firewall configuration.
3. **The checkout as the working directory.** Configuration defaults are
   relative: `TALK_BUILTIN_DIR` defaults to `datasets/builtin` and `TALK_DB_PATH`
   to `./var/talk-naturally.db`. The process must start with the repository root
   as its working directory.
4. **Configuration from the environment, secrets from a file outside version
   control.** Variable *names* are defined once in `hosts/config.ts`
   (`ENV_NAMES`) and documented in [`README.md`](../README.md); values live in
   `.env` (git-ignored, mode `600`) or the process environment. Secrets — the
   channel bot tokens and the model API key — never appear in the unit file, the
   repository, or a log line ([`AGENT.md`](../AGENT.md) §4.7).
5. **Learner data on a durable local path.** `var/` holds the SQLite database.
   Deployment actions never delete or rewrite it; upgrades preserve it
   ([30-domain-model.md §5](30-domain-model.md)).
6. **Graceful shutdown on `SIGTERM`.** The host stops the scheduler, closes the
   channel, closes storage, and exits 0 ([50-orchestration.md §2](50-orchestration.md)).
   A deployment must allow time for that.
7. **Restart on failure, bounded.** A crashed process is restarted; a crash loop
   is not retried forever.
8. **Logs to the platform's log sink**, one JSON line per event, with no message
   content at info level ([`AGENT.md`](../AGENT.md) §4.7). Under systemd that is
   the journal.
9. **Runtime from the checkout.** The server runs TypeScript through `tsx`
   (`pnpm start`). `tsx` is a dev dependency today, so the install includes dev
   dependencies; a compiled production artifact is deferred (D-029, §6).

## 2. Reference implementation: systemd

Linux with systemd is the v1 target: one host, one unit, no container runtime
(D-028). Two artifacts implement it.

| File | Role |
|---|---|
| `deploy/talk-naturally.service.in` | unit template with placeholders `@REPO_DIR@`, `@RUN_USER@`, `@RUN_GROUP@`, `@PNPM@` |
| `deploy/install.sh` | renders the template, installs `/etc/systemd/system/talk-naturally.service`, reloads systemd, enables and restarts the service; `--uninstall` removes it; `--dry-run` renders without touching the system |

The template is deliberately not installable as-is. `install.sh` is the only
supported way to create the unit, so the rendered values stay consistent and no
unsubstituted placeholder can reach systemd.

### 2.1 What the unit guarantees

- `Type=simple`, `WorkingDirectory=@REPO_DIR@`, `ExecStart=@PNPM@ start`,
  `Environment=NODE_ENV=production` plus an explicit `PATH` (systemd does not
  inherit the operator's shell).
- `User`/`Group` are rendered by the installer (`--user`/`--group`), defaulting
  to the invoking user; the service never runs as root.
- `After=network-online.target` and `Wants=network-online.target`.
- `Restart=on-failure`, `RestartSec=5`, with `StartLimitIntervalSec` and
  `StartLimitBurst` so a crash loop stops instead of spinning (contract §1.7).
- `KillSignal=SIGTERM` and a `TimeoutStopSec` long enough for the graceful
  shutdown in contract §1.6.
- `StandardOutput=journal`, `StandardError=journal`, `SyslogIdentifier=talk-naturally`.
- Conservative hardening — `NoNewPrivileges`, `PrivateTmp`, `ProtectSystem=full`,
  `ProtectKernelTunables`, `ProtectControlGroups`, `RestrictSUIDSGID` — and
  deliberately **no** `ProtectHome`, because the checkout and `var/` may live
  under `/home`.

### 2.2 Install

Prerequisites on the host: Node ≥ 22, pnpm, git, and systemd. Then, as the
operator:

```bash
git clone <repo> talk-naturally && cd talk-naturally
pnpm install --frozen-lockfile
cp .env.example .env        # fill in DISCORD_TOKEN, DISCORD_APP_ID, …
chmod 600 .env
sudo bash deploy/install.sh --repo "$PWD" --user "$(id -un)"
systemctl status talk-naturally
journalctl -u talk-naturally -f
```

The installer renders the unit, warns when `.env` is missing or readable beyond
its owner, reports when more than one server process is already running
(contract §1.1), installs and enables the unit, and restarts it. Running it again
is the upgrade path:

```bash
git pull
pnpm install --frozen-lockfile
sudo bash deploy/install.sh --repo "$PWD" --user "$(id -un)"
```

The database in `var/` is not touched by an upgrade.

### 2.3 Uninstall

```bash
sudo bash deploy/install.sh --uninstall
```

Stops and disables the service and removes the unit. `var/` (learner data) and
`.env` (secrets) are left in place on purpose; deleting them is a separate,
deliberate act.

## 3. Configuration

The full variable table lives in [`README.md`](../README.md), and the names are
defined once in code by `ENV_NAMES` (`hosts/config.ts`) so the unit, the docs,
and the composition root cannot drift. **At least one channel must be
configured** ([72-channels.md §4](72-channels.md)): Discord needs `DISCORD_TOKEN`
and `DISCORD_APP_ID`; Telegram needs `TELEGRAM_TOKEN`. Optional:
`DISCORD_GUILD_ID`, `TALK_DB_PATH`, `TALK_MODEL_BASE_URL`, `TALK_MODEL_ID`,
`TALK_MODEL_API_KEY`, `TALK_MODEL_CAPABILITIES`, `TALK_SCHEDULE_HOUR`,
`TALK_BUILTIN_DIR`.

None of these is set in the unit file: the app reads `.env` itself through
`tsx --env-file-if-exists=.env`. The unit sets only `NODE_ENV` and `PATH`.

## 4. Operational notes

- **One instance.** If the process was also started by hand, stop one of them;
  the installer warns when it sees more than one.
- **The gateway drops briefly on restart.** The scheduler is started only after
  the channel connects, so no session is sent into a dead connection
  ([50-orchestration.md §2](50-orchestration.md)).
- **Model credential.** With no `TALK_MODEL_API_KEY`, every turn fails until a
  learner supplies a key with `/model`; the host logs
  `server.no_deployer_model_key` at start.
- **No TLS and no reverse proxy.** There is no inbound HTTP surface in v1, so
  none is configured.

## 5. Testing the artifacts

`tests/deployment.test.ts` runs offline, with no root and no systemd:

- the unit template carries the required directives and no secret values;
- `deploy/install.sh` passes `bash -n`;
- `deploy/install.sh --dry-run` renders a placeholder-free unit and changes
  nothing on the system;
- `design/70-stack.md` no longer reports deployment as a TODO, and this document
  is listed in [`00-index.md`](00-index.md);
- every `TALK_*` or `DISCORD_*` name mentioned by the unit template or this
  document is a value of `ENV_NAMES`.

Installing the unit on a real host is an operator action, not part of
`pnpm verify`.

## 6. Non-goals (deferred)

Each item below is a TODO, not an implied capability:

- **Containers and orchestrators** (Docker, Compose, Kubernetes): deferred. The
  contract in §1 is what a container would have to satisfy (D-028).
- **A compiled production artifact** — running without `tsx` and installing with
  `pnpm install --prod`: D-029.
- **TLS, reverse proxy, inbound HTTP:** not needed while Discord is the only
  channel ([10-overview.md §4](10-overview.md)).
- **Multi-instance and high availability:** contradicts contract §1 (one bot
  token, one SQLite file).
- **Secret-manager integration, automated backups, retention and deletion
  tooling:** real obligations named in [10-overview.md §4](10-overview.md) and
  still open; the deployment pathway does not pretend to solve them.
- **Non-systemd platforms** (macOS, Windows, OpenRC): out of scope for v1.
