#!/usr/bin/env bash
# Owner steps for argus#59 (map argus-config#1587, after the atto pilot atto/10): move argus's
# deploy values to the `actions` project of Bitwarden Secrets Manager (BWS), so the two watchtower
# deploy workflows read them through bitwarden/sm-action, then, after a green deploy, delete the
# repository Actions secrets they replaced.
#
# Run on WSL2, from an approval thread or a terminal, as ONE approved command each, from a checkout
# at the merged commit:
#
#   0. Once, before this script (argus-config#1418): the Actions secret BWS_ACCESS_TOKEN, the token
#      of the read-only machine account `actions-read`, set on this repository. Step 1 refuses
#      without it, because a deploy would fail at the sm-action step.
#
#   1. Before the promotion:
#        bash scripts/owner-steps/59.sh --dry-run     # read state, print every action, change nothing
#        bash scripts/owner-steps/59.sh
#
#   2. After the owner's Approve on the promotion has run both watchtower deploys green on the new path:
#        bash scripts/owner-steps/59.sh --delete-actions-secrets --dry-run
#        bash scripts/owner-steps/59.sh --delete-actions-secrets
#
# What step 1 changes, and only when the state is not already as wanted (idempotent). The table ROWS
# below is the whole list; each row is one secret id the workflows map:
#   - Moves the secret, by id, from `personal-machine-secrets` to `actions` and renames it, in one
#     `bws secret edit --key --project-id`. The id and the value stay the same, so the workflows'
#     id map is valid before and after.
#   - For the two values a host deploy also reads by name (the Cloudflare account id and the
#     watchtower D1 database id: apps/watchtower-collector/deploy.sh, apps/watchtower/scripts/with-d1-id.sh),
#     creates the host key in `personal-machine-secrets` with the same value, after the move.
#     The host reads its key by name, so a new id does not matter. "One key in
#     personal-machine-secrets, plus one in actions where CI reads it" (argus-config/1598).
#   - Verifies: each id is now a secret of its new key in `actions`, and each host copy holds the
#     value of its original (compared inside jq, never printed).
# What step 2 changes: deletes the Actions secrets of the repository that the watchtower deploy
# workflows, at the head of their latest successful run on `deploy`, no longer read (the six
# listed in OLD_ACTIONS_SECRETS). It refuses unless each of those runs is green, its workflow uses
# sm-action, and BWS_ACCESS_TOKEN is set. It never deletes BWS_ACCESS_TOKEN.
#
# Not here: SKILLS_READ_TOKEN. It is not set, so there is nothing to move; the ecosystem-skills
# workflow skips without it. The owner issues the token (a fine-grained PAT) and a follow-up maps it.
#
# Secrets: read inside this script, never printed, logged or put in a gh argument. `bws` 2.x has no
# stdin form for a value, so while a host copy is being created its value is in that one `bws`
# process's arguments, visible only to this user on this host (the same trade-off as
# scripts/owner-steps/1207.sh). It prints key names and ids, never a value. It never runs
# promote.sh, never pushes `deploy`, never starts a workflow.
set -euo pipefail

REPO="${ARGUS_REPO:-deanjstone-hl/argus}"
SOURCE_PROJECT="${ARGUS_BWS_SOURCE_PROJECT:-personal-machine-secrets}"
DEST_PROJECT="${ARGUS_BWS_PROJECT:-actions}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# The deploy workflows that read through sm-action; their file names, under .github/workflows.
DEPLOY_WORKFLOWS=(watchtower-deploy.yml watchtower-deploy-worker.yml)
# The files whose `<id> > <ENV_NAME>` lines step 1 checks against ROWS (overridable for tests).
read -r -a WORKFLOW_FILES <<< "${ARGUS_WORKFLOWS:-$ROOT/.github/workflows/${DEPLOY_WORKFLOWS[0]} $ROOT/.github/workflows/${DEPLOY_WORKFLOWS[1]}}"

# id | key it has today | key it has in `actions` | key a host reads from the source project ("-" for none)
ROWS=(
  "daebfc00-1ad4-425e-8c0f-b504014123e0 ARGUS_CLOUDFLARE_API_TOKEN ARGUS_CF_API_TOKEN -"
  "5a91a3c7-4bca-464b-81a5-b50401408e70 ARGUS_CLOUDFLARE_D1_TOKEN ARGUS_CF_D1_TOKEN -"
  "a4257c90-ae72-4f91-9f75-b50401408c32 ARGUS_VITE_SUPABASE_URL ARGUS_SUPABASE_URL -"
  "a25daf63-934e-4bf7-9d4f-b50401408d71 ARGUS_VITE_SUPABASE_ANON_KEY ARGUS_SUPABASE_ANON_KEY -"
  "a7767558-b39c-488f-9a1f-b505006359fe ARGUS_CLOUDFLARE_ACCOUNT_ID ARGUS_CF_ACCOUNT_ID ARGUS_CLOUDFLARE_ACCOUNT_ID"
  "489cf0ba-dad5-4e70-9f3a-b50500635b92 ARGUS_D1_WATCHTOWER_DATABASE_ID ARGUS_WATCHTOWER_D1_DATABASE_ID ARGUS_WATCHTOWER_D1_DATABASE_ID"
)

