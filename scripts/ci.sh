#!/usr/bin/env bash
# The single definition of this repo's CI checks. `.github/workflows/ci.yml` and
# the `.githooks/pre-push` gate both call this, so what runs locally before a push
# and what GitHub runs on the PR cannot drift apart.
#
#   scripts/ci.sh                   root workspace, then every nested package
#   scripts/ci.sh root              root workspace and repo scripts only
#   scripts/ci.sh nested <package>  one nested-workspace package (apps/<package>)
#   scripts/ci.sh ecosystem-skills <skills-dir>...
#                                   the ecosystem manifest's skill entries against
#                                   those installed skills (argus#928); the workflow
#                                   checks out the two private repos that hold them
#   scripts/ci.sh --changed [...]   only what differs from origin/main — the
#                                   pre-push mode, since the full suite is slow. On a
#                                   push to main CI sets CI_BASE_REF to the push's
#                                   `before` SHA and the diff is against that instead,
#                                   because origin/main already holds HEAD. A CI_BASE_REF
#                                   the checkout cannot resolve (new branch, force-push)
#                                   checks everything.
#
# Serial mode (argus#36): one package at a time, one vitest worker (VITEST_MAX_WORKERS=1) and a
# 1536 MB heap cap. CI_SERIAL=1 forces it, CI_SERIAL=0 forces the parallel run, and unset picks:
# serial everywhere except GitHub Actions (dedicated runners keep their parallelism), on a host
# with under CI_SERIAL_MAX_MEM_MB of RAM (default 12288: WSL2 is about 5 GB, homelab 7.8 GB).
# So `pnpm check` and the pre-push hook run serially on a small host with no flag.
#
# A schedule or dispatch run passes no --changed: the daily full run (daily-full.yml) is the
# whole suite, and the Release gate counts it (argus#65, argus-config#1595).
#
# Nested packages carry their own pnpm workspace and lockfile, so the root
# workspace cannot reach them (see AGENTS.md, "Subtree-merged packages"). Their
# per-package lint and format scripts and smoke test live in nested_config below.
set -euo pipefail

repo_root="$(git rev-parse --show-toplevel)"
cd "$repo_root"

# One full check at a time per host (argus-config#1506): two overlapping gates made
# systemd-oomd kill agent scopes. Every mode takes the host-wide lock: the re-exec waits for
# it (HEAVY_LOCK_TIMEOUT, default 3600 s, then exit 75), then runs this script with
# HEAVY_LOCK_HELD=1 so it does not wait again. scripts/heavy-lock.sh is vendored from argus-config.
if [[ "${HEAVY_LOCK_HELD:-}" != 1 ]]; then
  exec bash "$repo_root/scripts/heavy-lock.sh" bash "$repo_root/scripts/ci.sh" "$@"
fi

# Run from a git hook, git exports GIT_DIR, GIT_INDEX_FILE and friends. Every
# git command the test suites run in their own scratch repos would inherit them
# and act on this repository instead — the reconciler tests of the former
# apps/memory-mcp did exactly that, setting core.bare=true and a test identity in the shared
# .git/config and committing onto the checked-out branch.
# shellcheck disable=SC2046
unset $(git rev-parse --local-env-vars)

readonly nested_packages=()

# Whether this run is serial; see the header. Sets `serial` to true or false.
decide_serial() {
  serial=false
  case "${CI_SERIAL:-}" in
    1) serial=true ;;
    0) ;;
    *)
      [[ -z "${GITHUB_ACTIONS:-}" ]] || return 0
      local total_kb total_mb
      total_kb="$(awk '/^MemTotal:/ { print $2 }' /proc/meminfo 2> /dev/null || true)"
      [[ -n "$total_kb" ]] || return 0
      total_mb=$((total_kb / 1024))
      if ((total_mb < ${CI_SERIAL_MAX_MEM_MB:-12288})); then
        serial=true
      fi
      ;;
  esac
}

serial=false
decide_serial
# pnpm arguments that stop a recursive run from starting every package at once.
serial_args=()
if [[ "$serial" == true ]]; then
  serial_args=(--workspace-concurrency=1)
  export VITEST_MAX_WORKERS=1
  export NODE_OPTIONS="${NODE_OPTIONS:---max-old-space-size=1536}"
  echo "ci.sh: serial mode (one package at a time, VITEST_MAX_WORKERS=1)."
fi

