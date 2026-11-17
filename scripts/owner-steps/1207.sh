#!/usr/bin/env bash
# Owner step for argus#1207 (map homelab#478): cut argus over to a fresh-history PUBLIC
# repository. Read docs/public-cutover.md first. Modelled on deanjstone/sys-admin
# scripts/owner-steps/194.sh (sys-admin#194, run live on 16 Nov 2026) and deanjstone/skills
# scripts/owner-steps/27.sh (skills#27).
#
# Run on WSL2, from an approval thread or a terminal, as ONE approved command, from a checkout
# of main at the merged commit (clean, equal to origin/main), in a quiet window: no promotion in
# flight, the orchestrator loops frozen (map homelab#478, task 4):
#   bash scripts/owner-steps/1207.sh --dry-run    # read state, print every action, change nothing
#   bash scripts/owner-steps/1207.sh
#
# What it does, in this order. Each step checks the state first, so a run that stopped can be
# run again (idempotent):
#   1. Renames deanjstone/argus to argus-archive. It stays PRIVATE. GitHub redirects the old name
#      only until a repository is created under it again, which step 3 does on purpose. The
#      runners registered on the repository (two JIT homelab runners the dispatcher minted and
#      the WSL2 deploy runner) are part of the renamed repository: see the wiring it prints.
#   2. Writes the five private values the repository used to carry in its text (the homelab and
#      WSL2 tailnet addresses, the Cloudflare account and zone ids, the watchtower D1 database
#      id) into Bitwarden Secrets Manager (BWS), under the key names in
#      apps/watchtower-collector/.env.example, from the last commit of the old history that
#      still held them (CUTOVER_PRE_SCRUB_REF), into the project of the existing
#      `watchtower-collector-token` secret. An existing secret is left as it is.
#   3. Creates deanjstone/argus as a PRIVATE repository from ONE squashed commit of the scrubbed
#      tree at main (scripts/scrub-scan.sh must pass on it) and pushes main. It is private first
#      because GitHub cannot transfer an issue from a private repository to a public one
#      (skills#27 found this; the GitHub docs on visibility do not mention it).
#   4. Clones the labels (a transferred issue keeps a label only if the target has it), sets the
#      Actions secrets the workflows read from BWS (the mapping is CUTOVER_ACTIONS_SECRETS below;
#      `gh` never returns a secret's value, so each one's value must already be in BWS) and
#      copies the Actions variables whose value passes the scrub scan. CI_RUNS_ON is not
#      recreated: no workflow reads it and a guard test forbids it.
#   5. Transfers the open issues from argus-archive (gh issue transfer), oldest first, except
#      those named in CUTOVER_KEEP_ISSUES (default "1207": the cutover's own ticket, which the
#      orchestrator closes).
#   6. Scans the transferred issues' text with the scrub rules. Any hit stops the run BEFORE the
#      repository goes public (exit 3): edit those issues, then run this script again.
#   7. Makes deanjstone/argus public and sets the fork pull-request approval policy to
#      all_external_contributors.
#   8. Prints the wiring to re-point: the hub, the three kinds of runner, the deploy copies that
#      run live units on both hosts, the other repositories that pin an argus action by SHA, the
#      first-promotion burst and the known first-push red (argus-config#1440).
# It never pushes `deploy`, never runs promote.sh and never starts a workflow: the first
# promotion creates `deploy` in the new repository.
#
# Secrets: read inside this script from BWS, never printed, logged or put in a gh argument
# (`gh secret set` reads its value from stdin). `bws` 2.1.0 has no stdin form for a value, so
# a value being stored is in that one `bws` process's arguments for a moment, visible only to
# this user on this host. It prints only names, ids and counts.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
OWNER="${CUTOVER_OWNER:-deanjstone}"
REPO="argus"
ARCHIVE="argus-archive"
SOURCE_REF="${CUTOVER_SOURCE_REF:-origin/main}"
# The last commit of the old history that still carries the private values (the parent of the scrub).
PRE_SCRUB_REF="${CUTOVER_PRE_SCRUB_REF:-688d5f049a4dcbd24f72b2bc5738700a99b695cb}"
BWS_TOKEN_FILE="${CUTOVER_BWS_TOKEN_FILE:-$HOME/.bws_token}"
KEEP_ISSUES="${CUTOVER_KEEP_ISSUES:-1207}"
REMOTE_BASE="${CUTOVER_GIT_REMOTE_BASE:-https://github.com}"
HUB_REPO="${CUTOVER_HUB_REPO:-ops-hub}"
HUB_LIST_PATH="apps/ops-hub/promotion-repos.txt"
# "NAME=bws-key" pairs: an Actions secret the workflows read, and the BWS secret holding its value.
# The first two are seeded in step 2 from the old history; the owner stores the others in BWS
# before the live run (a dry run lists the missing ones).
DEFAULT_ACTIONS_SECRETS="CLOUDFLARE_ACCOUNT_ID=ARGUS_CLOUDFLARE_ACCOUNT_ID WATCHTOWER_D1_DATABASE_ID=ARGUS_D1_WATCHTOWER_DATABASE_ID CLOUDFLARE_API_TOKEN=ARGUS_CLOUDFLARE_API_TOKEN CLOUDFLARE_D1_TOKEN=ARGUS_CLOUDFLARE_D1_TOKEN VITE_SUPABASE_URL=ARGUS_VITE_SUPABASE_URL VITE_SUPABASE_ANON_KEY=ARGUS_VITE_SUPABASE_ANON_KEY SKILLS_READ_TOKEN=ARGUS_SKILLS_READ_TOKEN"
ACTIONS_SECRETS="${CUTOVER_ACTIONS_SECRETS:-$DEFAULT_ACTIONS_SECRETS}"
# Secrets a workflow reads that may stay unset: ecosystem-skills.yml skips without SKILLS_READ_TOKEN.
OPTIONAL_ACTIONS_SECRETS="SKILLS_READ_TOKEN"
# Variables not recreated: nothing reads CI_RUNS_ON any more.
DROPPED_VARIABLES="CI_RUNS_ON"

