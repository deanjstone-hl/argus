#!/usr/bin/env bash
# Vendor the myargus links registry from deanjstone-hl/frontend (ADR-0004), at one tag:
#
#   bash scripts/vendor-links.sh <tag>        e.g. v3.24.1
#
# Writes links.json (repo root), scripts/{link-check.sh,link-check-config.mjs,links.sh},
# .github/workflows/link-check.yml, and links.ts + links-core.ts into each package that
# builds URLs. The registry items are the `links-data`, `links-sh`, `link-check`,
# `links-core` and `links` items of the frontend registry; this fetches their source
# files from the tag, because `shadcn add` installs relative to one components.json and
# these files belong to the repo root and to three packages at once.
#
# The Vite package (apps/watchtower) keeps the `@/lib/links-core` import. The Node
# services are built with tsc and run `node dist/...`, which cannot resolve that alias,
# so their copies import `./links-core.js`. scripts/links-vendored.test.ts pins both.
# The workflow's runs-on is rewritten to `ubuntu-latest` (public-repo rule) and its mode to `block`.
# Re-run after a registry change, then commit the result. Never edit a vendored file.
set -euo pipefail

tag="${1:-}"
[[ $tag =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "usage: vendor-links.sh vX.Y.Z" >&2; exit 2; }

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
base="https://raw.githubusercontent.com/deanjstone-hl/frontend/$tag/registry"
scratch="$(mktemp -d)"
trap 'rm -rf "$scratch"' EXIT

fetch() { # <registry path> <local path>
  curl -fsS --max-time 30 "$base/$1" -o "$scratch/fetched"
  mkdir -p "$(dirname "$root/$2")"
  cp "$scratch/fetched" "$root/$2"
}

fetch links/links.json links.json
fetch links/link-check.sh scripts/link-check.sh
fetch links/link-check-config.mjs scripts/link-check-config.mjs
fetch links/links.sh scripts/links.sh
fetch links/link-check.yml .github/workflows/link-check.yml
chmod +x "$root/scripts/link-check.sh" "$root/scripts/links.sh"

# This repo is public: a public repo's CI runs on ubuntu-latest and reads no CI_RUNS_ON.
# It also holds at 0 findings, so the check blocks (decision 10), not reports.
workflow="$root/.github/workflows/link-check.yml"
sed -i "s#runs-on: \${{ fromJSON(vars.CI_RUNS_ON || '\"ubuntu-latest\"') }}#runs-on: ubuntu-latest#" "$workflow"
sed -i 's#LINK_CHECK_MODE: report#LINK_CHECK_MODE: block#' "$workflow"

vite_dir=apps/watchtower/src/lib
fetch lib/links.ts "$vite_dir/links.ts"
fetch lib/links-core.ts "$vite_dir/links-core.ts"

for dir in apps/watchtower-collector/src/lib apps/agent-engine/src/lib; do
  mkdir -p "$root/$dir"
  cp "$root/$vite_dir/links-core.ts" "$root/$dir/links-core.ts"
  sed 's#"@/lib/links-core"#"./links-core.js"#' "$root/$vite_dir/links.ts" > "$root/$dir/links.ts"
done

echo "vendored the links registry at $tag (revision $(jq -r .revision "$root/links.json"))"