# Every Actions secret an earlier version of the two workflows read; step 2 considers exactly these.
OLD_ACTIONS_SECRETS=(CLOUDFLARE_ACCOUNT_ID CLOUDFLARE_API_TOKEN CLOUDFLARE_D1_TOKEN VITE_SUPABASE_ANON_KEY VITE_SUPABASE_URL WATCHTOWER_D1_DATABASE_ID)

usage() { echo "usage: $0 [--dry-run] | $0 --delete-actions-secrets [--dry-run]" >&2; exit 2; }
DRY_RUN=0 DELETE_MODE=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    --delete-actions-secrets) DELETE_MODE=1 ;;
    *) usage ;;
  esac
done

die() { printf 'error: %s\n' "$*" >&2; exit 1; }
plan() { if [ "$DRY_RUN" -eq 1 ]; then echo "[dry-run] $*"; else echo "+ $*"; fi; }

preflight_failed=0
preflight_need() {
  # preflight_need <description> <test command...>
  local description="$1"; shift
  if "$@" > /dev/null 2>&1; then
    echo "pre-flight ok: $description"
  else
    echo "pre-flight FAILED: $description" >&2
    preflight_failed=1
  fi
}
verify_failed=0
verify_check() {
  # verify_check <description> <test command...>
  local description="$1"; shift
  if "$@" > /dev/null 2>&1; then echo "verify ok: $description"; else echo "verify FAILED: $description" >&2; verify_failed=1; fi
}

UUID_RE='[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
# The ids a workflow hands to sm-action: lines of `<uuid> > <ENV_NAME>`.
workflow_ids() { sed -nE "s/^[[:space:]]+(${UUID_RE}) > [A-Z][A-Z0-9_]+[[:space:]]*$/\1/p" "$1"; }
# Non-comment text of a workflow, to look for what it still reads.
workflow_code() { grep -vE '^[[:space:]]*#' "$1"; }

listed="" # the repository's Actions secret names
list_actions_secrets() { listed=$(gh secret list -R "$REPO" --json name --jq '.[].name'); }
listed_has() { grep -qx "$1" <<< "$listed"; }

# =============================================================================================
# Step 2: delete the Actions secrets the green deploys no longer read
# =============================================================================================