ANCHOR_KEY="watchtower-collector-token"
VALUE_KEYS=(
  ARGUS_TAILSCALE_IP_HOMELAB ARGUS_TAILSCALE_IP_WSL2
  ARGUS_CLOUDFLARE_ACCOUNT_ID ARGUS_CLOUDFLARE_ZONE_ID ARGUS_D1_WATCHTOWER_DATABASE_ID
)
IP_RE='100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\.[0-9]{1,3}\.[0-9]{1,3}'
HEX32_RE='[0-9a-f]{32}'
UUID_RE='[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'

DRY_RUN=0
case "${1:-}" in
  "") ;;
  --dry-run) DRY_RUN=1 ;;
  *) echo "usage: $0 [--dry-run]" >&2; exit 2 ;;
esac
[ "$#" -le 1 ] || { echo "usage: $0 [--dry-run]" >&2; exit 2; }

die() { printf 'error: %s\n' "$*" >&2; exit 1; }
want() { if [ "$DRY_RUN" -eq 1 ]; then echo "[dry-run] $*"; else echo "plan: $*"; fi; }
did() { echo "+ $*"; }

secrets="" project_id=""
export_dir=""
cleanup() { [ -z "$export_dir" ] || rm -rf "$export_dir"; }
trap cleanup EXIT

secret_id() { jq -r --arg k "$1" '[.[] | select(.key == $k)][0].id // empty' <<< "$secrets"; }
secret_value() { jq -r --arg k "$1" '[.[] | select(.key == $k)][0].value // empty' <<< "$secrets"; }
secret_set() { [ -n "$(secret_id "$1")" ]; }

repo_json() { gh api "repos/$OWNER/$1" 2> /dev/null || true; }
repo_full_name() { jq -r '.full_name // empty' <<< "$(repo_json "$1")" | tr '[:upper:]' '[:lower:]'; }
repo_is_private() { [ "$(jq -r '.private // empty' <<< "$(repo_json "$1")")" = "true" ]; }
new_repo_exists() { [ "$(repo_full_name "$REPO")" = "$OWNER/$REPO" ]; }
archive_exists() { [ "$(repo_full_name "$ARCHIVE")" = "$OWNER/$ARCHIVE" ]; }

# ---- pre-flight: read-only, also under --dry-run -------------------------------------------

preflight_failed=0
preflight_need() {
  local description="$1"; shift
  if "$@" > /dev/null 2>&1; then
    echo "pre-flight ok: $description"
  else
    echo "pre-flight FAILED: $description" >&2
    preflight_failed=1
  fi
}

# owner_need: a prerequisite only the owner can supply. A dry run lists it and carries on, so the
# plan still prints; a real run stops.
owner_missing=0
owner_notes=()
owner_need() {
  local description="$1" note="$2"; shift 2
  if "$@" > /dev/null 2>&1; then
    echo "pre-flight ok: $description"
  elif [ "$DRY_RUN" -eq 1 ]; then
    echo "pre-flight MISSING (owner step before the real run): $description"
    owner_missing=1
    owner_notes+=("$note")
  else
    echo "pre-flight FAILED: $description" >&2
    preflight_failed=1
  fi
}

