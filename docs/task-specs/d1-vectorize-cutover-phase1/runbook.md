---
summary: "Operator runbook for the D1/Vectorize cutover: built and verified, not flipped"
read_when:
  - preparing or running the D1/Vectorize cutover
---

# D1/Vectorize cutover — operational runbook

Companion to [`design.md`](./design.md), which is authoritative for what the code
does. This file is authoritative for what a human does, in what order, on cutover
day ([argus#252](https://github.com/deanjstone/argus/issues/252), user story 20 —
"written down somewhere durable, not improvised live during cutover").

## Status: built, verified, **not flipped**

Every code path below exists and is tested. None of it is live.

The live system is on Supabase and stays there until someone deliberately runs
§5. That is not an oversight — it is the decision: build and verify the cutover,
leave the flip as a separate, consciously-taken step.

| Piece | State |
|---|---|
| mcp-memory Worker (D1 + Vectorize + Workers AI) | code merged (#249); **D1 provisioned** (`b0b36113-…`), schema applied, Vectorize + `deleted` metadata index created |
| watchtower Worker (D1) | code merged (#249); D1 database **already provisioned** (`615a149a-…`), migrations applied |
| stdio → Worker HTTP client | merged (#298), opt-in, unused |
| runtime scripts → Worker | merged, opt-in, unused |
| migration scripts + fail-closed verification | merged, unit- and fixture-tested. **Partially run against live data at some point** — see the warning below |
| `MEMORY_WORKER_URL` / `MEMORY_WORKER_TOKEN` | **unset on every machine** — this is the flip |

Verify the last row before doing anything else:

```bash
grep -c 'MEMORY_WORKER' ~/.argus/hooks/mcp-memory-launch.sh   # expect 0
env | grep -c MEMORY_WORKER                                    # expect 0
```

## 1. Provision the remaining Cloudflare resources

> **Already done — verified 2026-09-09. Do not re-run the create commands.**
>
> | Resource | State |
> |---|---|
> | D1 `argus-memory-mcp` | exists, `00000000-0000-4000-9000-000000000024` |
> | D1 `argus-watchtower` | exists, `00000000-0000-4000-b000-000000000012` |
> | Vectorize `argus-memory-mcp` | exists, 768 dims, cosine, created 2026-08-14 |
> | Vectorize metadata index | exists, `deleted` / Bool |
> | mcp-memory schema | applied — `memories`, `memories_fts`, `d1_migrations` |
>
> Kept below for reference and for rebuilding from scratch.

```bash
cd apps/memory-mcp

wrangler d1 create argus-memory-mcp
# → copy the returned database_id into wrangler.jsonc, replacing
#   "PLACEHOLDER-created-in-live-provisioning-phase"

wrangler vectorize create argus-memory-mcp --dimensions=768 --metric=cosine
wrangler vectorize create-metadata-index argus-memory-mcp \
  --property-name=deleted --type=boolean
```

### ⚠️ D1 already holds a stale partial copy — read before §3

Measured 2026-09-09:

```
memories       560 rows      newest updated_at 2026-08-14T05:12:23
memories_fts   560 rows      in sync with memories
Vectorize      0 vectors
```

Roughly 750 rows exist in Supabase, so this is a **partial snapshot frozen on the day
#249 merged, with no embeddings at all**.

**This is why §5 must not be run before §3.** Flipping against the current contents would
give every client ~560 of ~750 memories and a semantic search that returns nothing — the
one capability the cutover exists to deliver.

§3 is safe to run over this: the script is `INSERT OR REPLACE` keyed by the source row's
own id, so it tops up the missing rows and re-embeds. But the verification gate in §4 is
what proves it, and row-count parity is the check that catches exactly this.

The metadata index is what makes `filter: { deleted: false }` work. Without it
`services/d1.ts` degrades to unfiltered query + D1-side filtering — correct, but
it will return fewer than `topK` live results, so create it before migrating.

Then apply the schema:

```bash
wrangler d1 migrations apply argus-memory-mcp --remote
```

Secrets (`wrangler secret put`, from Bitwarden — never inline):

| Worker | Secret | Notes |
|---|---|---|
| `argus-memory-mcp` | `MCP_AUTH_TOKEN` | already exists; confirm it matches what clients hold, or rotate and redistribute |
| `argus-watchtower-api` | `WATCHTOWER_COLLECTOR_TOKEN` | new shared secret for the collector's write auth |
| `argus-watchtower-api` | `SUPABASE_JWT_SECRET` | the **myargus** project's own JWT secret, not a new one |

Workers AI needs no provisioning beyond account activation; the `ai` binding is
already declared.

## 2. Pause writes

```bash
ssh homelab 'systemctl --user stop watchtower-collector.service'
```

mcp-memory's write volume needs no explicit pause — just run §3 promptly.

## 3. Run the migrations

Both scripts are one-shot, safe to re-run (`INSERT OR REPLACE` keyed by the
source row's own id), and both **abort before cutover on any verification
failure**. They write through `wrangler d1 execute --remote` rather than the D1
REST API because the account's existing API tokens are scoped for Pages/Workers
deploy only.

**watchtower** — 220,006 rows, full backfill, no windowing:

```bash
cd apps/watchtower
SUPABASE_URL=… SUPABASE_SERVICE_ROLE_KEY=… \
D1_DATABASE_NAME=argus-watchtower \
WRANGLER_CONFIG_PATH=./wrangler.jsonc \
  npx tsx scripts/migrate-to-d1.ts
```

**mcp-memory** — ~750 rows, plus one Workers AI embedding call per row:

```bash
cd apps/memory-mcp
SUPABASE_URL=… SUPABASE_SERVICE_ROLE_KEY=… \
CLOUDFLARE_ACCOUNT_ID=… CLOUDFLARE_API_TOKEN=… \
D1_DATABASE_NAME=argus-memory-mcp \
VECTORIZE_INDEX_NAME=argus-memory-mcp \
WRANGLER_CONFIG_PATH=./wrangler.jsonc \
  npx tsx scripts/migrate-to-d1.ts
```

The mcp-memory script also retires every D1 row whose id is not live
in Supabase (argus#704): it soft-deletes the row with Supabase's own
`deleted_at` (the run's time if the row is gone from Supabase entirely) and
re-upserts its vector with `deleted: true`. Without that, row-count parity can
never pass over the stale copy described above. After the vector upsert it
waits up to 10 minutes for Vectorize to show every expected id, since upserts
apply asynchronously, then verifies.

`CLOUDFLARE_API_TOKEN` here must carry **Workers AI run** scope. The account's
existing Pages/Workers-deploy token does not — mint a dedicated one and store it
in Bitwarden first.

## 4. Verification gate

Verification runs automatically at the end of each migration and is fail-closed:
a non-zero exit means **do not proceed to §5**. It is not advisory output.

What each run checks (`scripts/verify.ts`, `verifyMigration`):

- [ ] **Row-count parity** — source vs. destination, live rows only.
- [ ] **Spot check** — field-by-field. mcp-memory checks every row (`key`,
      `content`, `type`, `content_hash`, and `tags` and `applies_to`
      order-independently, with NULL `applies_to` never equal to a list —
      argus#704); watchtower samples 25
      (`service_key`, `host`, `status`, `checked_at`, and `detail` as JSON).
- [ ] **FTS5 coverage** (mcp-memory) — every migrated row is present in
      `memories_fts`. #249's index is application-synced, so nothing in D1
      guarantees this and row-count parity cannot see the gap.
- [ ] **Vector coverage** (mcp-memory) — every row has a Vectorize vector,
      except ones the run itself logged as embedding failures.

A non-empty sample is itself required: an empty spot check is reported as a
failure, not a pass. The failure paths are exercised by
`apps/memory-mcp/test/workers/migrationVerification.test.ts` and
`apps/watchtower/test/migration-verification.test.ts`, which corrupt a fixture
destination one way at a time and assert the verifier catches each.

If verification fails, stop. Nothing downstream has moved yet; the old backend
is still authoritative and still being read.

## 5. The flip

Deploy both Workers against the now-real bindings:

```bash
cd apps/memory-mcp && wrangler deploy
cd apps/watchtower  && wrangler deploy
```

Then repoint the clients. **This is the irreversible-feeling step; everything
before it is additive.**

**stdio + the runtime scripts (WSL2, Windows, homelab)** — one change, and it is
literally two environment variables in `~/.argus/hooks/mcp-memory-launch.sh`:

```sh
export MEMORY_WORKER_URL="https://memory.myargus.cc"
export MEMORY_WORKER_TOKEN="<MCP_AUTH_TOKEN>"
```

`chooseMemoryBackend()` (`src/services/backendSelection.ts`, mirrored in
`scripts/memoryStore.ts`) returns `worker` only when **both** are set, so this
single edit moves the stdio server, the CONTEXT-sync SessionStart hook, the
snapshot exporter and todo sync/import all at once. Removing the two lines moves
them all back. Apply on all three machines — see the cross-env sync rule in
argus-config.

**watchtower collector (homelab systemd)** — swap
`SUPABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY` for:

```
WATCHTOWER_WORKER_URL=https://api.myargus.cc/watchtower
WATCHTOWER_COLLECTOR_TOKEN=<the §1 secret>
```

**watchtower dashboard** — `VITE_API_BASE_URL` must be
`https://api.myargus.cc` at build time (already set in
`.github/workflows/watchtower-deploy.yml`; previously dead, now load-bearing).

Then resume the collector:

```bash
ssh homelab 'systemctl --user start watchtower-collector.service'
```

## 6. Post-flip smoke test (manual, one-time)

Deliberately not automated — this is a single operational event, not a
regression suite (argus#252, Testing Decisions).

- [ ] From a fresh stdio Claude Code session: `memory_recall` a known key,
      `memory_search` a phrase you know matches, `memory_remember` a throwaway
      key and confirm the CONTEXT mirror file appears on disk.
- [ ] From Claude.ai via `memory.myargus.cc`: the same search returns results —
      this is the capability Claude.ai never had (no Ollama reachable).
- [ ] Start a new session and confirm the CONTEXT-sync hook logs
      `memory-sync (worker): N upserted` rather than `(supabase)`.
- [ ] watchtower dashboard loads, shows current status, and refreshes within
      ~18s.
- [ ] The collector's next scheduled write succeeds:
      `journalctl --user -u watchtower-collector -n 50`.

## 7. Rollback

The old Supabase tables are **left intact and untouched**. Nothing in this
work deletes them, and no deletion is planned.

For 1–2 weeks after cutover they are the active rollback path. Rolling back is a
config revert, not a data restore:

1. Remove the two `MEMORY_WORKER_*` exports from `mcp-memory-launch.sh` on all
   three machines.
2. Restore the collector's `SUPABASE_*` environment and restart it.
3. Redeploy the previous Worker revision if the Worker itself is the problem.

Rows written to D1 during the flipped window do not come back with you — that is
the cost of a hard cutover, and it is why the window is short and the smoke test
in §6 comes before anyone relies on it.

After the window, rollback monitoring stops. The Supabase tables stay as an
inert, undated backup.

## Known gaps, deliberately left

- `scripts/sync-bidirectional.ts` and `scripts/list-memories-first-prompt.mjs`
  still talk to Supabase directly. The former depends on the `LOCAL_SUPABASE_URL`
  fallback, which has no live consumer on WSL2 and no local Postgres to sync
  with; argus#252 asks for the same to be confirmed on Windows and homelab
  before deleting it. The latter is a one-off analysis script. Neither runs on a
  timer, so neither can break silently.
- `scripts/sync-files-to-supabase.ts` keeps its name after the port. Renaming it
  means editing the `SessionStart` hook path in `settings.json` on three
  machines — a live-config change, not a code change.
