#!/usr/bin/env bash
# Owner steps for argus/1160: the ops-hub cutover's homelab steps.
#
# Run on the homelab, from a checkout at the merged commit, as ONE approved command:
#   bash scripts/owner-steps/1160.sh
# Preview (read-only pre-flight, then prints each step and changes nothing):
#   bash scripts/owner-steps/1160.sh --dry-run
#
# What it changes, in order:
#   1. Clones git@github.com:deanjstone/ops-hub.git to ~/repos/ops-hub, the deploy copy
#      that ops-hub's deploy workflow runs from. Detached at origin/deploy once that
#      branch exists; until then it stays on main. An existing checkout is left alone.
#   2. Adds deanjstone/ops-hub to OPS_HUB_PROMOTION_REPOS in
#      ~/repos/argus/apps/ops-hub/.env, so the hub shows the repo's promotion card.
#      Only that one line is rewritten (same separator, same file mode); no other
#      line is read out or printed.
#   3. Restarts the user unit ops-hub so it re-reads the .env. A re-run restarts it
#      again, which also finishes a run that stopped after step 2.
#   4. Reads http://127.0.0.1:<port>/healthz back, up to 60 seconds.
# Idempotent: a finished step is reported as already done and skipped.
#
# Not in this script: adding deanjstone/ops-hub to the ops-hub GitHub App's repository
# access (a GitHub UI step on argus/1161), and the first promotion (the owner's Approve
# on the hub card). It never calls promote.sh, never pushes `deploy` and dispatches no
# workflow. It writes and reads no secret.
set -euo pipefail

usage() { echo "usage: $0 [--dry-run]" >&2; exit 2; }

dry_run=0
case "${1:-}" in
  "") ;;
  --dry-run) dry_run=1 ;;
  *) usage ;;
esac
[ "$#" -le 1 ] || usage

REQUIRED_HOST="homelab"
REPO="deanjstone/ops-hub"
CLONE_URL="git@github.com:${REPO}.git"
CLONE_DIR="$HOME/repos/ops-hub"
ENV_FILE="$HOME/repos/argus/apps/ops-hub/.env"
KEY="OPS_HUB_PROMOTION_REPOS"
UNIT="ops-hub"
HEALTH_WAIT_SECONDS=60

host="$(hostname)"
if [ "$host" != "$REQUIRED_HOST" ]; then
  echo "refusing to run: this is '$host', and the script runs on $REQUIRED_HOST only." >&2
  exit 1
fi

# Print one KEY's value from the .env. Only called for the two non-secret keys below.
env_value() {
  local line
  line="$(grep -m1 "^$1=" "$ENV_FILE" || true)"
  printf '%s' "${line#"$1="}"
}

key_line_count() {
  grep -c "^${KEY}=" "$ENV_FILE" || true
}

