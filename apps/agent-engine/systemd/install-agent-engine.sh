#!/usr/bin/env bash
# Install the agent-engine systemd user service on WSL2 so it survives reboots.
# Run once: bash ~/repos/argus/apps/agent-engine/systemd/install-agent-engine.sh
set -euo pipefail

FNM_DIR="${HOME}/.local/share/fnm"
SERVICE_SRC="$(cd "$(dirname "$0")" && pwd)/agent-engine.service"
SERVICE_DEST="${HOME}/.config/systemd/user/agent-engine.service"
DEST="${HOME}/.argus/agent-engine"

step() { echo; echo "▶ $*"; }
ok()   { echo "  ✓ $*"; }
fail() { echo; echo "✗ $*" >&2; exit 1; }

step "[1/3] Ensuring runtime dir and .env exist"
mkdir -p "${DEST}/dist"
if [[ ! -f "${DEST}/.env" ]]; then
  cat > "${DEST}/.env" <<ENV
ARGUS_PORT=3747
ARGUS_VAULT_ROOT=${HOME}/CORTEX
ENV
  ok "${DEST}/.env created"
else
  ok "${DEST}/.env already exists — skipped"
fi

[[ -d "${DEST}/dist" && -f "${DEST}/dist/server/http.js" ]] || echo "  ⚠ dist/server/http.js not found yet — run deploy.sh for agent-engine first"

step "[2/3] Installing systemd user service"
# Use the stable fnm alias path, not a hardcoded version dir — follows fnm's current default.
NODE_BIN="${FNM_DIR}/aliases/default/bin"
PNPM_HOME="${HOME}/.local/share/pnpm"
# The native `claude` installer puts its launcher here; ClaudeAdapter spawns `claude` by name.
CLAUDE_BIN="${HOME}/.local/bin"
mkdir -p "$(dirname "${SERVICE_DEST}")"
sed "s|ExecStart=node|ExecStart=${NODE_BIN}/node|" "${SERVICE_SRC}" \
  | sed "s|\[Service\]|[Service]\nEnvironment=PATH=${NODE_BIN}:${PNPM_HOME}:${FNM_DIR}:${CLAUDE_BIN}:/usr/local/bin:/usr/bin:/bin|" \
  > "${SERVICE_DEST}"
ok "unit written to ${SERVICE_DEST}"

step "[3/3] Enabling + starting"
systemctl --user daemon-reload
systemctl --user enable --now agent-engine
ok "agent-engine enabled (node: ${NODE_BIN}/node)"

echo
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  agent-engine will now start automatically on WSL2 boot."
echo "  Check: systemctl --user status agent-engine"
echo "  Logs:  journalctl --user -u agent-engine -f"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
