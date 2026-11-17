# Task-002: Collector core and systemd adapters

> Historical task record. ccbot, mentioned below as a monitored unit, is decommissioned (argus#302, #382).

## 1. Specification (Human Authored)

- **Objective:** Stand up the homelab collector service skeleton and implement the first
  adapter family (local systemd units + homelab disk/uptime), per the inventory approved
  in task-001.
- **Requirements:**
  1. Collector runs as a native systemd user service on homelab (no Docker), matching
     `agent-engine`'s pattern (see SYSTEM.md).
  2. Collector polls each configured adapter on its own interval and writes health state
     somewhere queryable by the frontend (exact storage TBD in this task's plan — likely
     the shared myargus Supabase project, written via service-role key held only on
     homelab, never in the repo).
  3. Implement adapters for: systemd services (agent-engine, ccbot, ...), homelab
     disk-usage, homelab uptime — per task-001's health-signal/interval table.
  4. Each adapter reports one of: `healthy`, `degraded`, `down`, `unreachable` (the last
     reserved for cross-host/Tailscale adapters, not used by this task's local-only
     adapters).
- **Architectural Boundary:** Follow `.claude/SYSTEM.md` — pnpm only, TypeScript-first, no
  Docker, no new Supabase project/auth flow. Cloudflare/Supabase/Tailscale adapters and the
  frontend dashboard are explicitly out of scope (task-003/004/005).

## 2. AI Implementation Plan (AI Authored)

### Storage decision

Supabase Postgres table, not KV — the frontend (task-005) needs to query/filter by service
and time range, and RLS gives us read access control for free using the same passkey auth
already in place. A `service_checks` table (append-only history) plus a "latest per
service" query beats a KV blob because history is useful later (uptime %, flap detection)
without a schema change.

```sql
create table public.service_checks (
  id uuid primary key default gen_random_uuid(),
  service_key text not null,        -- e.g. 'systemd:agent-engine', 'homelab:disk'
  host text not null,               -- 'homelab', 'wsl2', 'windows', 'cloudflare', 'supabase'
  status text not null check (status in ('healthy','degraded','down','unreachable')),
  detail jsonb,                     -- adapter-specific payload (e.g. {"pct_used": 92})
  checked_at timestamptz not null default now()
);

create index service_checks_key_time_idx on public.service_checks (service_key, checked_at desc);

-- frontend reads latest state per service via:
-- select distinct on (service_key) * from service_checks order by service_key, checked_at desc;
```

RLS: insert is service-role only (collector's key, never exposed to the browser); select is
restricted to authenticated (passkey) users, matching the existing myargus auth pattern —
no anon read.

Retention/cleanup (e.g. pruning history older than N days) is explicitly deferred to a
follow-up task, not this one.

### Workspace layout

Collector becomes a second pnpm workspace package, `collector/`, sibling to the existing
Vite frontend at repo root. Update `pnpm-workspace.yaml`:

```yaml
packages:
  - .
  - collector
allowBuilds:
  esbuild: true
```

Collector is a plain Node/TypeScript process (no Vite, no React) — it never ships to the
browser, so it gets its own minimal `package.json`.

### Scope of changes

**Files to create:**
- `pnpm-workspace.yaml` (modify) — add `collector` as a workspace package
- `collector/package.json` — deps: `@supabase/supabase-js`; devDeps: `typescript`, `tsx`,
  `@types/node`
- `collector/tsconfig.json` — Node-target config (not the Vite app's `tsconfig.app.json`)
- `collector/.env.example` — `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SYSTEMD_UNITS`
  (comma-separated unit names)
- `collector/src/adapter.ts` — shared `HealthStatus`, `HealthResult`, `Adapter` types
- `collector/src/supabase-client.ts` — service-role client, fail-fast on missing env
  (mirrors `src/lib/supabase.ts`'s existing pattern)
- `collector/src/adapters/systemd.ts` — one adapter per configured unit, `systemctl --user
  show <unit> --property=ActiveState,SubState` via `child_process.execFile` (array args, no
  shell) — `ActiveState != "active"` → `down`. Confirmed on homelab: `agent-engine.service`
  is a user-level unit (`~/.config/systemd/user/agent-engine.service`), so all systemd
  adapters use `--user`, no sudo needed. `ccbot.service` is kept as a configured stub — it
  has no systemd unit on homelab yet (checked directly: not in `systemctl --user
  list-unit-files`, no matching process), so it's expected to report `down`/error until
  ccbot is actually deployed as a unit there. That's a pre-existing gap, not something this
  task fixes.
- `collector/src/adapters/disk.ts` — `fs.promises.statfs('/')`, >90% used → `degraded`
- `collector/src/adapters/uptime.ts` — reads `/proc/uptime` (informational, always
  `healthy`; exists so the dashboard can show host uptime, no failure condition)
- `collector/src/poller.ts` — runs each adapter on its own `intervalMs`, catches adapter
  exceptions and records them as `status: 'down'` with the error in `detail` rather than
  crashing the process, upserts each result via the Supabase client
- `collector/src/index.ts` — entrypoint: builds the static adapter list from env config,
  starts the poller, handles `SIGTERM`/`SIGINT` for graceful shutdown
- `collector/systemd/watchtower-collector.service` — unit file template (`ExecStart=node
  dist/index.js`, `Restart=on-failure`, `EnvironmentFile=`) for manual install on homelab,
  matching `agent-engine`'s deployment pattern; installation itself is a deploy-time step,
  not something the repo automates
- `supabase/migrations/0001_service_checks.sql` — the schema above, applied manually via
  Supabase MCP/dashboard against the shared myargus project (not auto-run by CI)

**Files to modify:**
- `pnpm-workspace.yaml` — add `collector` package entry

**Files to delete:** none

**Files NOT touched:** `src/` (frontend/dashboard — task-005), Cloudflare/Supabase-project/
Tailscale adapters (task-004/003 boundary per task-001's split)

### Step-by-step execution plan

**Step 1 — Open questions (resolved 2026-07-11, checked directly on homelab)**
(a) `agent-engine` is a user-level systemd unit; `ccbot` has no unit there at all —
adapters use `systemctl --user`, and `ccbot.service` is kept as a stub expected to report
`down` until it's deployed. (b) homelab's default Node (via fnm) is v22.23.1, well above
the v18.15 floor for `fs.promises.statfs` — no `df` fallback needed.

**Step 2 — Workspace scaffold**
Add `collector` to `pnpm-workspace.yaml`, create `collector/package.json` and
`collector/tsconfig.json`, run `pnpm install` to verify the workspace resolves.

**Step 3 — Shared types and Supabase client**
`collector/src/adapter.ts` (types) and `collector/src/supabase-client.ts` (service-role
client, fail-fast on missing env, matching existing frontend client's shape).

**Step 4 — Adapters**
Implement `systemd.ts`, `disk.ts`, `uptime.ts` against the `Adapter` interface. Each is a
small, independently testable module with no shared mutable state.

**Step 5 — Poller and entrypoint**
`poller.ts` schedules and upserts; `index.ts` wires the static adapter list from env and
starts the poller with graceful shutdown handling.

**Step 6 — Supabase schema**
Apply `supabase/migrations/0001_service_checks.sql` to the myargus project (via Supabase
MCP `apply_migration`), confirm RLS policies with `get_advisors`.

**Step 7 — systemd unit + manual smoke test**
Write `collector/systemd/watchtower-collector.service`, build (`pnpm --filter collector
build`), run manually on homelab against the real systemd units/disk, confirm rows land in
`service_checks` with correct status transitions (stop a unit, confirm `down` is recorded).

### Risks / tradeoffs

- `execFile` (not `exec`) for `systemctl show` avoids shell-injection risk even though unit
  names come from trusted env config, not user input — cheap to do correctly from the start.
- Insert-only history table has unbounded growth; retention policy is deferred, but flagged
  here so it isn't forgotten before this ships to always-on production use.
- Disk/uptime adapters are Linux-only (`/proc/uptime`, POSIX `statfs`) — acceptable since the
  collector only ever runs on homelab (Ubuntu), per SYSTEM.md.
- Service-role key must reach homelab via Bitwarden at deploy time (per task-001 decision),
  never via `collector/.env` committed to the repo — only `.env.example` is tracked.

## 3. Human Approval Sign-off

- **Status:** Approved (2026-07-11)
- **Director Review Notes:** systemd/ccbot/Node open questions resolved directly against
  homelab. Plan approved; proceed with implementation.

## 4. Verification Checklist (AI Completed)

- [x] Collector runs locally on homelab and reports systemd/disk/uptime state — manual run
  (2026-07-11) reported agent-engine healthy, ccbot.service down (no unit exists, as
  expected), disk 20% used healthy, uptime healthy; graceful shutdown on SIGTERM confirmed
- [x] State is written somewhere the frontend can later read — 4 rows confirmed in
  `service_checks` via direct query, detail payloads correct per adapter
- [x] No credentials committed to repo — `collector/.env` created only on homelab
  (gitignored), service-role key sourced from new Bitwarden item
  `SupaBase: myargus (service_role)`, never written to the repo
- [x] TypeScript compiles with no errors — `pnpm --filter watchtower-collector build` clean,
  both locally and on homelab
