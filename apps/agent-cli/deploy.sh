#!/usr/bin/env bash
set -euo pipefail

# A manual deploy ships only what the deploy branch holds (argus-config#519, #600).
bash "$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)/scripts/require-deploy-checkout.sh"

SRC_DIR="$(cd "$(dirname "$0")" && pwd)"
DEST_DIR="${HOME}/.argus/agent-cli"
SHIM="${HOME}/bin/agent"

step() { echo; echo "▶ $*"; }
ok()   { echo "  ✓ $*"; }
fail() { echo; echo "✗ $*" >&2; exit 1; }

step "[1/4] Checking prerequisites"
command -v node &>/dev/null && ok "node found ($(node --version))"   || fail "node not found"
command -v pnpm &>/dev/null && ok "pnpm found ($(pnpm --version))"  || fail "pnpm not found"
[[ -f "${SRC_DIR}/package.json" ]]                                   || fail "package.json missing"

step "[2/4] Building"
cd "${SRC_DIR}"
pnpm run build
ok "dist/ built"

step "[3/5] Syncing dist/ → ${DEST_DIR}/dist/"
mkdir -p "${DEST_DIR}/dist"
rsync -a --delete --out-format="  → %n" "${SRC_DIR}/dist/" "${DEST_DIR}/dist/"
ok "dist/ synced"

step "[4/5] Installing runtime dependencies"
RUNTIME_PKG="${DEST_DIR}/package.json"
if [[ ! -f "${RUNTIME_PKG}" ]]; then
  node -e "
    const fs = require('fs');
    const src = JSON.parse(fs.readFileSync('${SRC_DIR}/package.json', 'utf8'));
    fs.writeFileSync('${RUNTIME_PKG}', JSON.stringify({ name: src.name, version: src.version, private: true, type: src.type, dependencies: src.dependencies }, null, 2) + '\n');
  "
fi
# CI=true keeps pnpm from prompting (no TTY over SSH aborts it); the runtime
# lockfile can be stale against the copied package.json, so don't freeze it.
# Output stays visible and set -e fails the deploy if the install fails.
CI=true pnpm install --dir "${DEST_DIR}" --prod --no-frozen-lockfile --config.confirmModulesPurge=false
ok "dependencies installed"

step "[5/5] Verifying shim"
EXPECTED_TARGET="${DEST_DIR}/dist/index.js"

if [[ ! -f "${SHIM}" ]]; then
  printf '#!/usr/bin/env bash\nexec node %s "$@"\n' "${EXPECTED_TARGET}" > "${SHIM}" && chmod +x "${SHIM}" && ok "Shim created at ${SHIM}"
fi

SHIM_TARGET=$(grep -o '/home/[^"]*dist/index.js' "${SHIM}" 2>/dev/null || true)
if [[ "${SHIM_TARGET}" != "${EXPECTED_TARGET}" ]]; then
  echo "  Updating shim: ${SHIM_TARGET} → ${EXPECTED_TARGET}"
  printf '#!/usr/bin/env bash\nexec node %s "$@"\n' "${EXPECTED_TARGET}" > "${SHIM}"
  chmod +x "${SHIM}"
fi
ok "Shim OK → ${EXPECTED_TARGET}"

VERSION=$(node "${DEST_DIR}/dist/index.js" --version 2>/dev/null || echo "unknown")

echo
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  Deploy complete — @argus/agent-cli ${VERSION}"
echo "  agent → ${DEST_DIR}/dist/index.js"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo
