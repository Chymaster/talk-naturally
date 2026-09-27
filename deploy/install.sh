#!/usr/bin/env bash
#
# Install, upgrade, or remove the talk-naturally server as a systemd service.
# Specification: design/75-deployment.md §2.
#
#   sudo bash deploy/install.sh --repo "$PWD" --user "$(id -un)"
#   sudo bash deploy/install.sh --uninstall
#        bash deploy/install.sh --dry-run
#
# Installing a service is an operator action; it is never part of `pnpm verify`.

set -euo pipefail

SERVICE_NAME="talk-naturally"
UNIT_DIR="${UNIT_DIR:-/etc/systemd/system}"
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
DEFAULT_REPO="$(cd -- "$SCRIPT_DIR/.." && pwd)"

REPO_DIR="$DEFAULT_REPO"
if [[ -n "${SUDO_USER:-}" && "${SUDO_USER}" != "root" ]]; then
  DEFAULT_USER="$SUDO_USER"
else
  DEFAULT_USER="$(id -un)"
fi
RUN_USER="$DEFAULT_USER"
RUN_GROUP=""
PNPM_BIN="$(command -v pnpm || true)"
DRY_RUN=0
UNINSTALL=0

usage() {
  cat <<'EOF'
Install, upgrade or remove the talk-naturally server as a systemd service.

Usage:
  sudo bash deploy/install.sh [options]

Options:
  --repo DIR      checkout to run (default: the repository containing this script)
  --user USER     user to run the service as (default: the invoking user)
  --group GROUP   group to run the service as (default: USER's primary group)
  --name NAME     service name (default: talk-naturally)
  --dry-run       render the unit and print the plan; change nothing, need no root
  --uninstall     stop, disable and remove the service (leaves var/ and .env)
  -h, --help      show this help

See design/75-deployment.md for the deployment contract.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --repo) REPO_DIR="${2:?--repo needs a directory}"; shift 2 ;;
    --user) RUN_USER="${2:?--user needs a name}"; shift 2 ;;
    --group) RUN_GROUP="${2:?--group needs a name}"; shift 2 ;;
    --name) SERVICE_NAME="${2:?--name needs a name}"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    --uninstall) UNINSTALL=1; shift ;;
    -h | --help) usage; exit 0 ;;
    *)
      echo "unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

# --- validate -----------------------------------------------------------------

if [[ ! -f "$REPO_DIR/package.json" ]] ||
  ! grep -q '"name"[[:space:]]*:[[:space:]]*"talk-naturally"' "$REPO_DIR/package.json"; then
  echo "error: $REPO_DIR is not a talk-naturally checkout (no matching package.json)" >&2
  exit 1
fi

if [[ -z "$RUN_GROUP" ]]; then
  RUN_GROUP="$(id -gn "$RUN_USER" 2>/dev/null || true)"
  RUN_GROUP="${RUN_GROUP:-$RUN_USER}"
fi

TEMPLATE="$SCRIPT_DIR/talk-naturally.service.in"
if [[ ! -f "$TEMPLATE" ]]; then
  echo "error: missing unit template $TEMPLATE" >&2
  exit 1
fi

UNIT_PATH="$UNIT_DIR/$SERVICE_NAME.service"

require_root() {
  if [[ "$(id -u)" -ne 0 ]]; then
    echo "error: installing a systemd unit needs root; re-run with sudo." >&2
    exit 1
  fi
}

render_unit() {
  local unit
  unit="$(<"$TEMPLATE")"
  unit="${unit//@REPO_DIR@/$REPO_DIR}"
  unit="${unit//@RUN_USER@/$RUN_USER}"
  unit="${unit//@RUN_GROUP@/$RUN_GROUP}"
  unit="${unit//@PNPM@/$PNPM_BIN}"
  if grep -q '@[A-Z_][A-Z_]*@' <<<"$unit"; then
    echo "error: the rendered unit still has placeholders; check $TEMPLATE" >&2
    exit 1
  fi
  printf '%s\n' "$unit"
}

