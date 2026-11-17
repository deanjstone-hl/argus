#!/usr/bin/env bash
# Where a deploy-time .env lives (argus-config#1267). Source this; do not run it.
#
#   source "$REPO_ROOT/scripts/lib/app-env.sh"
#
# The sanctioned path is ~/.config/argus/<app>.env (file 0600, directory 0700), the same on
# WSL2 and the homelab. It sits outside the deploy copy, so an agent can create or fix one:
# the worktree-policy hook blocks every write into a ~/repos/* deploy copy, untracked files
# included. The old path, apps/<app>/.env inside the deploy copy, still works for now and
# warns (expand, migrate, contract); scripts/owner-steps/1267.sh in argus-config moves the
# files. Nothing here prints a value from an env file.

app_env_dir() { printf '%s\n' "${HOME}/.config/argus"; }

app_env_path() { printf '%s/%s.env\n' "$(app_env_dir)" "$1"; }

# Create the directory 0700, so a writer can put a 0600 file in it.
app_env_ensure_dir() {
  local dir
  dir="$(app_env_dir)"
  mkdir -p "$dir"
  chmod 700 "$dir"
}

app_env_warn_legacy() {
  local app="$1" legacy="$2"
  echo "  ⚠  deprecated: ${legacy} is read from the deploy copy, which agents cannot edit. Move it to $(app_env_path "$app") (bash scripts/owner-steps/1267.sh in argus-config does it)." >&2
}

# Print the env file a reader should source: the new path if it exists, else the legacy path
# (with a deprecation warning on stderr), else exit 1 naming the new path.
#   env_file="$(app_env_resolve <app> <legacy-path>)" || exit 1
app_env_resolve() {
  local app="$1" legacy="$2" current
  current="$(app_env_path "$app")"
  if [[ -f "$current" ]]; then
    [[ -f "$legacy" ]] && app_env_warn_legacy "$app" "$legacy"
    printf '%s\n' "$current"
    return 0
  fi
  if [[ -f "$legacy" ]]; then
    app_env_warn_legacy "$app" "$legacy"
    printf '%s\n' "$legacy"
    return 0
  fi
  echo "✗ no env file for ${app}: create ${current} (mode 600), or run argus-config's scripts/owner-steps/1267.sh to move the old ${legacy}." >&2
  return 1
}
