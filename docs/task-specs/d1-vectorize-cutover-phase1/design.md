---
summary: Phase 1 (code-only) design for moving memory-mcp and watchtower to D1 + Vectorize
read_when:
  - working on the D1/Vectorize migration
---

# D1/Vectorize migration — Phase 1 (code-only)

> **Update ([#1173](https://github.com/deanjstone/argus/issues/1173)):** `apps/email-worker` and `apps/email-mcp`, named below as the D1 precedent, are gone from this repo; the shared inbox lives in [`deanjstone/email`](https://github.com/deanjstone/email). Paths below are history.

## Context

Wayfinder map [argus#242](https://github.com/deanjstone/argus/issues/242) decided (via `/grilling`,
same session) that mcp-memory (`apps/memory-mcp`) moves from Supabase Postgres to Cloudflare D1 +
Vectorize + Workers AI ([#243](https://github.com/deanjstone/argus/issues/243)), and watchtower
(`apps/watchtower` + `apps/watchtower-collector`) moves `service_checks` to D1 with Supabase
Realtime replaced by client-side polling and Supabase Auth kept, split from storage
([#247](https://github.com/deanjstone/argus/issues/247)). Both decisions are architecture-level —
neither ticket specified file-level implementation, and no code has been written yet.

This is **Phase 1: code only.** Explicitly excludes: provisioning real Cloudflare resources
(D1 databases, Vectorize index, Workers AI activation, DNS routes) against the live account,
migrating real Supabase data, reconfiguring any live client (WSL2/Windows/homelab stdio, the
watchtower collector's real deployment), and any production cutover. Everything here is
locally buildable and testable (`wrangler dev` + `vitest` via `@cloudflare/vitest-pool-workers`)
and inert until a later, separately-approved phase deploys it. The user explicitly chose this
scope (both services, code+tests only) over a narrower mcp-memory-only slice.

Conventions below reuse what's already established in this repo by `apps/email-worker` +
`apps/email-mcp` — the only existing D1-backed Workers here — rather than inventing new
patterns: raw `env.DB.prepare(sql).bind(...).run()/.first()/.all()` (no ORM, no forced
transactions), `wrangler.jsonc` with inline `//` comments marking placeholder IDs as "created
in a later live-provisioning phase", Hono `app.all("/mcp", ...)` with the existing conditional-
bearer `MCP_AUTH_TOKEN` pattern, `wrangler types` (not `@cloudflare/workers-types`) for ambient
binding types, `@cloudflare/vitest-pool-workers ^0.20.3` + `readD1Migrations()` with a
`test/apply-migrations.ts` setup file and per-file `beforeEach` table clearing.

Four open design questions were resolved with the user before finalizing this plan:
- **watchtower read auth**: JWT-verify the dashboard's existing Supabase session in the new
  Worker (not a second shared-token credential).
- **watchtower Worker route**: `api.myargus.cc/watchtower/*` — reuses the `VITE_API_BASE_URL`
  value already hardcoded (but currently unused/dead) in
  `.github/workflows/watchtower-deploy.yml`, rather than minting a new hostname.
- **mcp-memory search**: keep FTS5 alongside Vectorize (resilience + exact-token recall), not
  Vectorize-only.
- **`services/supabase.ts`**: stays alive, stdio-only, for this phase — local Claude Code
  sessions keep working against Supabase unchanged until a later phase repoints stdio at the
  Worker.

---

## 1. mcp-server (apps/memory-mcp)

### 1.1 D1 schema — `apps/memory-mcp/migrations/0001_init.sql` (new dir, mirrors email's)

```sql
-- id: SQLite has no gen_random_uuid(); generate via crypto.randomUUID() in the Worker
-- and bind it on INSERT. TEXT PRIMARY KEY (not INTEGER) so the app-assigned uuid is
-- also the Vectorize vector ID (see 1.2) — one join key across both stores.
CREATE TABLE memories (
  id          TEXT PRIMARY KEY,
  key         TEXT NOT NULL UNIQUE,
  content     TEXT NOT NULL,
  tags        TEXT NOT NULL DEFAULT '[]',   -- JSON array, e.g. '["project","argus"]'
  type        TEXT CHECK (type IN ('user','feedback','project','reference')),
  created_at  TEXT NOT NULL,                -- ISO 8601, app-set (no now() in SQLite DML)
  updated_at  TEXT NOT NULL,
  deleted_at  TEXT
);

CREATE INDEX idx_memories_key ON memories (key);
CREATE INDEX idx_memories_deleted_at ON memories (deleted_at) WHERE deleted_at IS NOT NULL;

-- Standalone FTS5 table (email precedent's pattern, not external-content — memories.id
-- is a TEXT uuid, not an INTEGER rowid, so external-content's content_rowid mapping
-- doesn't apply cleanly). `id` stored UNINDEXED purely as the join key back to memories;
-- app code keeps it in sync explicitly — no generated-column equivalent exists in SQLite.
CREATE VIRTUAL TABLE memories_fts USING fts5(id UNINDEXED, key, content, tags);

-- "Only bump updated_at if caller didn't set it explicitly" (matches Postgres migration
-- 003's smart trigger — needed so sync upserts preserving source timestamps don't
-- ping-pong). BEFORE triggers can't assign NEW columns directly in SQLite, so this fires
-- AFTER and re-UPDATEs; the WHEN guard means the resulting internal UPDATE's OLD/NEW no
-- longer match, so it does not re-fire.
CREATE TRIGGER memories_updated_at
AFTER UPDATE ON memories
WHEN NEW.updated_at IS OLD.updated_at
BEGIN
  UPDATE memories SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = NEW.id;
END;
```

- `tags` containment (today's `.contains("tags", [tag])`) → D1's JSON1 extension:
  `WHERE EXISTS (SELECT 1 FROM json_each(tags) WHERE value = ?)`. No junction table.
- Soft-delete preserved exactly: `deleted_at TEXT`, all reads add `WHERE deleted_at IS NULL`,
  `deleteMemory` sets it, `upsertMemory` resurrects (NULLs it back out).
- `type` enum → `CHECK` constraint (same four values as Postgres migration 006, nullable).
- Existing Postgres RPC `search_memories_semantic` has a known column-drift bug (its return
  omits `type`, unlike `MEMORY_COLUMNS` used elsewhere). The D1/Vectorize replacement (1.2)
  does not inherit this — its D1 hydration step selects the full column set.

### 1.2 Vectorize index design

- **Model**: `@cf/baai/bge-base-en-v1.5` (Workers AI text embedding, 768-dim, cosine-tuned) —
  chosen over `bge-small` (384-dim, less accurate) and `bge-large` (1024-dim, ~3x cost/latency
  for marginal gain on short memory-note text). Confirm during implementation whether
  bge-base needs asymmetric query/passage prefixing the way nomic-embed-text did
  (`search_document:`/`search_query:`) — check the model card rather than blindly porting it.
- **Index config** (wrangler.jsonc): `dimensions: 768`, `metric: "cosine"`.
- **Vector ID** = `memories.id` — one join key, no separate mapping table.
- **Metadata**: `{ deleted: false }` on every vector; `memory_forget` flips it via re-upsert
  (not vector deletion), keeping D1/Vectorize soft-delete state symmetric. Query uses
  `filter: { deleted: false }`, degrading gracefully to unfiltered + D1-side filtering if the
  metadata index (created at live-provisioning time, not this phase) doesn't exist yet.
- **Query translation** (`search_memories_semantic` RPC → two-step Vectorize + D1):
  1. `env.VECTORIZE.query(queryEmbedding, { topK: limit, filter: { deleted: false } })` →
     `{ id, score }[]`.
  2. `SELECT <columns> FROM memories WHERE id IN (...) AND deleted_at IS NULL`, reorder D1
     rows back into Vectorize's score order client-side (SQL `IN` doesn't preserve order),
     attach `similarity: score`.
  3. No special retry if hydration comes back short after filtering — accepted v1 tradeoff,
     same spirit as email's own accepted-tradeoff note in `db.ts`.

### 1.3 Worker code structure — `apps/memory-mcp/src/`

- **`services/d1.ts` (new)** — replaces `services/supabase.ts` as the *Worker's* data layer.
  Same six exported signatures (`upsertMemory`, `getMemoryByKey`, `searchMemories`,
  `listMemories`, `deleteMemory`, `getAllMemories`) so `tools/memory.ts` only changes its
  import path. `setBindings(env)` setter mirrors today's `setRemoteClient()` pattern. Takes
  `D1Database` + a `VectorSearchClient` interface (see 1.5 — DI seam for testing, real
  `Vectorize` binding + `Ai` binding wired in `worker.ts`). `upsertMemory` generates `id` via
  `crypto.randomUUID()`, sets timestamps in JS, writes `memories` row + `memories_fts` row
  (delete-then-insert) + the vector, unconditionally (not gated behind an `isEmbeddingEnabled()`
  check the way stdio's Ollama path is — Workers AI is always available in a Worker).
  `deleteMemory` soft-deletes the D1 row and flips the vector's `deleted` metadata; does not
  purge the FTS row (matches Postgres' own non-purging index behavior on soft delete).
- **`services/embedding.ts`** — new Worker-side function calling
  `env.AI.run("@cf/baai/bge-base-en-v1.5", { text: [...] })`. Existing stdio-only Ollama path
  in this same file stays untouched (per the `supabase.ts` decision, this phase doesn't touch
  stdio's runtime behavior).
- **`worker.ts`** — `Env` gains `DB: D1Database`, `VECTORIZE: Vectorize`, `AI: Ai`; drops
  `SUPABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY`. `GET /health` → `SELECT id FROM memories LIMIT 1`
  via `c.env.DB`. `app.all("/mcp", ...)` unchanged in shape — same conditional-bearer
  `MCP_AUTH_TOKEN` check, calls the new setter.
- **`tools/memory.ts`** — only its import line changes.
- **`index.ts` (stdio)** — unchanged this phase; keeps using `services/supabase.ts` since
  D1/Vectorize/Workers AI are Worker-binding-only (no bindings exist outside a Worker
  context). Net effect: `services/supabase.ts` is **not deleted**, but its `setRemoteClient()`
  export/CF-facing comments should be dropped since `worker.ts` stops calling it — call this
  out explicitly in the PR description so it doesn't read as an incomplete migration.
- **`types.ts`** — drop `embedding` from `MemoryRow` (lives in Vectorize now, not a D1 column).

**No changes**: `tests/contextMirror.test.ts`, `tools/sessionIndex.ts`, `tools/contextImport.ts`
(stdio/filesystem-only, already never registered in `worker.ts`).

### 1.4 `apps/memory-mcp/wrangler.jsonc` (new — replaces `wrangler.toml`)

```jsonc
{
  "$schema": "./node_modules/wrangler/config-schema.json",
  "name": "argus-memory-mcp",
  "main": "src/worker.ts",
  "compatibility_date": "2026-08-01",
  "compatibility_flags": ["nodejs_compat"],
  "routes": [{ "pattern": "memory.myargus.cc/*", "zone_name": "myargus.cc" }],
  "placement": { "mode": "smart" },
  "observability": { "enabled": true },

  // D1: memories table + FTS5 index. Real database, created in a later
  // live-provisioning phase via `wrangler d1 create argus-memory-mcp`.
  "d1_databases": [{
    "binding": "DB",
    "database_name": "argus-memory-mcp",
    "database_id": "PLACEHOLDER-created-in-live-provisioning-phase",
    "migrations_dir": "./migrations"
  }],

  // Vectorize: semantic search over memory embeddings. Real index, created in
  // a later live-provisioning phase via `wrangler vectorize create
  // argus-memory-mcp --dimensions=768 --metric=cosine`, followed by
  // `wrangler vectorize create-metadata-index argus-memory-mcp
  // --property-name=deleted --type=boolean`.
  "vectorize": [{ "binding": "VECTORIZE", "index_name": "argus-memory-mcp" }],

  // Workers AI: generates embeddings for every memory (upsert + query), inside
  // the Worker — replaces stdio-only Ollama for all remote/CF-routed clients.
  "ai": { "binding": "AI" }

  // Secrets — set via `wrangler secret put` in a later live-provisioning phase:
  //   wrangler secret put MCP_AUTH_TOKEN
}
```

`package.json`: add `"pretypecheck": "wrangler types"`, drop `@cloudflare/workers-types`
devDependency, add `@cloudflare/vitest-pool-workers ^0.20.3` (matches installed `vitest ^4.1.9`).

### 1.5 Tests

`apps/memory-mcp/vitest.config.ts` + `test/apply-migrations.ts` (copy email's pattern
verbatim, adjust `configPath`). New `test/d1.test.ts` covering `services/d1.ts`'s six functions
against simulated D1, `beforeEach` clearing `memories`/`memories_fts`.

**Vectorize limitation**: `@cloudflare/vitest-pool-workers` does not simulate Vectorize
locally the way it does D1/KV/R2/DO. Inject a thin `VectorSearchClient` interface
(query/upsert methods) into `services/d1.ts` so tests pass a fake in-memory cosine-similarity
implementation while `worker.ts` wires the real `c.env.VECTORIZE` binding in production —
standard DI workaround for a known gap. D1 + FTS5 portions of `searchMemories()` test fully
against real simulated D1.

---

## 2. watchtower (apps/watchtower + apps/watchtower-collector)

### 2.1 D1 schema — `apps/watchtower/migrations/0001_service_checks.sql` (lives in the
frontend package since that's where the new Worker goes, 2.3)

```sql
CREATE TABLE service_checks (
  id          TEXT PRIMARY KEY,             -- crypto.randomUUID(), app-assigned
  service_key TEXT NOT NULL,
  host        TEXT NOT NULL,
  status      TEXT NOT NULL CHECK (status IN ('healthy','degraded','down','unreachable')),
  detail      TEXT,                          -- JSON, nullable (was jsonb)
  checked_at  TEXT NOT NULL                  -- ISO 8601, app-set on insert
);

CREATE INDEX idx_service_checks_key_time ON service_checks (service_key, checked_at DESC);
```

No soft-delete needed (straight structural translation). `0002_service_checks_realtime.sql`
is **not ported** — its only effect (adding the table to `supabase_realtime`) has no D1
equivalent and is superseded by polling.

**Read auth (resolved with user)**: JWT-verify the dashboard's existing Supabase session
token server-side in the new Worker (signature check against the project's JWT secret as a
Worker secret — no round-trip to Supabase, no new credential for the dashboard).

### 2.2 watchtower-collector changes

- `src/supabase-client.ts` **deleted**, replaced by `src/worker-client.ts` (new) — minimal
  `fetch()`-based client, drops `@supabase/supabase-js` from this package entirely. Exports
  `recordCheck(input: {service_key, host, status, detail?}): Promise<void>` — `POST` to
  `${WATCHTOWER_WORKER_URL}/checks` with `Authorization: Bearer <WATCHTOWER_COLLECTOR_TOKEN>`
  (new env var — static shared secret is the right fit for a trusted homelab systemd service,
  distinct from 2.1's JWT question which is about the *browser* session). Throws on non-2xx,
  matching today's fail-fast-at-import-time style.
- `src/poller.ts` — the insert call becomes `await recordCheck({...})`; `runCheck`/
  `startPolling` orchestration (try/catch, `console.log`, `setInterval`) unchanged.
- `src/adapters/*.ts` (all seven) — **untouched**, no dependency on the storage layer.
- `index.ts` — only startup env-var validation changes (`SUPABASE_URL`/
  `SUPABASE_SERVICE_ROLE_KEY` → `WATCHTOWER_WORKER_URL`/`WATCHTOWER_COLLECTOR_TOKEN`).

Write endpoint: `POST /checks`, bearer auth (mcp-server's exact conditional-check pattern),
body `{service_key, host, status, detail?}` (today's exact insert shape), server generates
`id`/`checked_at` itself (matches today's DB-default invariant for `checked_at`), `204`/
`401`/`400` responses.

### 2.3 watchtower frontend changes + new Worker

`apps/watchtower` currently has no wrangler config at all (Pages-only, `pages deploy dist`).
This phase adds a sibling Worker for the data API — for parity with mcp-server/email-mcp's
established Hono pattern rather than introducing Pages Functions as a second, different
serverless-handler convention. The Pages static deploy is unaffected.

New files:
- `apps/watchtower/wrangler.jsonc` — `name: "argus-watchtower-api"`, `main: "src/worker/index.ts"`,
  D1 binding (`DB`, `database_name: "argus-watchtower"`, placeholder `database_id`, same
  live-provisioning-phase comment convention). Route (**resolved with user** — reuses the
  hostname already hardcoded but currently dead in `.github/workflows/watchtower-deploy.yml`'s
  `VITE_API_BASE_URL`):
  ```jsonc
  "routes": [{ "pattern": "api.myargus.cc/watchtower/*", "zone_name": "myargus.cc" }]
  ```
- `apps/watchtower/src/worker/index.ts` (new) — Hono app with `.basePath("/watchtower")`
  (required — Workers Routes deliver the full matched path, not stripped; same reason
  email-mcp uses `.basePath("/email")`). `POST /checks` (2.2's write endpoint) and
  `GET /checks` (read endpoint) — `SELECT ... ORDER BY checked_at DESC LIMIT 500` reduced to
  latest-per-key **in SQL** now:
  ```sql
  WHERE checked_at = (
    SELECT MAX(checked_at) FROM service_checks sc2 WHERE sc2.service_key = sc.service_key
  )
  ```
  rather than porting `useServiceChecks.ts`'s client-side `latestPerKey()` workaround for
  Postgres' `DISTINCT ON` — D1 can express this directly, and there's no realtime stream left
  to reconcile against.
- `apps/watchtower/src/hooks/useServiceChecks.ts` — rewritten: drop the `postgres_changes`
  subscription and `latestPerKey()` reduction (now server-side); add
  `setInterval(loadChecks, 18_000)` fetching `${WORKER_URL}/watchtower/checks` with
  `Authorization: Bearer <session.access_token>` from the existing `lib/supabase.ts` client's
  `supabase.auth.getSession()` — the one place this migration and the kept-as-is Supabase Auth
  flow touch. Returned `{checks, loading}` shape stays identical — no caller changes needed.

**No changes**: `Dashboard.tsx`, `ServiceCard.tsx`, `StatusPill.tsx` (all consume `{checks,
loading}`, don't know the source changed); `lib/supabase.ts`, `App.tsx`, `SignIn.tsx`,
`PasskeyGate.tsx` (untouched per #247 — auth stays exactly as-is).

### 2.4 Tests

- `apps/watchtower/vitest.config.ts` + `test/apply-migrations.ts` (email pattern).
- `test/checks-worker.test.ts` (new) — `POST /checks` bearer auth reject/accept + row shape,
  `GET /checks` latest-per-key SQL correctness (multi-row-per-key fixture) + JWT auth
  reject/accept, against real simulated D1. No Vectorize/Workers AI here, so 1.5's mocking
  caveat doesn't apply.
- `apps/watchtower-collector/test/worker-client.test.ts` (new) — `recordCheck()` request
  shape/error handling against a mocked `fetch` (plain `vi.fn()`, not vitest-pool-workers —
  this package has no D1/Worker of its own to simulate).

---

## 3. Sequencing (TDD at each seam per `/tdd` — write the failing test before the implementation)

1. mcp-server D1 schema (1.1).
2. mcp-server `services/d1.ts` D1-only functions (getMemoryByKey/listMemories/getAllMemories,
   non-vector halves of upsert/delete) — correct against simulated D1 before layering Vectorize.
3. mcp-server Vectorize + Workers AI layer (embedding.ts, vector-touching upsert/delete/search,
   the `VectorSearchClient` DI seam + fake).
4. mcp-server `worker.ts` rewire + wrangler.jsonc + package.json.
5. mcp-server tests (interleaved with 2-4 per TDD, `d1.test.ts` finalized here).
6. watchtower D1 schema (2.1).
7. watchtower new Worker, both endpoints — collector and frontend both depend on it existing.
8. watchtower-collector HTTP client (2.2).
9. watchtower frontend polling rewrite (2.3).
10. watchtower tests (`worker-client.test.ts` can run parallel to step 9, right after step 8).

**Explicitly not touched anywhere in this phase**: mcp-server's `tests/contextMirror.test.ts`,
`tools/sessionIndex.ts`, `tools/contextImport.ts`; watchtower's `Dashboard.tsx`,
`ServiceCard.tsx`, `StatusPill.tsx`, `lib/supabase.ts`, `App.tsx`, `SignIn.tsx`,
`PasskeyGate.tsx`; all seven watchtower-collector adapters' `check()` implementations; any
live Cloudflare resource (D1 DB, Vectorize index, Workers AI activation, DNS route) — every
wrangler.jsonc entry this phase writes is a placeholder.

---

## Verification

- `pnpm --filter @argus/mcp-server run typecheck` and `pnpm --filter @argus/watchtower run
  typecheck` (and watchtower-collector's, if it gains a typecheck script) after each file group.
- `pnpm --filter @argus/mcp-server run test` — `d1.test.ts` (+ existing `contextMirror.test.ts`
  must still pass unmodified) via `@cloudflare/vitest-pool-workers`.
- `pnpm --filter @argus/watchtower run test` — `checks-worker.test.ts`.
- `pnpm --filter @argus/watchtower-collector run test` — `worker-client.test.ts`.
- `wrangler dev` (local, no `--remote`) for both new/changed Workers — confirm they boot
  without error against the placeholder wrangler.jsonc (D1 simulated locally works with
  placeholder `database_id`; Vectorize/AI bindings will not function under plain local `dev`
  without `--remote`, which is out of scope this phase — booting without a crash is the bar).
- Full workspace `pnpm -r run typecheck` once at the end to catch any cross-package fallout
  (e.g. `@argus/watchtower-collector` dropping `@supabase/supabase-js` from its deps).
- `/spec-review` against this plan file once implementation is complete, before committing.
