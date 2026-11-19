#!/usr/bin/env bash
# Store one secret in Bitwarden Secrets Manager (BWS) from a hidden prompt, so the value is
# never pasted into a chat, a `!` command or a command line you type (argus#21).
#
#   BWS_SECRET_KEY=<key> BWS_PROJECT_ID=<id>      bash scripts/bws-store-secret.sh
#   BWS_SECRET_KEY=<key> BWS_SIBLING_KEY=<other>  bash scripts/bws-store-secret.sh [--dry-run]
#
# Environment (nothing is hardcoded):
#   BWS_SECRET_KEY    required: the key to store under.
#   BWS_PROJECT_ID    the project to create it in, or
#   BWS_SIBLING_KEY   an existing key whose project to use. One of the two is required;
#                     BWS_PROJECT_ID wins when both are set.
#   SECRET_NOTE       optional note.
#   SECRET_EXPIRES    optional YYYY-MM-DD. When set, the note ends "Expires <date>". With
#                     SECRET_PREFIX=github_pat_ it defaults to 12 months out (the standing
#                     rule for GitHub fine-grained tokens).
#   SECRET_PREFIX     optional: warn when the pasted value does not start with it.
#   BWS_TOKEN_FILE    file that sets BWS_ACCESS_TOKEN (default ~/.bws_token). A
#                     BWS_ACCESS_TOKEN already in the environment is used as it is.
#
# Creates the secret, or replaces its value with `bws secret edit --value` when the key
# already exists in that project; an existing note is kept unless SECRET_NOTE or an expiry is
# given. Prints lengths and the key, never the value. `--dry-run` says what it would do and
# changes nothing (it reads the secret list, never prompts).
#
# Exit: 0 stored (or dry run), 1 failed or nothing pasted, 2 a malformed call.
#
# `bws` 2.x has no stdin form for a value, so while it runs the value is in that one `bws`
# process's arguments, visible only to this user. The same trade-off as scripts/owner-steps/1207.sh.
set -euo pipefail

usage="usage: $0 [--dry-run]   (set BWS_SECRET_KEY and BWS_PROJECT_ID or BWS_SIBLING_KEY; see the header)"

dry_run=false
case "$#:${1:-}" in
  0:) ;;
  1:--dry-run) dry_run=true ;;
  *)
    echo "$usage" >&2
    exit 2
    ;;
esac

if [ -z "${BWS_SECRET_KEY:-}" ]; then
  echo "bws-store-secret: BWS_SECRET_KEY is required. $usage" >&2
  exit 2
fi
if [ -z "${BWS_PROJECT_ID:-}" ] && [ -z "${BWS_SIBLING_KEY:-}" ]; then
  echo "bws-store-secret: BWS_PROJECT_ID or BWS_SIBLING_KEY is required. $usage" >&2
  exit 2
fi

key="$BWS_SECRET_KEY"
prefix="${SECRET_PREFIX:-}"
expires="${SECRET_EXPIRES:-}"

if [ -n "$expires" ] && ! [[ "$expires" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]]; then
  echo "bws-store-secret: SECRET_EXPIRES must be YYYY-MM-DD" >&2
  exit 2
fi

command -v bws > /dev/null || { echo "bws-store-secret: bws is not on PATH" >&2; exit 1; }
command -v jq > /dev/null || { echo "bws-store-secret: jq is not on PATH" >&2; exit 1; }

if [ -z "${BWS_ACCESS_TOKEN:-}" ]; then
  token_file="${BWS_TOKEN_FILE:-${HOME:-/nonexistent}/.bws_token}"
  if [ ! -r "$token_file" ]; then
    echo "bws-store-secret: cannot read the Secrets Manager token file $token_file" >&2
    exit 1
  fi
  # shellcheck source=/dev/null
  . "$token_file"
fi
export BWS_ACCESS_TOKEN

# A GitHub fine-grained token expires in 12 months, by the owner's standing rule.
if [ -z "$expires" ] && [ "$prefix" = "github_pat_" ]; then
  expires="$(date -d "+12 months" +%F)"
fi

note="${SECRET_NOTE:-}"
if [ -n "$expires" ]; then
  note="${note:+$note }Expires $expires"
fi

listing="$(bws secret list -o json)"

project="${BWS_PROJECT_ID:-}"
if [ -z "$project" ]; then
  project="$(jq -r --arg k "$BWS_SIBLING_KEY" '[.[] | select(.key == $k)][0].projectId // empty' <<< "$listing")"
  if [ -z "$project" ]; then
    echo "bws-store-secret: could not find the project of $BWS_SIBLING_KEY" >&2
    exit 1
  fi
fi
echo "Project: $project"

existing_id="$(jq -r --arg k "$key" --arg p "$project" '[.[] | select(.key == $k and .projectId == $p)][0].id // empty' <<< "$listing")"
unset listing

if [ "$dry_run" = true ]; then
  if [ -n "$existing_id" ]; then
    echo "dry-run: would replace the value of $key ($existing_id) in project $project"
  else
    echo "dry-run: would create $key in project $project"
  fi
  [ -z "$note" ] || echo "dry-run: note would be: $note"
  [ -z "$prefix" ] || echo "dry-run: would warn if the value does not start with $prefix"
  echo "dry-run: done, nothing was changed"
  exit 0
fi

read -rsp "Paste the value for $key, then Enter: " value || true
echo
if [ -z "$value" ]; then
  echo "Nothing pasted, nothing stored."
  exit 1
fi
if [ -z "$prefix" ]; then
  echo "Value read (${#value} chars)."
elif [[ "$value" == "$prefix"* ]]; then
  echo "Value read (${#value} chars, prefix OK)."
else
  echo "Warning: value does not start with $prefix (${#value} chars)." >&2
fi

note_args=()
[ -z "$note" ] || note_args=(--note "$note")

write_ok=true
if [ -n "$existing_id" ]; then
  echo "Key exists; replacing its value."
  bws secret edit "$existing_id" --value "$value" "${note_args[@]}" > /dev/null || write_ok=false
else
  bws secret create "$key" "$value" "$project" "${note_args[@]}" > /dev/null || write_ok=false
fi
unset value
if [ "$write_ok" = false ]; then
  echo "Store FAILED: bws refused the write for $key" >&2
  exit 1
fi

if bws secret list -o json | jq -e --arg k "$key" --arg p "$project" 'any(.[]; .key == $k and .projectId == $p)' > /dev/null; then
  echo "Stored: $key"
else
  echo "Store FAILED: $key not visible after the write" >&2
  exit 1
fi
