#!/usr/bin/env bash
# Test fixture: turn <repo-dir> into a git checkout whose HEAD is what its origin's
# deploy branch holds, so a deploy.sh copied into it passes
# scripts/require-deploy-checkout.sh. Tests that run a copy of a deploy.sh in a
# scratch directory call this first.
#
#   make-deploy-checkout.sh <repo-dir>
#
# The origin is a bare repo beside the checkout (<repo-dir>.origin.git). The guard
# is committed under scripts/; files the test adds afterwards stay untracked, which
# the guard ignores.
set -euo pipefail

repo="${1:?usage: make-deploy-checkout.sh <repo-dir>}"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export GIT_AUTHOR_NAME=test GIT_AUTHOR_EMAIL=test@example.invalid
export GIT_COMMITTER_NAME=test GIT_COMMITTER_EMAIL=test@example.invalid

mkdir -p "$repo/scripts"
git init -q -b main "$repo"
cp "$here/../require-deploy-checkout.sh" "$repo/scripts/require-deploy-checkout.sh"
git -C "$repo" add scripts
git -C "$repo" commit -q -m "deploy guard"
git init -q --bare -b main "$repo.origin.git"
git -C "$repo" remote add origin "$repo.origin.git"
git -C "$repo" push -q origin HEAD:main HEAD:deploy
