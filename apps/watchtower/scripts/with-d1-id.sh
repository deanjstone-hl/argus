#!/usr/bin/env bash
# Runs a command with the real D1 database id in wrangler.jsonc, then puts the placeholder back.
# The public tree holds no Cloudflare id (argus#1207): wrangler.jsonc carries a placeholder and
# the id lives in Bitwarden Secrets Manager as ARGUS_WATCHTOWER_D1_DATABASE_ID. The deploy
# workflow reads it from the `actions` project of Secrets Manager through bitwarden/sm-action
# into WATCHTOWER_D1_DATABASE_ID (argus#59); by hand it comes from the environment variable of
# that name or from Secrets Manager (scripts/private-value.sh).
#
#   bash scripts/with-d1-id.sh pnpm exec wrangler deploy
#
# Run it from apps/watchtower. The id is never printed; the file is restored on exit, also on
# failure, and the script refuses to start when the file is not in its committed placeholder state.
set -euo pipefail

placeholder="00000000-0000-4000-8000-0000000000d1"
config="wrangler.jsonc"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$here"

[ "$#" -ge 1 ] || { echo "usage: $0 <command> [args...]" >&2; exit 2; }
grep -q "$placeholder" "$config" || { echo "with-d1-id: $config does not hold the placeholder id" >&2; exit 1; }

if [ -n "${WATCHTOWER_D1_DATABASE_ID:-}" ]; then
  id="$WATCHTOWER_D1_DATABASE_ID"
else
  id="$(bash "$here/../../scripts/private-value.sh" ARGUS_WATCHTOWER_D1_DATABASE_ID)" || {
    echo "with-d1-id: set WATCHTOWER_D1_DATABASE_ID or the Secrets Manager secret ARGUS_WATCHTOWER_D1_DATABASE_ID" >&2
    exit 1
  }
fi
[[ "$id" =~ ^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$ ]] || { echo "with-d1-id: the id is not a UUID" >&2; exit 1; }

backup="$(mktemp)"
cp "$config" "$backup"
restore() { cp "$backup" "$config"; rm -f "$backup"; }
trap restore EXIT
sed -i "s/$placeholder/$id/" "$config"
"$@"