if [ "$DELETE_MODE" -eq 1 ]; then
  green_files=()
  have_tools_delete() { command -v gh && command -v jq; }
  trap 'for f in "${green_files[@]:-}"; do [ -z "$f" ] || rm -f "$f"; done' EXIT
  latest_green_uses_sm_action() {
    # Both checks for one workflow, so a failure names the file.
    local workflow="$1" run_json sha file
    run_json=$(gh run list -R "$REPO" --workflow "$workflow" --branch deploy --limit 1 --json conclusion,headSha,databaseId) || return 1
    [ "$(jq -r '.[0].conclusion // empty' <<< "$run_json")" = success ] || return 1
    sha=$(jq -r '.[0].headSha // empty' <<< "$run_json")
    [ -n "$sha" ] || return 1
    file=$(mktemp)
    green_files+=("$file")
    gh api -H "Accept: application/vnd.github.raw" "repos/$REPO/contents/.github/workflows/$workflow?ref=$sha" > "$file" || return 1
    workflow_code "$file" | grep -Eq 'uses:[[:space:]]*bitwarden/sm-action@'
  }
  latest_deploy_succeeded() {
    local workflow="$1" run_json
    run_json=$(gh run list -R "$REPO" --workflow "$workflow" --branch deploy --limit 1 --json conclusion,headSha,databaseId) || return 1
    [ "$(jq -r '.[0].conclusion // empty' <<< "$run_json")" = success ]
  }

  preflight_need "gh and jq are installed" have_tools_delete
  if [ "$preflight_failed" -eq 0 ]; then
    for workflow in "${DEPLOY_WORKFLOWS[@]}"; do
      preflight_need "the latest $workflow run on deploy succeeded" latest_deploy_succeeded "$workflow"
    done
  fi
  if [ "$preflight_failed" -eq 0 ]; then
    for workflow in "${DEPLOY_WORKFLOWS[@]}"; do
      preflight_need "that run's $workflow reads its secrets through bitwarden/sm-action" latest_green_uses_sm_action "$workflow"
    done
    preflight_need "the Actions secrets of $REPO can be listed" list_actions_secrets
  fi
  if [ "$preflight_failed" -eq 0 ]; then
    preflight_need "the Actions secret BWS_ACCESS_TOKEN is set, which the green deploys needed" listed_has BWS_ACCESS_TOKEN
  fi
  [ "$preflight_failed" -eq 0 ] || { echo "stopping: nothing was changed" >&2; exit 1; }

  to_delete=()
  for name in "${OLD_ACTIONS_SECRETS[@]}"; do
    listed_has "$name" || continue
    still_read=0
    for file in "${green_files[@]}"; do
      if workflow_code "$file" | grep -Eq "secrets\.${name}\b"; then still_read=1; fi
    done
    if [ "$still_read" -eq 1 ]; then
      echo "keep $name: a green workflow still reads it"
    else
      plan "delete Actions secret $name"
      to_delete+=("$name")
    fi
  done
  if [ "${#to_delete[@]}" -eq 0 ]; then echo "nothing to delete"; exit 0; fi
  [ "$DRY_RUN" -eq 0 ] || exit 0

  for name in "${to_delete[@]}"; do
    gh secret delete "$name" -R "$REPO" > /dev/null || die "could not delete the Actions secret $name"
  done

  list_actions_secrets || die "could not re-list the Actions secrets"
  not_listed() { ! listed_has "$1"; }
  for name in "${to_delete[@]}"; do verify_check "Actions secret $name is gone" not_listed "$name"; done
  verify_check "BWS_ACCESS_TOKEN is still set" listed_has BWS_ACCESS_TOKEN
  [ "$verify_failed" -eq 0 ] || exit 1
  exit 0
fi

# =============================================================================================
# Step 1: move the keys to `actions`, copy the two host values
# =============================================================================================

secrets="" source_id="" dest_id=""

# id_is <id> <key> <project id>: that exact id is a secret of that key in that project.
id_is() { jq -e --arg i "$1" --arg k "$2" --arg p "$3" '[.[] | select(.id == $i and .key == $k and .projectId == $p)] | length > 0' > /dev/null <<< "$secrets"; }
# host_copy_exists <host key> <original id>: a secret of that key in the source project other than the original.
host_copy_exists() { jq -e --arg k "$1" --arg o "$2" --arg p "$source_id" '[.[] | select(.key == $k and .projectId == $p and .id != $o)] | length > 0' > /dev/null <<< "$secrets"; }
# host_copy_matches <host key> <original id>: that copy holds the original's value (never printed).
host_copy_matches() {
  jq -e --arg k "$1" --arg o "$2" --arg p "$source_id" \
    '([.[] | select(.id == $o)][0].value) as $v | $v != null and ([.[] | select(.key == $k and .projectId == $p and .id != $o and .value == $v)] | length > 0)' > /dev/null <<< "$secrets"
}
value_of_id() { jq -r --arg i "$1" '[.[] | select(.id == $i)][0].value // empty' <<< "$secrets"; }

have_tools() { local tool; for tool in jq bws gh; do command -v "$tool" || return 1; done; }
load_secrets() {
  # The file is a bare BWS_ACCESS_TOKEN=... line: export it for the bws processes below.
  set -a; . "$HOME/.bws_token"; set +a
  secrets=$(bws secret list -o json) || return 1
  jq -e 'type == "array"' <<< "$secrets"
}
resolve_projects() {
  local listing
  listing=$(bws project list -o json) || return 1
  source_id=$(jq -r --arg n "$SOURCE_PROJECT" '[.[] | select(.name == $n)][0].id // empty' <<< "$listing")
  dest_id=$(jq -r --arg n "$DEST_PROJECT" '[.[] | select(.name == $n)][0].id // empty' <<< "$listing")
  [ -n "$source_id" ] && [ -n "$dest_id" ]
}
row_known() {
  local row id
  for row in "${ROWS[@]}"; do read -r id _ <<< "$row"; [ "$id" != "$1" ] || return 0; done
  return 1
}
workflow_ids_known() {
  # Every id a workflow maps is a row of this script, and at least one is mapped.
  local file id any=0 unknown=0
  for file in "${WORKFLOW_FILES[@]}"; do
    while read -r id; do
      any=1
      row_known "$id" || { echo "workflow id $id is not a row of this script" >&2; unknown=1; }
    done < <(workflow_ids "$file")
  done
  [ "$any" -eq 1 ] && [ "$unknown" -eq 0 ]
}

preflight_need "jq, bws and gh are installed" have_tools
preflight_need "$HOME/.bws_token exists (Secrets Manager access)" test -f "$HOME/.bws_token"
if [ "$preflight_failed" -eq 0 ]; then
  preflight_need "Secrets Manager answers (bws secret list)" load_secrets
fi
if [ "$preflight_failed" -eq 0 ]; then
  preflight_need "Secrets Manager projects $SOURCE_PROJECT and $DEST_PROJECT exist" resolve_projects
  preflight_need "the Actions secrets of $REPO can be listed" list_actions_secrets
fi
if [ "$preflight_failed" -eq 0 ]; then
  preflight_need "the Actions secret BWS_ACCESS_TOKEN is set on $REPO (argus-config#1418), or a deploy fails at sm-action" listed_has BWS_ACCESS_TOKEN
  for file in "${WORKFLOW_FILES[@]}"; do
    # Name the unknown id in the failure, not only the file.
    while read -r id; do
      row_known "$id" || preflight_need "$(basename "$file") maps $id, which is not a row of this script" false
    done < <(workflow_ids "$file")
  done
  preflight_need "the workflows map at least one id, and every one is a row of this script" workflow_ids_known
  for row in "${ROWS[@]}"; do
    read -r id old next _ <<< "$row"
    in_either() { id_is "$id" "$old" "$source_id" || id_is "$id" "$next" "$dest_id"; }
    preflight_need "the id $id is the secret $old in $SOURCE_PROJECT, or $next in $DEST_PROJECT" in_either
  done
fi
[ "$preflight_failed" -eq 0 ] || { echo "stopping: nothing was changed" >&2; exit 1; }

# ---- plan ----------------------------------------------------------------------------------

moves=() copies=()
for row in "${ROWS[@]}"; do
  read -r id old next host <<< "$row"
  if id_is "$id" "$next" "$dest_id"; then
    echo "$next ($id): already in $DEST_PROJECT, left as is"
  else
    plan "move $old ($id) from $SOURCE_PROJECT to $DEST_PROJECT as $next"
    moves+=("$row")
  fi
  if [ "$host" != "-" ]; then
    if host_copy_exists "$host" "$id"; then
      echo "$host: already in $SOURCE_PROJECT, left as is"
    else
      plan "create $host in $SOURCE_PROJECT with the value of $old (the host deploy reads it by name)"
      copies+=("$row")
    fi
  fi
done
if [ "${#moves[@]}" -eq 0 ] && [ "${#copies[@]}" -eq 0 ]; then echo "nothing to change"; fi
if [ "$DRY_RUN" -eq 1 ]; then
  plan "verify: each id is its new key in $DEST_PROJECT, and each host copy holds the value of its original"
  exit 0
fi

# ---- changes -------------------------------------------------------------------------------

for row in "${moves[@]}"; do
  read -r id old next _ <<< "$row"
  bws secret edit --key "$next" --project-id "$dest_id" -o none "$id" > /dev/null \
    || die "could not move $old ($id) to $DEST_PROJECT"
  plan "moved $old to $DEST_PROJECT as $next"
done

# Host copies come after the moves, from the value read before them (the id keeps it).
for row in "${copies[@]}"; do
  read -r id old _ host <<< "$row"
  value=$(value_of_id "$id")
  [ -n "$value" ] || die "$old ($id) has no value to copy to $host"
  bws secret create -o none "$host" "$value" "$source_id" > /dev/null || die "could not create $host in $SOURCE_PROJECT"
  unset value
  plan "created $host in $SOURCE_PROJECT"
done

# ---- verify --------------------------------------------------------------------------------

secrets=$(bws secret list -o json) || die "could not re-read Secrets Manager"

all_ids_in_dest() {
  local row id next
  for row in "${ROWS[@]}"; do read -r id _ next _ <<< "$row"; id_is "$id" "$next" "$dest_id" || return 1; done
}
verify_check "the ${#ROWS[@]} workflow ids are in $DEST_PROJECT, each under its own key" all_ids_in_dest
for row in "${ROWS[@]}"; do
  read -r id _ _ host <<< "$row"
  [ "$host" != "-" ] || continue
  verify_check "the host copy $host in $SOURCE_PROJECT holds the same value as $id" host_copy_matches "$host" "$id"
done

echo
echo "Next: the owner approves the promotion; both watchtower deploys read their values through sm-action. After both Deploy runs are green: bash scripts/owner-steps/59.sh --delete-actions-secrets"
[ "$verify_failed" -eq 0 ] || exit 1