# Root-level files that can change any package's outcome. When one of these
# differs from the base, --changed widens to the full root workspace.
readonly root_config_files=(package.json pnpm-lock.yaml pnpm-workspace.yaml scripts/ci.sh tools)

# Repo-level paths a scripts test reads: a change to one runs the scripts suite. The docs index
# (docs/) is the one thing a change under docs/ can break, and it needs no install, so a change
# confined to docs/ runs only that and the scrub scan. A list of globs: git pathspecs, where `*`
# crosses `/`.
readonly repo_script_code_paths=(
  scripts .github/actions .github/workflows package.json links.json .gitleaks.toml .githooks
  'apps/*/deploy.sh' 'apps/*/systemd/*' 'apps/*/.env.example' 'apps/*/wrangler.jsonc'
)

changed_only=false
base_ref=""

group_start() {
  if [[ -n "${GITHUB_ACTIONS:-}" ]]; then
    echo "::group::$1"
  else
    printf '\n==> %s\n' "$1"
  fi
}

group_end() {
  if [[ -n "${GITHUB_ACTIONS:-}" ]]; then
    echo "::endgroup::"
  fi
}

step() {
  local name="$1"
  shift
  group_start "$name"
  "$@"
  group_end
}

# Sets the globals `lint_script`, `format_script` and `smoke_command` for a
# nested package. An empty `format_script` means the package has no format check.
nested_config() {
  lint_script="lint"
  format_script=""
  smoke_command=""
  case "$1" in
    *)
      echo "ci.sh: unknown nested package '$1' (known: ${nested_packages[*]})" >&2
      exit 2
      ;;
  esac
}

have_commit() {
  git cat-file -e "$1^{commit}" 2> /dev/null && return 0
  git fetch --quiet --depth=1 origin "$1" 2> /dev/null && git cat-file -e "$1^{commit}" 2> /dev/null
}

resolve_base() {
  # A push to main: HEAD is origin/main, so the merge base is HEAD and would select nothing.
  # CI hands over the push's `before`; a shallow checkout fetches just that commit.
  if [[ -n "${CI_BASE_REF:-}" ]]; then
    if [[ "$CI_BASE_REF" =~ ^0+$ ]] || ! have_commit "$CI_BASE_REF"; then
      echo "CI_BASE_REF $CI_BASE_REF is not a commit this checkout can read — checking everything."
      changed_only=false
      return
    fi
    base_ref="$CI_BASE_REF"
    return
  fi
  git fetch --quiet origin main
  base_ref="$(git merge-base HEAD origin/main)"
}

changed_paths() {
  git diff --name-only "$base_ref" HEAD -- "$@"
}

run_root() {
  local filter_args=(-r)
  if [[ "$changed_only" == true ]]; then
    if [[ -n "$(changed_paths "${root_config_files[@]}")" ]]; then
      echo "Root config changed since $base_ref — checking the full root workspace."
    else
      # `...[<ref>]` selects packages changed since the ref plus everything that
      # depends on them, so a change to a shared package still re-checks its
      # consumers. Nested-workspace packages are excluded from the root
      # workspace, so they never match here.
      # pnpm attributes files outside any member (including the excluded nested
      # packages) to the root project, so the root alone matching means no
      # member changed.
      filter_args=(--filter "...[$base_ref]")
      local selected
      selected="$(pnpm "${filter_args[@]}" list --depth -1 --parseable)"
      if [[ -z "$(grep -vxF "$repo_root" <<<"$selected")" ]]; then
        echo "No root-workspace package changed since $base_ref — skipping root."
        return
      fi
    fi
  fi

  step "Install (root)" pnpm install --frozen-lockfile
  step "Typecheck (root)" pnpm "${filter_args[@]}" "${serial_args[@]}" --if-present run typecheck
  step "Lint (root)" pnpm "${filter_args[@]}" "${serial_args[@]}" --if-present run lint
  step "Build (root)" pnpm "${filter_args[@]}" "${serial_args[@]}" --if-present run build
  # Serialized deliberately: Workers packages (watchtower and any other)
  # each spawn their own workerd via @cloudflare/vitest-pool-workers, and run concurrently
  # on the 4-core homelab runner they starve each other into failures that look
  # like logic bugs (argus#345). Raise to 2 before reverting it outright.
  step "Test (root)" pnpm "${filter_args[@]}" --if-present --workspace-concurrency=1 run test
}