have_tools() {
  local tool
  for tool in gh git jq bws gitleaks tar; do command -v "$tool" > /dev/null || return 1; done
}
gh_authenticated() { gh auth status; }
source_is_clean_and_current() {
  [ -z "$(git -C "$ROOT" status --porcelain)" ] || return 1
  git -C "$ROOT" rev-parse --verify --quiet "$SOURCE_REF^{commit}" > /dev/null || return 1
  [ "$(git -C "$ROOT" rev-parse HEAD)" = "$(git -C "$ROOT" rev-parse "$SOURCE_REF")" ]
}
pre_scrub_ref_is_old_history() {
  git -C "$ROOT" rev-parse --verify --quiet "$PRE_SCRUB_REF^{commit}" > /dev/null || return 1
  git -C "$ROOT" merge-base --is-ancestor "$PRE_SCRUB_REF" "$SOURCE_REF"
}
repo_state_is_known() {
  # Fresh: argus is the old private repo. Renamed or resumed: argus-archive exists and is private.
  if archive_exists; then repo_is_private "$ARCHIVE"; else [ "$(repo_full_name "$REPO")" = "$OWNER/$REPO" ] && repo_is_private "$REPO"; fi
}
export_tree() {
  export_dir="$(mktemp -d)"
  git -C "$ROOT" archive "$SOURCE_REF" | tar -x -C "$export_dir"
}
tree_is_scrubbed() { bash "$ROOT/scripts/scrub-scan.sh" "$export_dir"; }
load_secrets() {
  set -a
  # shellcheck source=/dev/null
  . "$BWS_TOKEN_FILE"
  set +a
  secrets=$(bws secret list -o json) || return 1
  jq -e 'type == "array"' <<< "$secrets"
}
resolve_project() {
  project_id=$(jq -r --arg k "$ANCHOR_KEY" '[.[] | select(.key == $k)][0].projectId // empty' <<< "$secrets")
  [ -n "$project_id" ]
}

# pre_file <path>: a file as the old history had it. Empty, with a failure status, when it did not.
pre_file() { git -C "$ROOT" show "$PRE_SCRUB_REF:$1" 2> /dev/null; }

# first_match <ere> <text> [<line filter ere>]: the first match of <ere> on the lines matching the
# filter. Never prints a line, only the match.
first_match() {
  local lines="$2"
  [ -z "${3:-}" ] || lines=$(grep -E "$3" <<< "$2" || true)
  grep -m1 -oE "$1" <<< "$lines" || true
}

# pre_value <key>: the value the old history held for a key, from the one file and the one line
# that carried it. Prints the value (the caller keeps it off the screen) or nothing.
pre_value() {
  local collector wrangler
  collector=$(pre_file apps/watchtower-collector/deploy.sh) || true
  case "$1" in
    ARGUS_CLOUDFLARE_ACCOUNT_ID) first_match "$HEX32_RE" "$collector" '^CLOUDFLARE_ACCOUNT_ID=' ;;
    ARGUS_CLOUDFLARE_ZONE_ID) first_match "$HEX32_RE" "$collector" '^CLOUDFLARE_ZONE_ID=' ;;
    ARGUS_TAILSCALE_IP_HOMELAB) first_match "$IP_RE" "$collector" '^SYNCTHING_URL=' ;;
    ARGUS_TAILSCALE_IP_WSL2) first_match "$IP_RE" "$collector" '^AI_USAGE_WSL2_URL=' ;;
    ARGUS_D1_WATCHTOWER_DATABASE_ID)
      wrangler=$(pre_file apps/watchtower/wrangler.jsonc) || true
      first_match "$UUID_RE" "$wrangler" '"database_id"' ;;
  esac
}
seeds_are_derivable() {
  local key missing=0
  for key in "${VALUE_KEYS[@]}"; do
    secret_set "$key" && continue
    [ -n "$(pre_value "$key")" ] || missing=1
  done
  [ "$missing" -eq 0 ]
}
is_seed_key() { local key; for key in "${VALUE_KEYS[@]}"; do [ "$key" = "$1" ] && return 0; done; return 1; }

