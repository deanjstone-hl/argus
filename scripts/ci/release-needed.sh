#!/usr/bin/env bash
# Does this promotion carry anything semantic-release would publish? (argus#1168, rule
# argus-config#1167: nothing releasable means no test and no version.)
# Prints `release=true|false` to $GITHUB_OUTPUT.
#
# semantic-release's default commit-analyzer publishes only for feat, fix, perf, a revert or
# a breaking change. Most promotions carry none, and then there is nothing for a test to gate.
#
# The anchor is the newest root `v<X.Y.Z>` tag. The release job tags the root last, after
# every package track, and stops at the first failure, so a run that failed part-way leaves
# the root tag where it was and the retry sees the same range. The root track also reads
# every commit, so a package's releasable commit is always inside that range. Package tags
# (`@argus/<name>-v...`) and `memory-mcp-<sha>` do not match `v[0-9]*`.
#
# It reads git, never the push event: GitHub lists 20 commits at most and a promotion can
# ship more. A missing tag, or any git error, says release=true: a skipped release is the
# failure to avoid, a needless test is only cost.
#
# Run from a checkout of the promoted SHA with full history (fetch-depth: 0).
set -uo pipefail

output="${GITHUB_OUTPUT:-/dev/stdout}"

decide() {
  printf 'release=%s\n' "$1" >> "$output"
  echo "release-needed: release=$1 ($2)"
  exit 0
}

git rev-parse --verify --quiet HEAD > /dev/null 2>&1 || decide true "no git history to read"

last=$(git describe --tags --abbrev=0 --match 'v[0-9]*' 2> /dev/null || true)
[[ -n "$last" ]] || decide true "no root v-tag yet"

subjects=$(git log "$last..HEAD" --format=%s 2> /dev/null) || decide true "could not read $last..HEAD"
bodies=$(git log "$last..HEAD" --format=%B 2> /dev/null) || decide true "could not read $last..HEAD"

if grep -qE '^((feat|fix|perf|revert)(\(.+\))?!?:|Revert )' <<< "$subjects"; then
  decide true "a feat, fix, perf or revert commit since $last"
fi
if grep -q 'BREAKING CHANGE' <<< "$bodies"; then
  decide true "a BREAKING CHANGE since $last"
fi

echo "Nothing releasable since $last: no test, no release."
printf 'release=false\n' >> "$output"
