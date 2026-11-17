#!/usr/bin/env bash
# Deploys the loop-state MCP on the host it runs on (the homelab): writes
# ~/.config/argus/loop-state-mcp.env from Bitwarden Secrets Manager (chmod 600; the old
# apps/loop-state-mcp/.env is deprecated, argus-config#1267), builds, and restarts the systemd user unit.
#
# Secrets pulled from BWS (personal-machine-secrets project), all three required:
#   loop-state-token-afk         the AFK thread's workspace
#   loop-state-token-direction   Aquila (~/aquila)
#   loop-state-token-worker      every other session
# Optional, argus#1118: loop-state-promotion-token is ops-hub's bearer for POST /events/promoted and POST /wake/request (argus#1189).
# Missing, the route stays off (it refuses every caller) and the deploy still goes ahead.
# Each is at least 24 characters; the server refuses shorter ones. The clients read the
# same three secrets through argus-config's scripts/loop-state-client-token.sh.
#
# The db lives on local disk outside every Syncthing folder (SQLite WAL on a synced FS
# corrupts). The server binds 127.0.0.1; `tailscale serve --bg --https=3791
# http://127.0.0.1:3791` publishes it to the tailnet, once, by hand (argus-config#670).
#
#   bash deploy.sh             write the env file, build, restart the unit if it is installed
#   bash deploy.sh --install   first time only: also link and enable systemd/loop-state-mcp.service
#
# Needs BWS_ACCESS_TOKEN — see ~/.bws_token.
set -euo pipefail

# A manual deploy ships only what the deploy branch holds (argus-config#519, #600).
bash "$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)/scripts/require-deploy-checkout.sh"

APP_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "${APP_DIR}/../.." && pwd)"
source "${REPO_ROOT}/scripts/lib/app-env.sh"
ENV_FILE="$(app_env_path loop-state-mcp)"
LEGACY_ENV_FILE="${APP_DIR}/.env"
PACKAGE="@argus/loop-state-mcp"
UNIT="loop-state-mcp.service"
UNIT_DIR="${HOME}/.config/systemd/user"
FNM_BIN="${HOME}/.local/share/fnm/aliases/default/bin"
export PATH="${FNM_BIN}:${PATH}"

INSTALL=false
[[ "${1:-}" == "--install" ]] && INSTALL=true

DB_DIR="${LOOP_STATE_DB_DIR:-${HOME}/.argus/backlog-loop}"
PORT="${LOOP_STATE_PORT:-3791}"
ROLES=(afk direction worker)
MIN_TOKEN_LENGTH=24
HEALTH_TIMEOUT_SECONDS="${LOOP_STATE_HEALTH_TIMEOUT_SECONDS:-60}"

step()  { echo; echo "▶ $*"; }
ok()    { echo "  ✓ $*"; }
fail()  { echo; echo "✗ $*" >&2; exit 1; }

step "[1/5] Checking prerequisites"
for tool in bws jq node pnpm curl; do
  if command -v "$tool" &>/dev/null; then ok "$tool found"; else fail "$tool not found"; fi
done
if node -e 'const [major, minor] = process.versions.node.split(".").map(Number); process.exit(major > 22 || (major === 22 && minor >= 13) ? 0 : 1)'; then
  ok "node $(node --version) has node:sqlite"
else
  fail "node $(node --version) is older than 22.13 (no node:sqlite)"
fi

step "[2/5] Bitwarden Secrets Manager token"
BWS_TOKEN_FILE="${HOME}/.bws_token"
# shellcheck source=/dev/null
[[ -z "${BWS_ACCESS_TOKEN:-}" && -f "$BWS_TOKEN_FILE" ]] && source "$BWS_TOKEN_FILE"
[[ -n "${BWS_ACCESS_TOKEN:-}" ]] || fail "BWS_ACCESS_TOKEN not set — see ${BWS_TOKEN_FILE}"
ok "BWS token loaded"

step "[3/5] Fetching role tokens + writing ${ENV_FILE}"
SECRETS_JSON="$(bws secret list --access-token "$BWS_ACCESS_TOKEN" -o json)"
bws_secret() { jq -r --arg k "$1" '.[] | select(.key==$k) | .value' <<<"$SECRETS_JSON"; }