# secret_source <Actions secret name>: the BWS key mapped to it, or nothing.
secret_source() {
  local pair
  for pair in $ACTIONS_SECRETS; do
    [ "${pair%%=*}" = "$1" ] && { echo "${pair#*=}"; return 0; }
  done
  return 0
}
is_optional_secret() { [[ " $OPTIONAL_ACTIONS_SECRETS " == *" $1 "* ]]; }
# A source exists when its BWS key is set, or step 2 will seed it from the old history.
secret_has_source() {
  local key
  key=$(secret_source "$1")
  [ -n "$key" ] || return 1
  secret_set "$key" || { is_seed_key "$key" && seeds_are_derivable; }
}
# workflow_secret_names: the Actions secrets the workflows at SOURCE_REF read (never GITHUB_TOKEN).
workflow_secret_names() {
  grep -rhoE 'secrets\.[A-Za-z0-9_]+' "$export_dir/.github/workflows" 2> /dev/null | sed 's/^secrets\.//' | grep -vx 'GITHUB_TOKEN' | sort -u || true
}

# scan_text: the number of scrub-rule findings in the text on stdin. Never printed.
scan_text() {
  local report
  report=$(gitleaks stdin --config "$ROOT/.gitleaks.toml" --redact=100 --no-banner --log-level error \
    --report-format json --report-path /dev/stdout --exit-code 0) || return 1
  jq 'length' <<< "$report"
}
# scan_issue <repo> <number>: the findings in the issue's title, body and comments.
scan_issue() {
  local json text
  json=$(gh issue view "$2" -R "$OWNER/$1" --json title,body,comments) || return 1
  text=$(jq -r '[.title, .body, (.comments[]? | .body)] | join("\n\n")' <<< "$json") || return 1
  scan_text <<< "$text"
}
open_issues() { gh issue list -R "$OWNER/$1" --state open --limit 500 --json number | jq -r 'sort_by(.number) | .[].number'; }
is_kept() { [[ " $KEEP_ISSUES " == *" $1 "* ]]; }
is_dropped_variable() { [[ " $DROPPED_VARIABLES " == *" $1 "* ]]; }

# variable_is_clean <repo> <name>: the variable's value passes the scrub scan.
variable_is_clean() {
  local value count
  value=$(gh variable get "$2" -R "$OWNER/$1") || return 1
  count=$(scan_text <<< "$value") || return 1
  [ "$count" -eq 0 ]
}

# The hub's list of repos with a promotion card (ops-hub apps/ops-hub/promotion-repos.txt, which
# is OPS_HUB_PROMOTION_REPOS), read from its main. The repository name does not change, so the
# entry stays valid for the new repository.
hub_lists_repo() {
  local list
  list=$(gh api "repos/$OWNER/$HUB_REPO/contents/$HUB_LIST_PATH" -H "Accept: application/vnd.github.raw") || return 1
  grep -qx "$OWNER/$REPO" <<< "$(sed -E 's/#.*//; s/[[:space:]]+$//' <<< "$list")"
}