# One deployment runs several matching processes (pnpm, sh, tsx, node). Count
# only the node process actually running hosts/server/main, excluding the tsx
# CLI launcher and the shell wrappers (design/75-deployment.md §1.1).
running_servers() {
  local line cmd first
  while IFS= read -r line; do
    [[ -z "$line" ]] && continue
    cmd="${line#* }"
    first="${cmd%% *}"
    [[ "${first##*/}" == "node" ]] || continue
    [[ "$cmd" == *"tsx/dist/cli.mjs"* ]] && continue
    printf '%s\n' "$line"
  done < <(pgrep -af 'hosts/server/main' 2>/dev/null || true)
}

warn_configuration() {
  local env_file="$REPO_DIR/.env"
  if [[ ! -f "$env_file" ]]; then
    echo "warning: $env_file is missing; the server exits without at least one channel (DISCORD_TOKEN + DISCORD_APP_ID, or TELEGRAM_TOKEN; copy .env.example)." >&2
  else
    local mode
    mode="$(stat -c '%a' "$env_file")"
    if [[ "$mode" != "600" && "$mode" != "400" ]]; then
      echo "warning: $env_file is mode $mode; restrict it to its owner (chmod 600) because it holds bot and model secrets." >&2
    fi
  fi
  if [[ ! -d "$REPO_DIR/node_modules" ]]; then
    echo "warning: $REPO_DIR/node_modules is missing; run 'pnpm install --frozen-lockfile' first." >&2
  fi

  local -a servers=()
  mapfile -t servers < <(running_servers)
  if ((${#servers[@]} > 1)); then
    echo "warning: ${#servers[@]} server processes are running; only one instance is allowed per bot token and database (design/75-deployment.md §1.1):" >&2
    printf '  %s\n' "${servers[@]}" >&2
  fi
}

# --- uninstall ----------------------------------------------------------------

if [[ $UNINSTALL -eq 1 ]]; then
  if [[ $DRY_RUN -eq 1 ]]; then
    echo "# would run: systemctl disable --now $SERVICE_NAME"
    echo "# would remove: $UNIT_PATH"
    echo "# would run: systemctl daemon-reload"
    echo "# left in place: $REPO_DIR/var and $REPO_DIR/.env"
    exit 0
  fi
  require_root
  systemctl disable --now "$SERVICE_NAME" 2>/dev/null || true
  rm -f "$UNIT_PATH"
  systemctl daemon-reload
  echo "removed $SERVICE_NAME"
  echo "learner data ($REPO_DIR/var) and secrets ($REPO_DIR/.env) were left in place."
  exit 0
fi

# --- render -------------------------------------------------------------------

if [[ -z "$PNPM_BIN" ]]; then
  echo "error: pnpm was not found on PATH; install pnpm or add it to PATH." >&2
  exit 1
fi

RENDERED="$(render_unit)"
warn_configuration

if [[ $DRY_RUN -eq 1 ]]; then
  echo "# service name: $SERVICE_NAME"
  echo "# would install: $UNIT_PATH"
  printf '%s\n' "$RENDERED"
  echo "# then: systemctl daemon-reload && systemctl enable $SERVICE_NAME && systemctl restart $SERVICE_NAME"
  exit 0
fi

# --- install / upgrade --------------------------------------------------------

require_root

if ! id -u "$RUN_USER" >/dev/null 2>&1; then
  echo "error: user '$RUN_USER' does not exist." >&2
  exit 1
fi

tmp="$(mktemp)"
trap 'rm -f "$tmp"' EXIT
printf '%s\n' "$RENDERED" >"$tmp"
install -m 0644 "$tmp" "$UNIT_PATH"

systemctl daemon-reload
systemctl enable "$SERVICE_NAME" >/dev/null
systemctl restart "$SERVICE_NAME"

echo "installed $UNIT_PATH and (re)started $SERVICE_NAME"
systemctl --no-pager --full status "$SERVICE_NAME" || true
echo "logs: journalctl -u $SERVICE_NAME -f"
