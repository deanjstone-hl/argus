#!/usr/bin/env bash
# Deploys the usage shim on the host it runs on: writes ~/.config/argus/watchtower-usage-shim.env
# (argus-config#1267; the old apps/watchtower-usage-shim/.env is deprecated) from Bitwarden
# Secrets Manager (BWS, see sys-admin#28), then builds and restarts the service
# if this host is the one running it. On any other host it stops after .env.
# Run this on the host the shim itself runs on (WSL2 today; Windows separately).
#
# Secret pulled from BWS: "watchtower-usage-shim-token-wsl2" (personal-machine-secrets
# project). Add a matching "watchtower-usage-shim-token-windows" secret + branch
# below once a Windows token is generated and stored in Bitwarden.
#
# Needs BWS_ACCESS_TOKEN set — see ~/.argus/watchtower/.bws-token.
# Run: bash deploy.sh
set -euo pipefail

# A manual deploy ships only what the deploy branch holds (argus-config#519, #600).
bash "$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)/scripts/require-deploy-checkout.sh"

REPO_DIR="$(cd "$(dirname "$0")" && pwd)"
source "${REPO_DIR}/../../scripts/lib/app-env.sh"
ENV_FILE="$(app_env_path watchtower-usage-shim)"
LEGACY_ENV_FILE="${REPO_DIR}/.env"

step()  { echo; echo "▶ $*"; }
ok()    { echo "  ✓ $*"; }
warn()  { echo "  ⚠  $*"; }
fail()  { echo; echo "✗ $*" >&2; exit 1; }

step "[1/3] Checking prerequisites"
command -v bws &>/dev/null && ok "bws CLI found" || fail "bws CLI not found"
command -v jq  &>/dev/null && ok "jq found"      || fail "jq not found"

step "[2/3] Bitwarden Secrets Manager token"
BWS_TOKEN_FILE="${HOME}/.bws_token"
[[ -f "$BWS_TOKEN_FILE" ]] && source "$BWS_TOKEN_FILE"
: "${BWS_ACCESS_TOKEN:?BWS_ACCESS_TOKEN not set — see ${BWS_TOKEN_FILE}}"
ok "BWS token loaded"

step "[3/3] Fetching secret + writing ${ENV_FILE}"
SECRETS_JSON="$(bws secret list --access-token "$BWS_ACCESS_TOKEN" -o json)"
bws_secret() { echo "$SECRETS_JSON" | jq -r --arg k "$1" '.[] | select(.key==$k) | .value' 2>/dev/null || true; }

USAGE_SHIM_TOKEN=$(bws_secret "watchtower-usage-shim-token-wsl2")
[[ -n "$USAGE_SHIM_TOKEN" ]] && ok "watchtower-usage-shim-token-wsl2" || warn "watchtower-usage-shim-token-wsl2 — EMPTY (BWS secret missing)"

USAGE_SHIM_PORT="${USAGE_SHIM_PORT:-8765}"
# GET /host (argus#682): %LOCALAPPDATA% as a WSL path, for the crash-dump
# folders. Asked of Windows when cmd.exe is reachable, else the usual path.
if [[ -z "${HOST_LOCALAPPDATA:-}" ]] && command -v cmd.exe &>/dev/null && command -v wslpath &>/dev/null; then
  HOST_LOCALAPPDATA="$(wslpath "$(cmd.exe /c 'echo %LOCALAPPDATA%' 2>/dev/null | tr -d '\r')" 2>/dev/null || true)"
fi
HOST_LOCALAPPDATA="${HOST_LOCALAPPDATA:-/mnt/c/Users/${USER}/AppData/Local}"
HOST_UNITS="${HOST_UNITS:-agent-engine.service,memory-reconcile.timer}"

app_env_ensure_dir
( umask 077; : > "$ENV_FILE" )
chmod 600 "$ENV_FILE"
{
  echo "USAGE_SHIM_TOKEN=${USAGE_SHIM_TOKEN}"
  echo "USAGE_SHIM_PORT=${USAGE_SHIM_PORT}"
  echo "HOST_LOCALAPPDATA=${HOST_LOCALAPPDATA}"
  echo "HOST_UNITS=${HOST_UNITS}"
} >> "$ENV_FILE"
ok "${ENV_FILE} written (chmod 600)"
[[ -f "$LEGACY_ENV_FILE" ]] && app_env_warn_legacy watchtower-usage-shim "$LEGACY_ENV_FILE"

step "Building and restarting (if this host runs the service)"
UNIT="watchtower-usage-shim.service"
if systemctl --user list-unit-files "$UNIT" &>/dev/null && systemctl --user list-unit-files "$UNIT" | grep -q "$UNIT"; then
  pnpm install --frozen-lockfile
  pnpm run build
  systemctl --user restart "$UNIT"
  ok "$UNIT rebuilt and restarted"
else
  ok "$UNIT not installed on this host — .env written, nothing to restart"
fi