# external_users: local checkouts whose workflows name an argus action or workflow by SHA, as
# "repo: count". Read from each checkout's HEAD; the SHA is of the old history, so it will not
# resolve in the new repository.
external_users() {
  local dir name count
  for dir in "$HOME"/repos/*/; do
    name=$(basename "$dir")
    [ "$name" != "$REPO" ] || continue
    git -C "$dir" rev-parse --git-dir > /dev/null 2>&1 || continue
    count=$(git -C "$dir" grep -h -c -E "uses:[[:space:]]*$OWNER/$REPO/" HEAD -- .github 2> /dev/null | awk -F: '{s += $NF} END {print s + 0}') || count=0
    [ "$count" -eq 0 ] || echo "  $name: $count use(s) of $OWNER/$REPO/... in .github"
  done
}

echo "argus#1207 cutover: $OWNER/$REPO -> $OWNER/$ARCHIVE (private) and a new public $OWNER/$REPO"
preflight_need "gh, git, jq, bws, gitleaks and tar are installed" have_tools
preflight_need "gh is signed in" gh_authenticated
preflight_need "this checkout is clean and is exactly $SOURCE_REF" source_is_clean_and_current
if [ "$preflight_failed" -eq 0 ]; then
  preflight_need "the old history's last unscrubbed commit is in this checkout's history ($PRE_SCRUB_REF)" pre_scrub_ref_is_old_history
  preflight_need "the repository state is known (the old private $REPO, or the private $ARCHIVE already renamed)" repo_state_is_known
  preflight_need "the tree at $SOURCE_REF exports" export_tree
fi
if [ "$preflight_failed" -eq 0 ]; then
  preflight_need "the scrubbed tree passes the scrub scan" tree_is_scrubbed
  preflight_need "$BWS_TOKEN_FILE exists (Secrets Manager access)" test -f "$BWS_TOKEN_FILE"
fi
if [ "$preflight_failed" -eq 0 ]; then
  preflight_need "Secrets Manager answers (bws secret list)" load_secrets
fi
if [ "$preflight_failed" -eq 0 ]; then
  preflight_need "Secrets Manager holds $ANCHOR_KEY (its project receives the new keys)" resolve_project
fi
if [ "$preflight_failed" -eq 0 ]; then
  preflight_need "every missing private value is in the old history" seeds_are_derivable
fi
[ "$preflight_failed" -eq 0 ] || { echo "stopping: nothing was changed" >&2; exit 1; }

# ---- the state, and the plan ---------------------------------------------------------------

have_archive=0; have_new=0
archive_exists && have_archive=1
if [ "$have_archive" -eq 1 ] && new_repo_exists; then have_new=1; fi
src_repo="$REPO"; [ "$have_archive" -eq 1 ] && src_repo="$ARCHIVE"

names_of() { jq -r '[.[].name] | join(", ")' <<< "$1"; }
secret_names=$(gh secret list -R "$OWNER/$src_repo" --json name) || die "could not list the Actions secrets"
variable_names=$(gh variable list -R "$OWNER/$src_repo" --json name) || die "could not list the Actions variables"
hooks=$(gh api "repos/$OWNER/$src_repo/hooks") || die "could not list the webhooks"
runners=$(gh api "repos/$OWNER/$src_repo/actions/runners") || die "could not list the runners"
deploy_keys=$(gh api "repos/$OWNER/$src_repo/keys") || die "could not list the deploy keys"
read_secrets=$(workflow_secret_names)

# Every secret a workflow reads needs a BWS source, whether or not the old repository holds it.
while read -r name; do
  [ -n "$name" ] || continue
  if is_optional_secret "$name"; then
    echo "pre-flight ok: Actions secret $name is optional ($(secret_source "$name"), set only if present in Secrets Manager)"
    continue
  fi
  owner_need "Actions secret $name has a Secrets Manager source" \
    "Actions secret $name (read by a workflow): GitHub never returns its value from $src_repo. Store it in Secrets Manager as $(secret_source "$name"), then run again; or run with CUTOVER_ACTIONS_SECRETS=\"$name=<bws key> ...\"" \
    secret_has_source "$name"
done <<< "$read_secrets"
[ "$preflight_failed" -eq 0 ] || { echo "stopping: nothing was changed" >&2; exit 1; }

echo
echo "State: old repository is $OWNER/$src_repo (private); new $OWNER/$REPO exists: $([ "$have_new" -eq 1 ] && echo yes || echo no)"
echo "Open issues in $src_repo, not transferred (CUTOVER_KEEP_ISSUES): skip $KEEP_ISSUES"
echo "Actions secrets on $src_repo (names): $(names_of "$secret_names")"
echo "Actions secrets the workflows read (names): $(tr '\n' ' ' <<< "$read_secrets")"
echo "Actions variables on $src_repo (names): $(names_of "$variable_names")"
echo "Webhooks on $src_repo: $(jq 'length' <<< "$hooks"); deploy keys: $(jq 'length' <<< "$deploy_keys"); repo-level runners: $(jq '.runners | length' <<< "$runners")"
if [ "$(jq 'length' <<< "$hooks")" -gt 0 ]; then
  echo "  webhooks (id, events, active; the URL and secret stay in $ARCHIVE): $(jq -r '[.[] | "\(.id) \(.events | join("+")) active=\(.active)"] | join("; ")' <<< "$hooks")"
fi
if [ "$(jq '.runners | length' <<< "$runners")" -gt 0 ]; then
  echo "  runners (name, status, labels; they stay registered to the renamed $ARCHIVE): $(jq -r '[.runners[] | "\(.name) \(.status) [\([.labels[].name] | join(","))]"] | join("; ")' <<< "$runners")"
fi
echo

if [ "$have_archive" -eq 1 ]; then echo "rename: already done ($ARCHIVE exists)"
else want "rename $OWNER/$REPO to $ARCHIVE (stays private; GitHub redirects the old name until step 3 reuses it)"; fi
for key in "${VALUE_KEYS[@]}"; do
  if secret_set "$key"; then echo "Secrets Manager $key: already set, left as is"
  else want "Secrets Manager $key: create (value from the old history at $PRE_SCRUB_REF, in the project of $ANCHOR_KEY; never printed)"; fi
done
if [ "$have_new" -eq 1 ]; then echo "create: $OWNER/$REPO already exists"
else want "create $OWNER/$REPO as a PRIVATE repository, then push ONE squashed commit of the scrubbed tree at $SOURCE_REF to main (never deploy)"; fi
want "labels: gh label clone $OWNER/$ARCHIVE into $OWNER/$REPO (a transferred issue keeps a label only if the target has it)"
while read -r name; do
  [ -n "$name" ] || continue
  key=$(secret_source "$name")
  if is_optional_secret "$name" && ! secret_set "${key:-none}"; then
    want "Actions secret $name on $OWNER/$REPO: skipped (optional, and Secrets Manager has no ${key:-source})"
  else
    want "Actions secret $name on $OWNER/$REPO: set from Secrets Manager ($key)"
  fi
done <<< "$read_secrets"
while read -r name; do
  [ -n "$name" ] || continue
  grep -qx "$name" <<< "$read_secrets" || want "Actions secret $name: NOT recreated (no workflow reads it; its value stays in $ARCHIVE)"
done < <(jq -r '.[].name' <<< "$secret_names")
while read -r name; do
  [ -n "$name" ] || continue
  if is_dropped_variable "$name"; then
    want "Actions variable $name: NOT recreated (no workflow reads it; a guard test forbids it)"
  else
    owner_need "Actions variable $name holds no private value" \
      "Actions variable $name on $src_repo holds a value the scrub rules flag: move it to Secrets Manager and drop the variable, or edit its value" \
      variable_is_clean "$src_repo" "$name"
    want "Actions variable $name on $OWNER/$REPO: copy (the value passes the scrub scan)"
  fi
done < <(jq -r '.[].name' <<< "$variable_names")
[ "$preflight_failed" -eq 0 ] || { echo "stopping: nothing was changed" >&2; exit 1; }
want "transfer the open issues of $ARCHIVE to $OWNER/$REPO (gh issue transfer, oldest first; GitHub allows it only while both are private), skip $KEEP_ISSUES"

echo
echo "Issue text carrying a private value (rule findings, values redacted):"
dirty=0
while read -r number; do
  [ -n "$number" ] || continue
  is_kept "$number" && continue
  count=$(scan_issue "$src_repo" "$number") || die "could not scan issue $number"
  if [ "$count" -gt 0 ]; then echo "  issue $number: $count finding(s)"; dirty=1; fi
done < <(open_issues "$src_repo")
[ "$dirty" -eq 1 ] || echo "  none"
[ "$dirty" -eq 0 ] || echo "  A real run stops before step 7 on these (after transferring them, so they can be edited in the new repository)."
want "make $OWNER/$REPO public (gh repo edit --visibility public), only when no transferred issue has a finding"
want "set the fork pull-request approval policy of $OWNER/$REPO to all_external_contributors"

hub_state="MISSING: add $OWNER/$REPO to $HUB_LIST_PATH in $OWNER/$HUB_REPO (a commit plus a promotion of ops-hub)"
if hub_lists_repo; then hub_state="listed: $OWNER/$REPO (the name is unchanged, so the card follows the new repository; nothing to edit)"; fi

print_wiring() {
  cat <<EOF

Wiring to re-point (nothing here is automatic):
  - Hub (OPS_HUB_PROMOTION_REPOS, read from $HUB_LIST_PATH in $OWNER/$HUB_REPO): $hub_state. Each token request names one repo, so check the hub's GitHub App can reach the NEW repository: if its installation is on selected repositories, add $OWNER/$REPO there (the new repository has a new id). Withdraw any promotion flag for a SHA of the old history. The first promotion creates \`deploy\` in the new repository: approve it on the ops-hub promotion card, never push it by hand.
  - Homelab runners (the JIT dispatcher, homelab runbook jit-dispatcher.md): the enrolment names the repo, so \`$OWNER/$REPO\` in ~/.config/homelab-ci/jit-dispatcher.json now means the new repository and needs no edit. The fine-grained token it uses lists repositories by id: select the NEW $REPO on it (Administration: read and write, Actions: read) and check with \`cd ~/repos/homelab/services/jit-dispatcher && node src/main.ts --poll-only\` (a 404 or 403 on $REPO means it is not selected). The runners jit-* it minted belong to $ARCHIVE; they are one-job runners and go with it.
  - WSL2 deploy runner (argus-config docs/runbooks/wsl2-deploy-runner.md): the standing runner LNV-LGN5-wsl2-deploy is registered to the renamed $ARCHIVE, so the WSL2 deploy workflows of the new repository have no runner until it is registered again. On WSL2: remove the registration from $ARCHIVE (the installer or \`config.sh remove\`), then run \`scripts/install-wsl2-deploy-runner.sh --repo $OWNER/$REPO\` from argus-config. That runbook says "any public repo: never" for this label; the workflows here only run on a push to \`deploy\` or a dispatch (scripts/public-safe.test.ts pins it), so a fork cannot start one, but the runbook line needs the owner's decision and an edit in argus-config. Until it is registered the four WSL2 deploys (agent-engine, agent-cli, watchtower-usage-shim, t3-peer-mcp) queue.
  - Deploy copies: DO NOT move ~/repos/argus on either host. Live units run from it (WorkingDirectory=%h/repos/argus/apps/..., for loop-state-mcp and watchtower-collector on homelab and agent-engine, agent-cli, the usage shim and t3-peer-mcp on WSL2), so a mv would break the next restart. Its origin URL is unchanged and now points at the new repository: after the first promotion the deploy workflows run \`git fetch origin deploy && git switch --detach origin/deploy\` in it, which takes the new root history and keeps node_modules, dist and the .env files. Before then, \`git -C ~/repos/argus fetch origin --prune\` is safe; do not run anything else in it. Keep a copy of the old history with: git clone https://github.com/$OWNER/$ARCHIVE.git ~/repos/$ARCHIVE. Worktrees under ~/.t3/worktrees/$REPO belong to the old history: remove them (git worktree remove) once their branches are merged or abandoned.
  - Workflows of other repositories that pin an argus action by SHA (the SHA is of the old history and will not resolve here; the file is unchanged in the new repository, so repoint to the new SHA of .github/actions/host-pnpm):
$(external_users)
  - Issue numbers restart. Transferred issues get new numbers (listed above as archive#N -> $REPO#M); every other old issue and pull request stays in $OWNER/$ARCHIVE. A reference to $OWNER/$REPO#N in another repository, a wayfinder map, a loop-state slot, a notice-board message or an ops-hub store now means the NEW repository's #N: repoint anything that should mean the old history to $OWNER/$ARCHIVE#N (the rewrite rules of argus-config#1064; the store rewrites are task 3 of map homelab#478). Issue relationships (sub-issues, blocked-by) are not carried by a transfer: check the wayfinder maps.
  - The first promotion [speculation, not yet observed: how GitHub evaluates a path filter on a branch's first push]: \`deploy\` is created at the root commit, so every deploy workflow's path filter probably matches and every one fires once (loop-state-mcp, watchtower-collector, t3-peer-mcp on homelab; agent-engine, agent-cli, usage shim, t3-peer-mcp on WSL2; the two watchtower Cloudflare deploys; ecosystem-release). Promote in a quiet window, with the WSL2 runner registered and awake. Release runs too and cuts no version (the root commit is a \`chore\`).
  - Releases and tags stay in $ARCHIVE (one tag per deployable unit, v3.x for the root); the new history has none, so the first feat or fix of an app releases it as 1.0.0. Re-create the tags by hand if the old numbering must continue.
  - Known first-push red: the vendored README guard fails on the new repository's root commit (a root commit has no HEAD^1, exit 128). It is argus-config#1440 ( https://github.com/$OWNER/argus-config/issues/1440 ), not a regression of this cutover and no reason to revert the push. Every later push is judged normally.
  - Webhooks, GitHub App installations and deploy keys on $OWNER/$ARCHIVE are not copied (there are none today); the Actions secrets and variables are recreated by name only as listed above. WATCHTOWER_D1_DATABASE_ID is new: the watchtower Worker deploy needs it (scripts/with-d1-id.sh). BRRR_WEBHOOK_SECRET is dropped.
  - Before the first trunk push to the new repository run \`scripts/trunk-readiness.sh $OWNER/$REPO\` from argus-config. Settings a public repository gains (rulesets, secret scanning, push protection, a read-only default workflow token) are the owner's to enable.
  - Decide whether to archive $OWNER/$ARCHIVE (gh repo archive), which also stops its workflows.
EOF
}

if [ "$DRY_RUN" -eq 1 ]; then
  if [ "$owner_missing" -eq 1 ]; then
    echo
    echo "Owner steps before the real run (a real run stops without them):"
    for note in "${owner_notes[@]}"; do echo "  - $note"; done
  fi
  echo
  echo "[dry-run] verify (a real run): new repository public, archive private, open issues moved, main is one commit, no deploy branch"
  print_wiring | sed 's/^/[dry-run] /'
  echo "[dry-run] done: nothing was changed"
  exit 0
fi

# ---- changes -------------------------------------------------------------------------------

# 1. rename
if [ "$have_archive" -eq 0 ]; then
  gh api -X PATCH "repos/$OWNER/$REPO" -f "name=$ARCHIVE" > /dev/null
  did "renamed $OWNER/$REPO to $ARCHIVE"
  archive_exists || die "$ARCHIVE does not exist after the rename"
  repo_is_private "$ARCHIVE" || die "$ARCHIVE is not private: stop and fix it before anything else"
fi

# 2. Secrets Manager
for key in "${VALUE_KEYS[@]}"; do
  secret_set "$key" && continue
  value=$(pre_value "$key")
  [ -n "$value" ] || die "no value for $key in the old history"
  bws secret create --note "argus private value (argus#1207)" -o none "$key" "$value" "$project_id" || die "could not create $key"
  unset value
  did "created Secrets Manager secret $key"
done
secrets=$(bws secret list -o json) || die "could not re-read Secrets Manager"

# 3. the new repository, private, one squashed commit
description=$(jq -r '.description // empty' <<< "$(repo_json "$src_repo")")
if [ "$have_new" -eq 0 ]; then
  gh repo create "$OWNER/$REPO" --private --description "$description" > /dev/null
  did "created $OWNER/$REPO (private)"
fi
if ! gh api "repos/$OWNER/$REPO/branches/main" > /dev/null 2>&1; then
  src_short=$(git -C "$ROOT" rev-parse --short "$SOURCE_REF")
  git -C "$export_dir" init -q -b main
  git -C "$export_dir" add -A
  git -C "$export_dir" -c "user.name=$(git -C "$ROOT" config user.name)" -c "user.email=$(git -C "$ROOT" config user.email)" \
    commit -q -m "chore: start the public history from $ARCHIVE@$src_short" -m "The earlier history is kept, private, in $OWNER/$ARCHIVE. Refs $OWNER/$ARCHIVE#1207"
  git -C "$export_dir" remote add origin "$REMOTE_BASE/$OWNER/$REPO.git"
  git -C "$export_dir" -c "credential.helper=!gh auth git-credential" push -q origin main
  did "pushed one squashed commit to $OWNER/$REPO main (from $ARCHIVE@$src_short)"
fi

# 4. labels, Actions secrets, Actions variables
gh label clone "$OWNER/$ARCHIVE" -R "$OWNER/$REPO" > /dev/null
did "cloned the labels of $ARCHIVE into $REPO"
while read -r name; do
  [ -n "$name" ] || continue
  key=$(secret_source "$name")
  value=$(secret_value "$key")
  if [ -z "$value" ] && is_optional_secret "$name"; then
    echo "  Actions secret $name skipped (optional, no Secrets Manager secret $key)"
    continue
  fi
  [ -n "$value" ] || die "Secrets Manager has no value for $key"
  gh secret set "$name" -R "$OWNER/$REPO" < <(printf '%s' "$value") || die "could not set the Actions secret $name"
  unset value
  did "set the Actions secret $name on $OWNER/$REPO (from $key)"
done <<< "$read_secrets"
while read -r name; do
  [ -n "$name" ] || continue
  is_dropped_variable "$name" && continue
  gh variable get "$name" -R "$OWNER/$src_repo" | gh variable set "$name" -R "$OWNER/$REPO" || die "could not copy the Actions variable $name"
  did "copied the Actions variable $name to $OWNER/$REPO"
done < <(jq -r '.[].name' <<< "$variable_names")

# 5. issues
echo "Issue transfers (archive -> new):"
while read -r number; do
  [ -n "$number" ] || continue
  if is_kept "$number"; then echo "  archive#$number stays (kept)"; continue; fi
  url=$(gh issue transfer "$number" "$OWNER/$REPO" -R "$OWNER/$ARCHIVE") || die "could not transfer issue $number"
  echo "  archive#$number -> $REPO#${url##*/}"
done < <(open_issues "$ARCHIVE")

# 6. scan every open issue in the new repository, the transferred ones included
dirty=0
while read -r number; do
  [ -n "$number" ] || continue
  count=$(scan_issue "$REPO" "$number") || die "could not scan issue $number"
  if [ "$count" -gt 0 ]; then echo "issue $number: $count finding(s) (values redacted)" >&2; dirty=1; fi
done < <(open_issues "$REPO")
if [ "$dirty" -eq 1 ]; then
  echo "stopping before the repository goes public: edit the issues above in $OWNER/$REPO (https://github.com/$OWNER/$REPO/issues), then run this script again" >&2
  exit 3
fi

# 7. public
if repo_is_private "$REPO"; then
  gh repo edit "$OWNER/$REPO" --visibility public --accept-visibility-change-consequences
  did "made $OWNER/$REPO public"
fi
gh api -X PUT "repos/$OWNER/$REPO/actions/permissions/fork-pr-contributor-approval" -f approval_policy=all_external_contributors > /dev/null
did "set the fork pull-request approval policy to all_external_contributors"

# 8. wiring
print_wiring
