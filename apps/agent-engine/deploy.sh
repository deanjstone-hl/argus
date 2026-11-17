#!/usr/bin/env bash
set -euo pipefail

# A manual deploy ships only what the deploy branch holds (argus-config#519, #600).
bash "$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)/scripts/require-deploy-checkout.sh"

SRC_DIR="$(cd "$(dirname "$0")" && pwd)"
DEST_DIR="${HOME}/.argus/agent-engine"
SERVER_HOST="${ARGUS_SERVER_HOST:-srvr@homelab}"
TARGET="${1:-local}"
SERVICE="agent-engine"
HEALTH_URL="http://localhost:${ARGUS_PORT:-3747}/health"
# The poll budget is ~10 s; tests shrink it.
HEALTH_ATTEMPTS="${ARGUS_HEALTH_ATTEMPTS:-10}"
HEALTH_INTERVAL="${ARGUS_HEALTH_INTERVAL:-1}"

step() { echo; echo "▶ $*"; }
ok()   { echo "  ✓ $*"; }
fail() { echo; echo "✗ $*" >&2; exit 1; }

case "$TARGET" in
  local)
    step "[1/5] Checking prerequisites (local)"
    command -v node &>/dev/null && ok "node found ($(node --version))"   || fail "node not found"
    command -v pnpm &>/dev/null && ok "pnpm found ($(pnpm --version))"  || fail "pnpm not found"

    step "[2/5] Building"
    cd "${SRC_DIR}"
    pnpm run build
    ok "dist/ built"

    step "[3/5] Syncing dist/ → ${DEST_DIR}/dist/"
    mkdir -p "${DEST_DIR}/dist"
    rsync -a --delete --out-format="  → %n" "${SRC_DIR}/dist/" "${DEST_DIR}/dist/"
    ok "dist/ synced"

    cp "${SRC_DIR}/package.json" "${DEST_DIR}/package.json"
    ok "package.json copied"

    step "[4/5] Installing production dependencies in ${DEST_DIR}/"
    cd "${DEST_DIR}"
    # The runtime pnpm-workspace.yaml is rewritten every deploy, never trusted.
    # A hand-edited or older copy can carry a malformed allowBuilds, and then
    # better-sqlite3's native binding is silently never built. onnxruntime-node
    # (the live-notes embedder) ships its CPU binaries in the package; its
    # postinstall only fetches CUDA ones, so it and protobufjs's are declined
    # explicitly, which pnpm needs to install without failing.
    cat > pnpm-workspace.yaml <<'WORKSPACE'
allowBuilds:
  better-sqlite3: true
  esbuild: true
  onnxruntime-node: false
  protobufjs: false
WORKSPACE
    ok "pnpm-workspace.yaml written (allowBuilds: better-sqlite3, esbuild; declined: onnxruntime-node, protobufjs)"
    # The runtime lockfile is only ever a by-product of the last install here —
    # the real one is the workspace lockfile, which is not copied — so it goes
    # stale against the copied package.json and can be outright broken. Drop it
    # and let pnpm resolve afresh.
    rm -f pnpm-lock.yaml
    # CI=true: no TTY prompt (an older node_modules layout otherwise aborts with
    # ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY). --no-frozen-lockfile: CI=true
    # makes pnpm frozen. Output stays visible and set -e fails the deploy on error.
    CI=true pnpm install --prod --no-frozen-lockfile --config.confirmModulesPurge=false
    ok "dependencies installed"

    # Opening an in-memory database loads the native binding, which a bare
    # require('better-sqlite3') does not.
    node -e "new (require('better-sqlite3'))(':memory:').close()" \
      || fail "better-sqlite3 failed to load in ${DEST_DIR} — native binding not built"
    ok "better-sqlite3 loads"

    # `server` mode calls this script for the build and restarts the remote unit
    # itself; restarting this machine's unit as well would be a stray side effect.
    if [[ -n "${ARGUS_DEPLOY_NO_RESTART:-}" ]]; then
      RESULT="Deploy complete — runtime built (restart skipped: server deploy)"
    else
      step "[5/5] Restarting ${SERVICE}"
      # Without a restart the old process keeps serving the old code (#802).
      if command -v systemctl &>/dev/null && systemctl --user cat "${SERVICE}" &>/dev/null; then
        systemctl --user restart "${SERVICE}" || fail "systemctl --user restart ${SERVICE} failed — restart failed, old code may still be serving"
        ok "${SERVICE} restarted"
        healthy=""
        for ((attempt = 1; attempt <= HEALTH_ATTEMPTS; attempt++)); do
          if curl -sf "${HEALTH_URL}" >/dev/null; then healthy=1; break; fi
          sleep "${HEALTH_INTERVAL}"
        done
        [[ -n "${healthy}" ]] || fail "${SERVICE} restarted but did not answer /health at ${HEALTH_URL} after ${HEALTH_ATTEMPTS} attempts — check: journalctl --user -u ${SERVICE} -n 50"
        ok "${HEALTH_URL} answers"
        RESULT="Deploy complete — agent-engine restarted and healthy"
      else
        echo "  ⚠ ${SERVICE} unit not installed — nothing restarted."
        echo "    Install it once with: bash ${SRC_DIR}/systemd/install-agent-engine.sh"
        RESULT="Deploy complete — runtime synced, service NOT restarted"
      fi
    fi

    echo
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "  ${RESULT}"
    echo "  Runtime: ${DEST_DIR}"
    [[ "${RESULT}" == *"NOT restarted"* ]] && echo "  Start: node ${DEST_DIR}/dist/server/http.js"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    ;;

  server)
    REMOTE_DEST="~/.argus/agent-engine"

    step "[1/3] Checking prerequisites (server deploy)"
    command -v ssh  &>/dev/null && ok "ssh found"  || fail "ssh not found"
    command -v rsync &>/dev/null && ok "rsync found" || fail "rsync not found"

    step "[2/3] Building + syncing local runtime → ${SERVER_HOST}:${REMOTE_DEST}/"
    ARGUS_DEPLOY_NO_RESTART=1 "$0" local
    ssh "${SERVER_HOST}" "mkdir -p ${REMOTE_DEST}"
    rsync -az --delete --out-format="  → %n" \
      --exclude='.env' \
      --exclude='pnpm-workspace.yaml' \
      --exclude='*.db' \
      --exclude='*.db-wal' \
      --exclude='*.db-shm' \
      "${DEST_DIR}/" "${SERVER_HOST}:${REMOTE_DEST}/"
    ok "runtime synced"

    step "[3/3] Restarting service"
    ssh "${SERVER_HOST}" 'systemctl --user restart agent-engine'
    ok "agent-engine restarted"

    echo
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "  Server deploy complete — agent-engine on ${SERVER_HOST}"
    echo "  Port 3747 (Tailscale-only)"
    echo "  Set ARGUS_SERVER_HOST to override target (default: srvr@homelab)"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    ;;

  *)
    echo "Usage: $0 [local|server]"
    echo "  local  (default) — rsync dist to ~/.argus/agent-engine, restart the agent-engine user unit if installed"
    echo "  server           — build locally, rsync runtime to ${SERVER_HOST}, systemctl --user restart agent-engine"
    exit 1
    ;;
esac
