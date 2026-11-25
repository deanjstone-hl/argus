#!/usr/bin/env bash
# Owner steps for argus/1126 (relay retired by argus/1125): tear down the live vault-agent relay.
#
# Run on WSL2, from a checkout at the merged commit, as ONE approved command:
#   bash scripts/owner-steps/1126.sh
# Preview (read-only pre-flight and state reads, then prints each command and changes nothing):
#   bash scripts/owner-steps/1126.sh --dry-run
#
# What it changes, in order, with `cf` (no Wrangler config remains). Each step reads the state
# first and treats an already-gone resource as a pass, so a run that stopped can be run again:
#   1. Deletes the Worker argus-vault-agent-relay: `cf workers delete --force
#      --delete-with-references`. The Worker's Durable Object namespace goes with it, and its
#      versions and deployments. The flag is safe here: pre-flight has already checked that no
#      other Worker references the relay and that the only domain it holds is vault.myargus.cc.
#   2. Removes the custom domain vault.myargus.cc and its DNS record. `cf` has no command for a
#      Workers custom domain, so the domain goes with the Worker (the delete in step 1); this
#      step then lists the zone's DNS records for the hostname and deletes any that remain, by id.
#      If one cannot be deleted (a record a Workers custom domain still owns), it stops and says
#      where to remove the domain by hand.
#   3. Deletes the Worker secret MCP_AUTH_TOKEN. It is bound to the Worker, so step 1 already
#      removed it; this step only issues the delete if the Worker is somehow still listed with it.
#      It prints the name of the Bitwarden item that holds the token and does not touch it: the
#      owner removes that item by hand.
#   4. Verify: the Worker is not listed, the zone has no DNS record for the hostname, and
#      https://vault.myargus.cc/health no longer answers from the Worker (the relay answered
#      that route with 200, or with 401 to a caller without its token). Up to 60 seconds, for DNS
#      and edge propagation. Exits non-zero if a check fails.
#
# The Cloudflare account and zone are the ones `cf` is logged in to (cf auth whoami); the script
# holds no account, zone or domain id. It reads and prints no secret value: `cf workers secrets
# list` returns names only, and the token itself is never fetched. It never calls promote.sh,
# never pushes `deploy` and dispatches no workflow.
set -euo pipefail

usage() { echo "usage: $0 [--dry-run]" >&2; exit 2; }

dry_run=0
case "${1:-}" in
  "") ;;
  --dry-run) dry_run=1 ;;
  *) usage ;;
esac
[ "$#" -le 1 ] || usage

WORKER="argus-vault-agent-relay"
HOST="vault.myargus.cc"
ZONE="myargus.cc"
SECRET_NAME="MCP_AUTH_TOKEN"
HEALTH_URL="https://${HOST}/health"
HEALTH_TRIES=6
HEALTH_WAIT_SECONDS=10