# True when $1 (a list separated by commas or spaces) already names $REPO.
list_has_repo() {
  local entry
  for entry in ${1//,/ }; do
    [ "$entry" = "$REPO" ] && return 0
  done
  return 1
}

# Echo the list with $REPO added, keeping the separator the list already uses.
list_with_repo() {
  local current="$1"
  if [ -z "$current" ]; then
    printf '%s' "$REPO"
  elif [[ "$current" != *,* && "$current" == *" "* ]]; then
    printf '%s %s' "$current" "$REPO"
  else
    printf '%s,%s' "$current" "$REPO"
  fi
}

port_from_env() {
  local candidate
  for name in OPS_HUB_PORT NOTICE_BOARD_PORT; do
    candidate="$(env_value "$name")"
    if [[ "$candidate" =~ ^[0-9]+$ ]]; then
      printf '%s' "$candidate"
      return 0
    fi
  done
  printf '3790'
}

preflight_failed=0
preflight_need() {
  # preflight_need <description> <test command...>
  local description="$1"; shift
  if "$@" >/dev/null 2>&1; then
    echo "pre-flight ok: $description"
  else
    echo "pre-flight FAILED: $description" >&2
    preflight_failed=1
  fi
}

env_key_is_rewritable() {
  [ "$(key_line_count)" = "1" ] || return 1
  local value
  value="$(env_value "$KEY")"
  [[ "$value" =~ ^[A-Za-z0-9_./,\ -]*$ ]]
}

clone_dir_is_absent_or_ops_hub() {
  [ ! -e "$CLONE_DIR" ] && return 0
  [ "$(git -C "$CLONE_DIR" remote get-url origin)" = "$CLONE_URL" ]
}

echo "== pre-flight (read-only) =="
echo "pre-flight ok: host is $REQUIRED_HOST"
preflight_need "git is installed" command -v git
preflight_need "systemctl is installed" command -v systemctl
preflight_need "curl is installed" command -v curl
preflight_need "the hub .env exists and is readable" test -r "$ENV_FILE"
if [ -r "$ENV_FILE" ]; then
  preflight_need "the hub .env has exactly one unquoted $KEY line (the script will not guess a missing list or rewrite a quoted one)" \
    env_key_is_rewritable
fi
preflight_need "GitHub answers over ssh for $REPO" git ls-remote "$CLONE_URL" HEAD
preflight_need "$CLONE_DIR is absent, or already a checkout of $REPO" clone_dir_is_absent_or_ops_hub
if [ "$preflight_failed" -ne 0 ]; then
  echo "pre-flight stopped the script; nothing was changed." >&2
  exit 1
fi

port="$(port_from_env)"
current_list="$(env_value "$KEY")"
new_list="$(list_with_repo "$current_list")"

if [ "$dry_run" -eq 1 ]; then
  echo
  echo "== dry run: nothing below is executed =="
fi

# step 1: the deploy copy
if [ -e "$CLONE_DIR" ]; then
  echo "step 1: $CLONE_DIR is already a checkout of $REPO; leaving it alone."
else
  echo "step 1: clone $CLONE_URL to $CLONE_DIR"
  if [ "$dry_run" -eq 0 ]; then
    git clone "$CLONE_URL" "$CLONE_DIR"
  fi
  if git ls-remote --exit-code --heads "$CLONE_URL" deploy >/dev/null 2>&1; then
    echo "  deploy exists on the remote: detach the clone at origin/deploy"
    if [ "$dry_run" -eq 0 ]; then
      git -C "$CLONE_DIR" switch --detach origin/deploy
    fi
  else
    echo "  no deploy branch yet: the clone stays on its default branch."
  fi
fi

# step 2: the one .env key
if list_has_repo "$current_list"; then
  echo "step 2: $KEY already lists $REPO; no change."
else
  echo "step 2: set $KEY in $ENV_FILE"
  echo "  was: $current_list"
  echo "  now: $new_list"
  if [ "$dry_run" -eq 0 ]; then
    tmp_env="$(umask 077 && mktemp)"
    trap 'rm -f "$tmp_env"' EXIT
    NEW_LIST="$new_list" awk -v key="$KEY" '
      index($0, key "=") == 1 && !done { print key "=" ENVIRON["NEW_LIST"]; done = 1; next }
      { print }
    ' "$ENV_FILE" > "$tmp_env"
    # Every other line must be byte-identical before the file is touched.
    if ! cmp -s <(grep -v "^${KEY}=" "$ENV_FILE") <(grep -v "^${KEY}=" "$tmp_env"); then
      echo "refusing to write: the rewrite would change a line other than $KEY." >&2
      exit 1
    fi
    # Write through the existing file so its mode and owner stay as they are.
    cat "$tmp_env" > "$ENV_FILE"
  fi
fi

# step 3: restart
echo "step 3: restart the user unit $UNIT"
if [ "$dry_run" -eq 0 ]; then
  systemctl --user restart "$UNIT"
fi

# step 4: health read-back
echo "step 4: read http://127.0.0.1:${port}/healthz back (up to ${HEALTH_WAIT_SECONDS}s)"
if [ "$dry_run" -eq 1 ]; then
  echo
  echo "dry run complete: nothing was changed."
  exit 0
fi

healthy=0
waited=0
while [ "$waited" -lt "$HEALTH_WAIT_SECONDS" ]; do
  if curl -fsS "http://127.0.0.1:${port}/healthz" >/dev/null 2>&1; then
    healthy=1
    break
  fi
  sleep 2
  waited=$((waited + 2))
done

echo
echo "== verify =="
verify_failed=0
verify() {
  # verify <description> <test command...>
  local description="$1"; shift
  if "$@" >/dev/null 2>&1; then
    echo "ok: $description"
  else
    echo "FAILED: $description" >&2
    verify_failed=1
  fi
}
verify "$CLONE_DIR is a checkout of $REPO" test "$(git -C "$CLONE_DIR" remote get-url origin)" = "$CLONE_URL"
verify "$KEY lists $REPO" list_has_repo "$(env_value "$KEY")"
verify "$UNIT is active" test "$(systemctl --user is-active "$UNIT")" = "active"
if [ "$healthy" -eq 1 ]; then
  echo "ok: /healthz answers on 127.0.0.1:${port}"
else
  echo "FAILED: /healthz does not answer on 127.0.0.1:${port} after ${HEALTH_WAIT_SECONDS}s: journalctl --user -u $UNIT" >&2
  verify_failed=1
fi
if [ "$verify_failed" -ne 0 ]; then
  exit 1
fi
echo "done: next, add $REPO to the ops-hub GitHub App's repository access (argus/1161 step 2)."
