#!/usr/bin/env bash
# Deploy t3-peer-mcp's stdio server to ~/.argus/t3-peer-mcp/ on this machine.
# Run it on every T3 environment (WSL2 and homelab): each one drives the other.
#
# Builds from this checkout, not a release: a local stdio server for one user
# needs no published release. Claude Code starts it through
# argus-config's hooks/t3-peer-mcp-launch.sh, registered by
# register_t3_peer_mcp in argus-config's scripts/lib.sh, which also points
# T3_PEER_CONFIG at that environment's envs/<env>/t3-peers.json.
#
# Needs no secrets: every call mints a short-lived session on the peer over ssh.
set -euo pipefail

# A manual deploy ships only what the deploy branch holds (argus-config#519, #600).
bash "$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)/scripts/require-deploy-checkout.sh"

RUNTIME_DIR="${HOME}/.argus/t3-peer-mcp"
SRC_DIR="$(cd "$(dirname "$0")" && pwd)"

# Over `ssh host cmd` nothing sources the shell profile, so fnm's node and
# pnpm are not on PATH. Use their stable paths.
export PATH="${HOME}/.local/share/fnm/aliases/default/bin:${HOME}/.local/share/pnpm:${HOME}/.local/bin:${PATH}"

step() { echo; echo "▶ $*"; }
ok()   { echo "  ✓ $*"; }
fail() { echo; echo "✗ $*" >&2; exit 1; }

command -v pnpm  &>/dev/null || fail "pnpm not found"
command -v rsync &>/dev/null || fail "rsync not found"
command -v ssh   &>/dev/null || fail "ssh not found"

step "[1/3] Building"
cd "$SRC_DIR"
pnpm run build
ok "dist/ built"

step "[2/3] Syncing dist/ to ${RUNTIME_DIR}"
mkdir -p "$RUNTIME_DIR"
rsync -a --delete "${SRC_DIR}/dist/" "${RUNTIME_DIR}/dist/"
ok "dist/ synced"

step "[3/3] Installing runtime dependencies"
cat > "${RUNTIME_DIR}/package.json" << 'JSON'
{
  "name": "@argus/t3-peer-mcp-runtime",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.12.0",
    "zod": "^4.4.3"
  }
}
JSON
pnpm install --prefix "${RUNTIME_DIR}" --silent
ok "runtime node_modules installed"

echo
echo "✓ t3-peer-mcp deployed. If it is not registered yet, run argus-config's installer"
echo "  (scripts/install-wsl2.sh or scripts/install-homelab.sh), then start a new T3 thread."