plan() { if [ "$dry_run" -eq 1 ]; then echo "[dry-run] $*"; else echo "+ $*"; fi; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

# ---------------------------------------------------------------------------------------------
# Pre-flight: read-only, also under --dry-run. Stops, changing nothing, on a missing prerequisite.
# ---------------------------------------------------------------------------------------------
preflight_failed=0
preflight_ok() { echo "pre-flight ok: $1"; }
preflight_fail() { echo "pre-flight FAILED: $1" >&2; preflight_failed=1; }
preflight_stop() {
  if [ "$preflight_failed" -ne 0 ]; then
    echo "pre-flight failed: nothing was changed." >&2
    exit 1
  fi
}

for tool in cf jq curl; do
  if command -v "$tool" > /dev/null 2>&1; then preflight_ok "$tool is on PATH"; else preflight_fail "$tool is not on PATH"; fi
done
preflight_stop

if [ "$(cf auth whoami 2> /dev/null | jq -r '.authenticated // false' 2> /dev/null || true)" = "true" ]; then
  preflight_ok "cf is logged in"
else
  preflight_fail "cf is not logged in (run: cf auth login)"
fi
preflight_stop

workers_json=""
if workers_json="$(cf workers list 2> /dev/null)" && jq -e 'type == "array"' <<< "$workers_json" > /dev/null 2>&1; then
  preflight_ok "cf can list the account's Workers"
else
  preflight_fail "cf cannot list the account's Workers"
fi
preflight_stop

# The relay's entry in the Worker list, or empty when it is gone.
relay_entry() {
  jq -c --arg name "$WORKER" '[.[] | select(.name == $name)][0] // empty' <<< "$1"
}
relay="$(relay_entry "$workers_json")"
durable_object="none"
if [ -n "$relay" ]; then
  if [ "$(jq -r '(.references.workers // []) | length' <<< "$relay")" = "0" ]; then
    preflight_ok "no other Worker references $WORKER"
  else
    preflight_fail "another Worker references $WORKER, so --delete-with-references is not safe"
  fi
  if [ "$(jq -r --arg host "$HOST" '[(.references.domains // [])[] | select(.hostname != $host)] | length' <<< "$relay")" = "0" ]; then
    preflight_ok "the only domain on $WORKER is $HOST"
  else
    preflight_fail "$WORKER holds a domain other than $HOST, so deleting it would take that domain too"
  fi
  durable_object="$(jq -r '[(.references.durable_objects // [])[].namespace_name] | join(", ") | if . == "" then "none" else . end' <<< "$relay")"
else
  preflight_ok "$WORKER is not listed (already gone)"
fi
preflight_stop

# ---------------------------------------------------------------------------------------------
# Steps
# ---------------------------------------------------------------------------------------------

dns_records() {
  # Prints one record id per line for HOST in the zone.
  cf dns records list -z "$ZONE" --name "$HOST" | jq -r '.[].id'
}

echo
echo "step 1: delete the Worker $WORKER and its Durable Object"
if [ -z "$relay" ]; then
  echo "  Worker $WORKER: already gone"
else
  echo "  Durable Object namespace removed with it: $durable_object"
  plan "cf workers delete $WORKER --force --delete-with-references"
  if [ "$dry_run" -eq 0 ]; then
    cf workers delete "$WORKER" --force --delete-with-references > /dev/null || die "cf workers delete $WORKER failed; nothing after it ran. Re-run the script once the error is cleared."
    relay=""
    workers_json="$(cf workers list)"
    if [ -n "$(relay_entry "$workers_json")" ]; then die "$WORKER is still listed after the delete"; fi
    echo "  Worker $WORKER: deleted"
  fi
fi

echo
echo "step 2: remove the custom domain $HOST and its DNS record"
if [ "$dry_run" -eq 1 ]; then
  records="$(dns_records)"
  if [ -z "$records" ]; then
    echo "  DNS record for $HOST: already gone"
  else
    plan "cf dns records delete <id> -z $ZONE   (the record for $HOST: runs only if it outlives the Worker delete)"
  fi
else
  records="$(dns_records)"
  if [ -z "$records" ]; then
    echo "  DNS record for $HOST: already gone"
  else
    while IFS= read -r record_id; do
      [ -n "$record_id" ] || continue
      plan "cf dns records delete $record_id -z $ZONE"
      if ! cf dns records delete "$record_id" -z "$ZONE" > /dev/null; then
        die "the DNS record for $HOST outlived the Worker and cf could not delete it (a Workers custom domain still owns it). Remove the custom domain $HOST in the Cloudflare dashboard (Workers & Pages, Domains & Routes, or the zone's DNS page), then re-run this script."
      fi
    done <<< "$records"
    echo "  DNS record for $HOST: deleted"
  fi
fi

echo
echo "step 3: delete the Worker secret $SECRET_NAME"
secret_present=0
if [ -n "$relay" ]; then
  if cf workers secrets list --worker "$WORKER" | jq -e --arg name "$SECRET_NAME" 'any(.[]; .name == $name)' > /dev/null 2>&1; then
    secret_present=1
  fi
fi
if [ "$secret_present" -eq 1 ]; then
  plan "cf workers secrets delete $SECRET_NAME --worker $WORKER   (a live run skips it when step 1 has already removed the Worker with its secret)"
  if [ "$dry_run" -eq 0 ]; then
    cf workers secrets delete "$SECRET_NAME" --worker "$WORKER" > /dev/null || die "cf workers secrets delete $SECRET_NAME failed"
    echo "  secret $SECRET_NAME: deleted"
  fi
else
  echo "  secret $SECRET_NAME: went with the Worker (it is bound to it), nothing left to delete"
fi
echo "  Bitwarden item: the one holding the relay's $SECRET_NAME (search Bitwarden for $SECRET_NAME or vault-agent-relay)."
echo "  Not touched here: delete that Bitwarden item by hand once step 4 passes."

echo
echo "step 4: verify"
verify_failed=0
verify_check() {
  # verify_check <description> <test command...>
  local description="$1"; shift
  if [ "$dry_run" -eq 1 ]; then
    echo "[dry-run] verify: $description"
  elif "$@" > /dev/null 2>&1; then
    echo "verify ok: $description"
  else
    echo "verify FAILED: $description" >&2
    verify_failed=1
  fi
}

worker_unlisted() { [ -z "$(relay_entry "$(cf workers list)")" ]; }
no_dns_record() { [ -z "$(dns_records)" ]; }
health_not_from_worker() {
  # The relay answered /health with 200 (token) or 401 (no token). Anything else, or no
  # answer at all (the hostname no longer resolves), is not the Worker.
  local try code
  for try in $(seq 1 "$HEALTH_TRIES"); do
    code="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 15 "$HEALTH_URL" 2> /dev/null || true)"
    case "$code" in
      200 | 401) [ "$try" -eq "$HEALTH_TRIES" ] || sleep "$HEALTH_WAIT_SECONDS" ;;
      *) return 0 ;;
    esac
  done
  return 1
}

verify_check "the Worker $WORKER is not listed" worker_unlisted
verify_check "the zone $ZONE has no DNS record for $HOST" no_dns_record
verify_check "$HEALTH_URL no longer answers from the Worker (health)" health_not_from_worker

echo
if [ "$dry_run" -eq 1 ]; then
  echo "dry run: nothing was changed."
  exit 0
fi
if [ "$verify_failed" -ne 0 ]; then
  echo "teardown ran, but a verify check failed (see above)." >&2
  exit 1
fi
echo "done: the vault-agent relay is torn down."
