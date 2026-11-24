#!/usr/bin/env bash
# Deploys the collector on the host it runs on: writes ~/.config/argus/watchtower-collector.env
# (argus-config#1267; the old apps/watchtower-collector/.env is deprecated) from Bitwarden
# Secrets Manager (BWS, see sys-admin#28), then builds and restarts the service
# if this host is the one running it. On any other host it stops after .env.
#
# Secrets pulled from BWS:
#   "watchtower-collector-token"  (personal-machine-secrets project) — auth
#     for POST /watchtower/checks against the argus-watchtower-api Worker,
#     replacing the old direct-Supabase write path (argus#252 cutover).
#   "syncthing-homelab-api-key"   (personal-machine-secrets project)
#   "watchtower-collector-cf-read" (personal-machine-secrets project) — a
#     read-only Cloudflare user token: Account Analytics, D1, Pages and Workers
#     Scripts read on the account, Analytics read on the Argus zone (argus#873).
#   "supabase-mgmt-api-pat"       (personal-machine-secrets project)
#   "watchtower-usage-shim-token-wsl2" (personal-machine-secrets project)
#   "watchtower-github-runners-token" (personal-machine-secrets project) — a
#     fine-grained GitHub PAT with Administration: read on the runners' repos.
#     Optional: while it is missing the runner adapters stay unregistered.
#   "myargus GitHub app: collector PAT" (personal-machine-secrets project) —
#     the fine-grained PAT myargus's github-collector already uses, with
#     Actions: read on every repo. Reused for the main-CI and runner-queue
#     cards (argus#685); while it is missing those adapters stay unregistered.
#   "notice-board-token-homelab" (personal-machine-secrets project) — the
#     board's existing homelab device token, reused read-only for the
#     notice-board queue card (argus#686); while it is missing the card stays
#     unregistered.
#
#   "notice-board-token-watchtower-collector" (personal-machine-secrets project)
#     — the collector's own device token on the ops hub, written as
#     WATCHTOWER_HUB_TOKEN (argus#52). The hub's deploy.sh reads the same secret
#     into its NOTICE_BOARD_TOKENS. Optional: while it is missing the hub is not
#     written and the collector logs that at start.
#
# Non-secret config (project refs, unit lists) is set via the env overrides below or by editing
# the CONFIG block. The private values (tailnet addresses, Cloudflare account, zone and D1 ids)
# are in BWS under ARGUS_TAILSCALE_IP_HOMELAB, ARGUS_TAILSCALE_IP_WSL2, ARGUS_CLOUDFLARE_ACCOUNT_ID,
# ARGUS_CLOUDFLARE_ZONE_ID and ARGUS_WATCHTOWER_D1_DATABASE_ID (argus#1207).
#
# Where the unit is installed, it also refreshes ~/.config/systemd/user/watchtower-collector.service
# from systemd/ when the content differs, and reloads systemd before the restart (argus#53).
#
# Needs BWS_ACCESS_TOKEN set — see ~/.argus/watchtower/.bws-token.
# Run: bash deploy.sh
set -euo pipefail

# A manual deploy ships only what the deploy branch holds (argus-config#519, #600).
bash "$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)/scripts/require-deploy-checkout.sh"

REPO_DIR="$(cd "$(dirname "$0")" && pwd)"
source "${REPO_DIR}/../../scripts/lib/app-env.sh"
ENV_FILE="$(app_env_path watchtower-collector)"
LEGACY_ENV_FILE="${REPO_DIR}/.env"

step()  { echo; echo "▶ $*"; }
ok()    { echo "  ✓ $*"; }
warn()  { echo "  ⚠  $*"; }
fail()  { echo; echo "✗ $*" >&2; exit 1; }
secret_ok() { [[ -n "${!1:-}" ]] && ok "$2" || warn "$2 — EMPTY (BWS secret missing)"; }

step "[1/3] Checking prerequisites"
command -v bws &>/dev/null && ok "bws CLI found" || fail "bws CLI not found"
command -v jq  &>/dev/null && ok "jq found"      || fail "jq not found"

step "[2/3] Bitwarden Secrets Manager token"
BWS_TOKEN_FILE="${HOME}/.bws_token"
[[ -f "$BWS_TOKEN_FILE" ]] && source "$BWS_TOKEN_FILE"
: "${BWS_ACCESS_TOKEN:?BWS_ACCESS_TOKEN not set — see ${BWS_TOKEN_FILE}}"
ok "BWS token loaded"