# Every token is checked before anything is written, so a bad secret leaves no .env.
TOKENS=()
for role in "${ROLES[@]}"; do
  key="loop-state-token-${role}"
  value="$(bws_secret "$key")"
  [[ -n "$value" ]] || fail "${key} is missing from BWS: every role needs a token"
  (( ${#value} >= MIN_TOKEN_LENGTH )) || fail "${key} is shorter than ${MIN_TOKEN_LENGTH} characters"
  [[ "$value" =~ ^[A-Za-z0-9._~+/-]+$ ]] || fail "${key} has characters a role=token list cannot carry (use letters, digits and ._~+/-)"
  TOKENS+=("${role}=${value}")
  ok "$key"
done
TOKEN_SPEC="$(IFS=,; echo "${TOKENS[*]}")"

PROMOTION_TOKEN="$(bws_secret loop-state-promotion-token)"
if [[ -n "$PROMOTION_TOKEN" ]]; then
  (( ${#PROMOTION_TOKEN} >= MIN_TOKEN_LENGTH )) || fail "loop-state-promotion-token is shorter than ${MIN_TOKEN_LENGTH} characters"
  [[ "$PROMOTION_TOKEN" =~ ^[A-Za-z0-9._~+/-]+$ ]] || fail "loop-state-promotion-token has characters a .env value cannot carry (use letters, digits and ._~+/-)"
  ok "loop-state-promotion-token (POST /events/promoted on)"
else
  ok "loop-state-promotion-token not in BWS: POST /events/promoted stays off"
fi

mkdir -p "$DB_DIR"
chmod 700 "$DB_DIR"

# Created 0600 before any secret is written into it.
app_env_ensure_dir
( umask 077; : > "$ENV_FILE" )
chmod 600 "$ENV_FILE"
{
  echo "LOOP_STATE_TOKENS=${TOKEN_SPEC}"
  echo "LOOP_STATE_DB=${DB_DIR}/loop.db"
  echo "LOOP_STATE_HOST=127.0.0.1"
  echo "LOOP_STATE_PORT=${PORT}"
  [[ -z "$PROMOTION_TOKEN" ]] || echo "LOOP_STATE_PROMOTION_TOKEN=${PROMOTION_TOKEN}"
} >> "$ENV_FILE"
ok "${ENV_FILE} written (chmod 600); db at ${DB_DIR}/loop.db"
[[ -f "$LEGACY_ENV_FILE" ]] && app_env_warn_legacy loop-state-mcp "$LEGACY_ENV_FILE"

step "[4/5] Building"
(cd "$REPO_ROOT" && pnpm install --frozen-lockfile --filter "${PACKAGE}...")
(cd "$REPO_ROOT" && pnpm --filter "$PACKAGE" run build)
ok "built dist/"

step "[5/5] Service"
if $INSTALL; then
  mkdir -p "$UNIT_DIR"
  ln -sfn "${APP_DIR}/systemd/${UNIT}" "${UNIT_DIR}/${UNIT}"
  systemctl --user daemon-reload
  systemctl --user enable "$UNIT"
  ok "$UNIT linked and enabled"
fi
if systemctl --user cat "$UNIT" &>/dev/null; then
  # Re-read the unit file first: a restart alone runs the old definition after a change to it (homelab#424).
  systemctl --user daemon-reload
  systemctl --user restart "$UNIT"
  started=$SECONDS
  healthy=false
  for _ in $(seq 1 $((HEALTH_TIMEOUT_SECONDS * 2))); do
    if curl -fsS "http://127.0.0.1:${PORT}/healthz" >/dev/null 2>&1; then healthy=true; break; fi
    sleep 0.5
  done
  $healthy || fail "$UNIT restarted but /healthz does not answer after $((SECONDS - started))s — journalctl --user -u $UNIT"
  ok "$UNIT restarted; /healthz answers on 127.0.0.1:${PORT} after $((SECONDS - started))s"
else
  ok "$UNIT not installed on this host — .env written and built, nothing to restart (use --install)"
fi