# Repo-level checks that belong to no workspace member: the docs index (every doc
# under docs/ needs summary: and read_when: front matter, see the Repo Structure
# Standard) and the tests for scripts/ itself, which also cover the shell
# behind .github/actions and the workflows (scripts/workflow-gates.test.ts reads
# .github/workflows/*.yml).
run_repo_scripts() {
  local docs_only=false
  if [[ "$changed_only" == true ]]; then
    if [[ -z "$(changed_paths docs "${repo_script_code_paths[@]}")" ]]; then
      echo "docs/, scripts/, .github/ and the files the scripts tests read are unchanged since $base_ref — skipping."
      return
    fi
    if [[ -z "$(changed_paths "${repo_script_code_paths[@]}")" ]]; then
      docs_only=true
    fi
  fi

  step "Docs index" node scripts/docs-list.ts --check

  if [[ "$docs_only" == true ]]; then
    # Only docs/ changed since $base_ref: the docs index above is what it can break. The public
    # tree's scrub scan (scripts/public-safe.test.ts runs it too) still covers a leaked value,
    # without the install and the vitest run.
    if command -v gitleaks > /dev/null; then
      step "Scrub scan" bash scripts/scrub-scan.sh
    else
      echo "gitleaks is not on PATH — the scrub scan runs in CI and in the scripts tests."
    fi
    return
  fi

  step "Install (scripts)" pnpm install --frozen-lockfile
  # Unbounded, vitest forks one worker per core and each gets the full heap cap. On
  # the 7.8 GB homelab, shared with production, that peak is what systemd-oomd kills
  # sessions for under memory pressure (argus#41). One worker locally; GitHub Actions
  # runners are dedicated, so CI keeps the parallelism.
  local scripts_test_args=()
  if [[ -z "${GITHUB_ACTIONS:-}" ]]; then
    scripts_test_args=(--maxWorkers=1)
  fi
  step "Test (scripts)" pnpm run test:scripts "${scripts_test_args[@]}"
}

run_nested() {
  local package="$1"
  nested_config "$package"

  if [[ "$changed_only" == true && -z "$(changed_paths "apps/$package" scripts/ci.sh)" ]]; then
    echo "apps/$package unchanged since $base_ref — skipping."
    return
  fi

  (
    cd "apps/$package"
    step "Install ($package)" pnpm install --frozen-lockfile
    step "Typecheck ($package)" pnpm run --if-present typecheck
    step "Lint ($package)" pnpm run --if-present "$lint_script"
    if [[ -n "$format_script" ]]; then
      step "Format ($package)" pnpm run "$format_script"
    fi
    step "Build ($package)" pnpm run --if-present build
    if [[ -n "$smoke_command" ]]; then
      step "Smoke test ($package)" bash -c "$smoke_command"
    fi
    step "Test ($package)" pnpm run --if-present test
  )
}

# The manifest's skill entries must match the installed skills, which live in
# argus-config and sys-admin. Those are private, so the directories come from the
# caller: ci.yml checks them out with a read-only token. Not part of `all` or
# --changed, which have no such checkouts.
run_ecosystem_skills() {
  local skills_args=() dir
  for dir in "$@"; do
    skills_args+=(--skills "$dir")
  done

  step "Ecosystem skills" node scripts/ecosystem/sync-skills.ts --check "${skills_args[@]}"
}

main() {
  if [[ "${1:-}" == "--changed" ]]; then
    changed_only=true
    shift
    resolve_base
  fi

  case "${1:-all}" in
    root)
      run_root
      run_repo_scripts
      ;;
    nested)
      if [[ -z "${2:-}" ]]; then
        echo "usage: scripts/ci.sh [--changed] nested <package>" >&2
        exit 2
      fi
      run_nested "$2"
      ;;
    ecosystem-skills)
      if [[ $# -lt 2 ]]; then
        echo "usage: scripts/ci.sh ecosystem-skills <skills-dir>..." >&2
        exit 2
      fi
      shift
      run_ecosystem_skills "$@"
      ;;
    all)
      run_root
      run_repo_scripts
      local package
      for package in "${nested_packages[@]}"; do
        run_nested "$package"
      done
      ;;
    *)
      echo "usage: scripts/ci.sh [--changed] [all | root | nested <package> | ecosystem-skills <skills-dir>...]" >&2
      exit 2
      ;;
  esac
}

main "$@"