step "[3/3] Fetching secrets + writing ${ENV_FILE}"
SECRETS_JSON="$(bws secret list --access-token "$BWS_ACCESS_TOKEN" -o json)"
bws_secret() { echo "$SECRETS_JSON" | jq -r --arg k "$1" '.[] | select(.key==$k) | .value' 2>/dev/null || true; }
# Private values (addresses, Cloudflare ids) are not in this repository (argus#1207): each comes
# from the env override named first, else from the BWS secret named second (.env.example).
private_value() {
  local value
  value="$(bws_secret "$2")"
  [[ -n "$value" ]] || fail "BWS secret $2 is missing (or set $1 in the environment)"
  printf '%s' "$value"
}

WATCHTOWER_COLLECTOR_TOKEN=$(bws_secret "watchtower-collector-token")
SYNCTHING_API_KEY=$(bws_secret "syncthing-homelab-api-key")
CLOUDFLARE_API_TOKEN=$(bws_secret "watchtower-collector-cf-read")
SUPABASE_MGMT_TOKEN=$(bws_secret "supabase-mgmt-api-pat")
AI_USAGE_WSL2_TOKEN=$(bws_secret "watchtower-usage-shim-token-wsl2")
GITHUB_RUNNERS_TOKEN=$(bws_secret "watchtower-github-runners-token")
GITHUB_ACTIONS_TOKEN=$(bws_secret "myargus GitHub app: collector PAT")
NOTICE_BOARD_TOKEN=$(bws_secret "notice-board-token-homelab")
WATCHTOWER_HUB_TOKEN=$(bws_secret "notice-board-token-watchtower-collector")

secret_ok WATCHTOWER_COLLECTOR_TOKEN "watchtower-collector-token"
secret_ok SYNCTHING_API_KEY          "syncthing-homelab-api-key"
secret_ok CLOUDFLARE_API_TOKEN       "watchtower-collector-cf-read"
secret_ok SUPABASE_MGMT_TOKEN        "supabase-mgmt-api-pat"
secret_ok AI_USAGE_WSL2_TOKEN        "watchtower-usage-shim-token-wsl2"
[[ -n "$GITHUB_RUNNERS_TOKEN" ]] && ok "watchtower-github-runners-token" || ok "watchtower-github-runners-token — not set, runner adapters stay inert"
secret_ok GITHUB_ACTIONS_TOKEN       "myargus GitHub app: collector PAT"
secret_ok NOTICE_BOARD_TOKEN         "notice-board-token-homelab"
[[ -n "$WATCHTOWER_HUB_TOKEN" ]] && ok "notice-board-token-watchtower-collector" || warn "notice-board-token-watchtower-collector — missing in BWS; the ops hub is not written until it exists"

# ── non-secret config — override via env if these change ────────────────────
# User units bare, system units as system:<unit>. A timer reports its last
# trigger and how the run it triggered ended (argus#682).
SYSTEMD_UNITS="${SYSTEMD_UNITS:-agent-engine.service,ops-hub.service,watchtower-collector.service,budget-api.service,t3code.service,taskview-web.service,taskview-api.service,taskview-migrate.service,budget-api-cron.timer,argus-context-fetch-install.timer,session-tasks.timer,inbox-ingest.timer,repo-git-sync.timer,vault-git-sync.timer,runner-watchdog.timer,system:cloudflared.service,system:tailscaled.service,system:postgresql@16-main.service,system:borgmatic.timer,paperless-webserver.service,paperless-consumer.service,paperless-task-queue.service,paperless-scheduler.service,system:valkey-server.service}"
# Self-hosted Actions runners on homelab, as repo/runner (owner deanjstone).
GITHUB_RUNNERS="${GITHUB_RUNNERS:-argus/homelab,argus/homelab-2,argus-config/homelab-argus-config,atto1/homelab-atto1,budget/homelab-budget,context/homelab-context,homelab/homelab-homelab,myargus/homelab-myargus,pkm-vault/homelab-pkm-vault,pocketfm_downloader/homelab-pocketfm_downloader,scriptable-private/homelab-scriptable-private,slate-reader/homelab-slate-reader,sys-admin/homelab-sys-admin}"
# Repos whose main CI gets a card: the backlog repos, as argus-config's
# backlog-labels.py lists them when it can run here, else this snapshot of
# its 2026-10-16 output.
CI_REPOS_SNAPSHOT="argus,argus-config,argusde,atto1,budget,context,frontend,homelab,ledger-spa,myargus,obsidian-book-reader,obsidian-cadence,oracle-arm-setup,pallas-codex,pkm-vault,pocketfm_downloader,scriptable-private,slate-reader,supa-solid-user,sys-admin,wedding-new-name"
if [[ -z "${CI_REPOS:-}" ]] && LISTED_REPOS="$(python3 "${HOME}/repos/argus-config/hooks/backlog-labels.py" repos 2>/dev/null)" && [[ -n "$LISTED_REPOS" ]]; then
  CI_REPOS="$(paste -sd, - <<<"$LISTED_REPOS")"
