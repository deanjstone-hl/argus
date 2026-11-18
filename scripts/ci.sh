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
#                                   pre-push mode, since the full suite is slow
#
# Nested packages carry their own pnpm workspace and lockfile, so the root
# workspace cannot reach them (see AGENTS.md, "Subtree-merged packages"). Their
# per-package lint and format scripts and smoke test live in nested_config below.
set -euo pipefail

repo_root="$(git rev-parse --show-toplevel)"
cd "$repo_root"

# Run from a git hook, git exports GIT_DIR, GIT_INDEX_FILE and friends. Every
# git command the test suites run in their own scratch repos would inherit them
# and act on this repository instead — the reconciler tests of the former
# apps/memory-mcp did exactly that, setting core.bare=true and a test identity in the shared
# .git/config and committing onto the checked-out branch.
# shellcheck disable=SC2046
unset $(git rev-parse --local-env-vars)

readonly nested_packages=()

# Root-level files that can change any package's outcome. When one of these
# differs from the base, --changed widens to the full root workspace.
readonly root_config_files=(package.json pnpm-lock.yaml pnpm-workspace.yaml scripts/ci.sh tools)

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

resolve_base() {
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
  step "Typecheck (root)" pnpm "${filter_args[@]}" --if-present run typecheck
  step "Lint (root)" pnpm "${filter_args[@]}" --if-present run lint
  step "Build (root)" pnpm "${filter_args[@]}" --if-present run build
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
  if [[ "$changed_only" == true && -z "$(changed_paths docs scripts .github/actions .github/workflows package.json)" ]]; then
    echo "docs/, scripts/, .github/actions/ and .github/workflows/ unchanged since $base_ref — skipping."
    return
  fi

  step "Docs index" node scripts/docs-list.ts --check
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