fi
CI_REPOS="${CI_REPOS:-$CI_REPOS_SNAPSHOT}"
# Backlog repos with no Actions workflows: a card for them is always a green
# "no runs", so they are dropped from CI_REPOS whichever source it came from.
CI_REPOS_NO_CI="${CI_REPOS_NO_CI-ledger-spa,obsidian-book-reader,oracle-arm-setup,pallas-codex,supa-solid-user,wedding-new-name}"
KEPT_REPOS=()
for repo in ${CI_REPOS//,/ }; do
  [[ ",${CI_REPOS_NO_CI}," == *",${repo##*/},"* ]] || KEPT_REPOS+=("$repo")
done
CI_REPOS="$(IFS=,; echo "${KEPT_REPOS[*]}")"
# Tailnet devices with a last-seen card, as name[@offline-after][~companion]
# (see adapters/tailscale.ts). Laptops get 12h for a night asleep, the phone
# a week; WSL2 is also flagged 10 min after dropping off while Windows is up.
TAILSCALE_DEVICES="${TAILSCALE_DEVICES-homelab,LNV-LGN5@12h,lnv-lgn5-wsl@12h~LNV-LGN5,DJ15@7d}"
# homelab's GUI binds only to its tailnet IP, over TLS with a self-signed cert
# naming the device — so the cert is pinned and the device name supplied.
SYNCTHING_URL="${SYNCTHING_URL:-https://$(private_value SYNCTHING_URL ARGUS_TAILSCALE_IP_HOMELAB):8384}"
SYNCTHING_CA_FILE="${SYNCTHING_CA_FILE:-${HOME}/.config/syncthing/https-cert.pem}"
SYNCTHING_TLS_SERVERNAME="${SYNCTHING_TLS_SERVERNAME:-dell-server}"
CLOUDFLARE_ACCOUNT_ID="${CLOUDFLARE_ACCOUNT_ID:-$(private_value CLOUDFLARE_ACCOUNT_ID ARGUS_CLOUDFLARE_ACCOUNT_ID)}"
CLOUDFLARE_PAGES_PROJECTS="${CLOUDFLARE_PAGES_PROJECTS:-myargus,knowledge,stockade}"
CLOUDFLARE_WORKER_PROJECTS="${CLOUDFLARE_WORKER_PROJECTS:-reader-api,argus-memory-mcp,argus-agent-email,argus-agent-email-mcp,argus-email,argus-vault-agent-relay,argus-watchtower-api}"
# The Argus zone, for the Worker traffic cards' HTTP status counts (needs Zone >
# Analytics: Read on the token; without it the cards report exceptions only).
CLOUDFLARE_ZONE_ID="${CLOUDFLARE_ZONE_ID:-$(private_value CLOUDFLARE_ZONE_ID ARGUS_CLOUDFLARE_ZONE_ID)}"
# D1 databases as name:id, for the capacity cards.
D1_DATABASES="${D1_DATABASES:-argus-watchtower:$(private_value D1_DATABASES ARGUS_WATCHTOWER_D1_DATABASE_ID)}"
SUPABASE_PROJECT_REFS="${SUPABASE_PROJECT_REFS:-iyqhnvandyalaujyqbtj,centbxttgyenxtkknepx}"
AI_USAGE_WSL2_URL="${AI_USAGE_WSL2_URL:-http://$(private_value AI_USAGE_WSL2_URL ARGUS_TAILSCALE_IP_WSL2):8765/usage}"
# The same shim's host report, for the lnv-lgn5 cards. Set it empty to turn
# them off.
HOST_REPORT_WSL2_URL="${HOST_REPORT_WSL2_URL-http://$(private_value HOST_REPORT_WSL2_URL ARGUS_TAILSCALE_IP_WSL2):8765/host}"
HOST_REPORT_WSL2_UNITS="${HOST_REPORT_WSL2_UNITS:-agent-engine.service,memory-reconcile.timer}"
# Vaults with a vault-sync card, by the session-start vault-staleness.sh: on
# homelab as directories, from the WSL2 shim's report by name (argus#686).
VAULT_DIRS="${VAULT_DIRS-${HOME}/CONTEXT,${HOME}/CORTEX}"
HOST_REPORT_WSL2_VAULTS="${HOST_REPORT_WSL2_VAULTS:-CONTEXT,CORTEX}"
# The notice board on this host, on loopback (served by deanjstone-hl/ops-hub).
NOTICE_BOARD_URL="${NOTICE_BOARD_URL:-http://127.0.0.1:3790}"
# service_checks writes now go through the argus-watchtower-api Worker
# (argus#252 cutover), not Supabase directly — see worker-client.ts.
# The origin comes from the links registry (links.json); the environment may replace only it.
WORKER_API_BASE="$(bash "${REPO_DIR}/../../scripts/links.sh" api watchtower-api)" || fail "links.sh could not build the watchtower API base from links.json"
WATCHTOWER_WORKER_URL="${WATCHTOWER_WORKER_URL:-${WORKER_API_BASE%%/watchtower*}}"
# The ops hub gets every check too (argus#1200), once WATCHTOWER_HUB_TOKEN is
# in the env file: deploy.sh writes it from the BWS secret
# notice-board-token-watchtower-collector (argus#52; the secret is an owner
# step, argus#1202). The hub is the collector's store: WATCHTOWER_D1 is written
# off on every deploy, so a promotion never resumes the D1 write (argus#66, the argus#44
# cutover). Set WATCHTOWER_D1=on in the deploy shell to write D1 again. WATCHTOWER_HUB
# set to off turns the hub off; unset leaves it on its default.
WATCHTOWER_D1_FLAG="off"
[[ "${WATCHTOWER_D1:-}" == "on" ]] && WATCHTOWER_D1_FLAG="on"
WATCHTOWER_HUB_URL="${WATCHTOWER_HUB_URL:-$NOTICE_BOARD_URL}"
# The USB printer, shared by ipp-usb on homelab. localhost, not an IP: the
# printer answers 400 to an IP-literal host. Set it empty to turn the adapter off.
PRINTER_IPP_URL="${PRINTER_IPP_URL-http://localhost:60000/ipp/print}"
# Its scanner, over eSCL on the same ipp-usb port. Set it empty to turn the
# scanner adapter off.
SCANNER_ESCL_URL="${SCANNER_ESCL_URL-http://localhost:60000/eSCL}"

app_env_ensure_dir
( umask 077; : > "$ENV_FILE" )
chmod 600 "$ENV_FILE"
{
  echo "WATCHTOWER_WORKER_URL=${WATCHTOWER_WORKER_URL}"
  echo "WATCHTOWER_COLLECTOR_TOKEN=${WATCHTOWER_COLLECTOR_TOKEN}"
  echo "WATCHTOWER_HUB_URL=${WATCHTOWER_HUB_URL}"
  [[ -n "$WATCHTOWER_HUB_TOKEN" ]] && echo "WATCHTOWER_HUB_TOKEN=${WATCHTOWER_HUB_TOKEN}"
  echo "WATCHTOWER_D1=${WATCHTOWER_D1_FLAG}"
  [[ -n "${WATCHTOWER_HUB:-}" ]] && echo "WATCHTOWER_HUB=${WATCHTOWER_HUB}"
  echo "SYSTEMD_UNITS=${SYSTEMD_UNITS}"
  echo "SYNCTHING_URL=${SYNCTHING_URL}"
  echo "SYNCTHING_API_KEY=${SYNCTHING_API_KEY}"
  echo "SYNCTHING_CA_FILE=${SYNCTHING_CA_FILE}"
  echo "SYNCTHING_TLS_SERVERNAME=${SYNCTHING_TLS_SERVERNAME}"
  echo "CLOUDFLARE_API_TOKEN=${CLOUDFLARE_API_TOKEN}"
  echo "CLOUDFLARE_ACCOUNT_ID=${CLOUDFLARE_ACCOUNT_ID}"
  echo "CLOUDFLARE_PAGES_PROJECTS=${CLOUDFLARE_PAGES_PROJECTS}"
  echo "CLOUDFLARE_WORKER_PROJECTS=${CLOUDFLARE_WORKER_PROJECTS}"
  echo "CLOUDFLARE_ZONE_ID=${CLOUDFLARE_ZONE_ID}"
  echo "D1_DATABASES=${D1_DATABASES}"
  echo "SUPABASE_MGMT_TOKEN=${SUPABASE_MGMT_TOKEN}"
  echo "SUPABASE_PROJECT_REFS=${SUPABASE_PROJECT_REFS}"
  [[ -n "$AI_USAGE_WSL2_URL" ]] && echo "AI_USAGE_WSL2_URL=${AI_USAGE_WSL2_URL}"
  [[ -n "$AI_USAGE_WSL2_TOKEN" ]] && echo "AI_USAGE_WSL2_TOKEN=${AI_USAGE_WSL2_TOKEN}"
  [[ -n "$HOST_REPORT_WSL2_URL" ]] && echo "HOST_REPORT_WSL2_URL=${HOST_REPORT_WSL2_URL}"
  echo "HOST_REPORT_WSL2_UNITS=${HOST_REPORT_WSL2_UNITS}"
  echo "HOST_REPORT_WSL2_VAULTS=${HOST_REPORT_WSL2_VAULTS}"
  echo "VAULT_DIRS=${VAULT_DIRS}"
  echo "NOTICE_BOARD_URL=${NOTICE_BOARD_URL}"
  [[ -n "$NOTICE_BOARD_TOKEN" ]] && echo "NOTICE_BOARD_TOKEN=${NOTICE_BOARD_TOKEN}"
  echo "GITHUB_RUNNERS=${GITHUB_RUNNERS}"
  [[ -n "$GITHUB_RUNNERS_TOKEN" ]] && echo "GITHUB_RUNNERS_TOKEN=${GITHUB_RUNNERS_TOKEN}"
  [[ -n "$GITHUB_ACTIONS_TOKEN" ]] && echo "GITHUB_ACTIONS_TOKEN=${GITHUB_ACTIONS_TOKEN}"
  echo "CI_REPOS=${CI_REPOS}"
  [[ -n "$TAILSCALE_DEVICES" ]] && echo "TAILSCALE_DEVICES=${TAILSCALE_DEVICES}"
  [[ -n "$PRINTER_IPP_URL" ]] && echo "PRINTER_IPP_URL=${PRINTER_IPP_URL}"
  [[ -n "$SCANNER_ESCL_URL" ]] && echo "SCANNER_ESCL_URL=${SCANNER_ESCL_URL}"
} >> "$ENV_FILE"
ok "${ENV_FILE} written (chmod 600)"
[[ -f "$LEGACY_ENV_FILE" ]] && app_env_warn_legacy watchtower-collector "$LEGACY_ENV_FILE"

# Refreshes the installed unit from systemd/ (argus#53). cmp, not mtime: a cp always bumps the
# mtime. A unit that is a symlink into the checkout already is the repo's file, so it is never
# copied over (a cp would write through the link); systemd only needs the reload. Same shape as
# homelab's copy_user_unit (homelab#490), kept local so argus does not depend on that repo.
# Sets UNIT_CHANGED=1 when the installed copy was replaced.
UNIT_CHANGED=0
refresh_unit() {
  local src="${REPO_DIR}/systemd/$1" dest_dir="${HOME}/.config/systemd/user"
  [[ -f "$src" ]] || fail "$src is missing"
  if [[ -L "${dest_dir}/$1" ]]; then
    ok "$1 is linked into the checkout — not copied"
  elif [[ -f "${dest_dir}/$1" ]] && cmp -s "$src" "${dest_dir}/$1"; then
    ok "$1 unchanged"
  else
    mkdir -p "$dest_dir"
    cp "$src" "${dest_dir}/$1"
    UNIT_CHANGED=1
    ok "$1 copied to ${dest_dir}"
  fi
}

step "Building and restarting (if this host runs the service)"
UNIT="watchtower-collector.service"
if systemctl --user list-unit-files "$UNIT" &>/dev/null && systemctl --user list-unit-files "$UNIT" | grep -q "$UNIT"; then
  refresh_unit "$UNIT"
  # A changed copy, or a linked unit whose file changed under systemd, needs a reload before
  # the restart can use it.
  if (( UNIT_CHANGED )) || [[ "$(systemctl --user show -p NeedDaemonReload --value "$UNIT" 2>/dev/null || true)" == yes ]]; then
    systemctl --user daemon-reload
    ok "systemd reloaded"
  fi
  pnpm install --frozen-lockfile
  pnpm run build
  systemctl --user restart "$UNIT"
  ok "$UNIT rebuilt and restarted"
else
  ok "$UNIT not installed on this host — .env written, nothing to restart"
fi
