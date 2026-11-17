# Research: watchtower schema dependencies + duplicate-repo check

Resolves [argus#245](https://github.com/deanjstone/argus/issues/245), part of wayfinder map [argus#242](https://github.com/deanjstone/argus/issues/242) (mcp-memory + watchtower: Supabase Postgres → SQLite).

## 1. Schema dependency audit

Source: `~/repos/argus/apps/watchtower/supabase/migrations/` — two files, both read in full.

### `0001_service_checks.sql`

```sql
create table public.service_checks (
  id uuid primary key default gen_random_uuid(),
  service_key text not null,
  host text not null,
  status text not null check (status in ('healthy', 'degraded', 'down', 'unreachable')),
  detail jsonb,
  checked_at timestamptz not null default now()
);

create index service_checks_key_time_idx
  on public.service_checks (service_key, checked_at desc);

alter table public.service_checks enable row level security;

-- Collector writes with the service-role key, which bypasses RLS entirely —
-- no insert policy is granted to any other role.

create policy "authenticated users can read service checks"
  on public.service_checks
  for select
  to authenticated
  using (true);
```

### `0002_service_checks_realtime.sql`

```sql
-- Enables the frontend dashboard (task-005) to subscribe to new service_checks rows
-- instead of polling on a fixed timer that's wrong for adapters with different intervals.
alter publication supabase_realtime add table public.service_checks;
```

### Findings, item by item

| Feature | Postgres-specific? | SQLite equivalent | Verdict |
|---|---|---|---|
| `gen_random_uuid()` default | Yes (pgcrypto, built into Supabase) | App-side UUID generation, or SQLite `lower(hex(randomblob(16)))` | Trivial — collector already generates the row, easy to move UUID generation to app code |
| `jsonb` column (`detail`) | Yes (binary JSON type) | `TEXT` column holding JSON text, optionally with SQLite's JSON1 functions | Trivial — no JSONB-specific operators are used anywhere in this schema (no `@>`, `->`, `#>>` in the migrations); it's stored and read back whole |
| `timestamptz` + `default now()` | Yes (tz-aware timestamp type) | `TEXT` (ISO-8601) with `default (datetime('now'))`, or `INTEGER` unix epoch | Trivial — collector/dashboard already treat everything as UTC; no timezone-conversion logic depends on the Postgres type |
| `check (status in (...))` | No — standard SQL | Native SQLite `CHECK` constraint | Directly portable, no change needed |
| Composite index `(service_key, checked_at desc)` | No — standard SQL | Native SQLite index | Directly portable, no change needed |
| `enable row level security` + one `select` policy for `authenticated`, `using (true)` | Yes (Postgres RLS) | No equivalent — SQLite has no row-level security | **Not a blocker, but needs a replacement.** This is *not* real per-row authorization — it's a blanket "any authenticated caller may read every row" gate (`using (true)`), functionally equivalent to a single `if (!authenticated) reject` check at the API boundary. The insert path already bypasses RLS entirely via the service-role key, i.e. writes were never RLS-governed to begin with. Moving to SQLite means this one gate has to move into the app/API layer (e.g. a Worker route requiring an authenticated session before querying) — straightforward, not a data-model problem. |
| `alter publication supabase_realtime add table ...` (Supabase Realtime) | Yes (Postgres logical replication, Supabase-managed) | No equivalent in plain SQLite | **The one genuine capability gap.** The frontend dashboard subscribes to this publication instead of polling (see `apps/watchtower/HANDOFF.md`: "Realtime-driven dashboard" was a deliberate task-005 design choice over a fixed-interval poll, because different adapters have different poll intervals). A SQLite-backed store has no built-in change-feed/pub-sub mechanism — this needs a designed replacement (e.g. short-interval polling, a WebSocket push from the collector process itself, or a Durable Object broadcasting on write) as part of the cutover, not merely a schema translation. |
| Triggers, stored procedures, other extensions | None found | — | Nothing else exists in either migration file — no triggers, no functions, no non-default extensions beyond the implicit pgcrypto UUID default. |

### Conclusion

The `service_checks` table itself is a **trivial single-table case** for a SQLite move — one table, no extensions, no triggers, no functions, and the RLS policy present is boilerplate-adjacent (a single blanket read gate, not real per-row authorization logic) that relocates cleanly to the app layer. The one thing that is **not** trivial and needs explicit design work in the cutover plan is **replacing Supabase Realtime** for the dashboard's live-update behavior, since that's a Postgres/Supabase platform feature with no SQLite equivalent. This should be called out as a task in the watchtower cutover work, not treated as a schema blocker.

## 2. Duplicate-repo check: `~/repos/watchtower` vs `~/repos/argus/apps/watchtower*`

### Verdict: `~/repos/watchtower` is a stale, superseded pre-migration copy — not actively diverged or independently used

Evidence:

**Git history shows an explicit subtree merge.** `~/repos/argus` git log (`git log --oneline --all | grep -i watchtower`) shows the standalone `deanjstone/watchtower` repo was subtree-merged into argus:

```
7c5134d Merge pull request #175 from deanjstone/chore/subtree-merge-watchtower
6763af2 chore: split watchtower into apps/watchtower, apps/watchtower-collector, apps/watchtower-usage-shim
```

Followed by continued, argus-only development after the merge:

```
fd9342e fix(watchtower-collector): restore PATH env in systemd unit (#177)
614ebb8 feat(watchtower): restore Cloudflare Pages auto-deploy from argus (#183)
1c35604 fix(watchtower): scope wrangler-action to apps/watchtower's own install (#184)
bb8b362 chore(bws): migrate watchtower apps to single ~/.bws_token (#229)
```

The most recent of these (`#229`, bws token migration) lands **2026-08-11** — three days after `~/repos/watchtower`'s last commit.

**`~/repos/watchtower`'s last commit is 2026-08-08**, a `chore(release): 1.0.1` bump, and nothing has landed since. Its only checked-out branch besides `main` with any distinct name, `research/agent-visibility-overlap-check`, is at the exact same commit as `main` (`git log main..research/agent-visibility-overlap-check` — empty) and was never pushed to `origin` — it's a dead local ref, not active work.

**Source is byte-identical where it still exists.** `diff -rq` between `~/repos/watchtower/collector/src` and `~/repos/argus/apps/watchtower-collector/src` shows **zero differences**. The only differences in the main app directory are expected artifacts of the split/migration: `.env` (local secret, gitignored), `pnpm-lock.yaml`/`pnpm-workspace.yaml` (workspace-root-only files, now irrelevant since watchtower is a package inside argus's own workspace), package name field (`watchtower` → `@argus/watchtower`), and `CHANGELOG.md`/`.releaserc.json` (independent semantic-release history per package). `~/repos/watchtower` additionally still has `collector/` and `usage-shim/` as subdirectories, which argus now correctly hosts as their own sibling packages (`apps/watchtower-collector`, `apps/watchtower-usage-shim`) per the explicit split commit above.

**The collector's systemd unit was fixed post-migration, only in argus.** `~/repos/argus/apps/watchtower-collector/systemd/watchtower-collector.service` sets an explicit `Environment=PATH=...` line (needed because the collector's systemd/ccusage adapters shell out to bare `systemctl`/`npx`) — this was PR #177, "restore PATH env in systemd unit," merged into argus after the migration. `~/repos/watchtower/collector/systemd/watchtower-collector.service` (the pre-migration copy) does **not** have this fix; it still points `ExecStart` at a version-pinned fnm path with no `PATH=` override. This is strong evidence the currently-correct, currently-deployed unit definition lives in argus, not the standalone repo.

**Homelab repo confirms watchtower is deliberately a separate, self-contained deployment — not something homelab's own compose/systemd tree owns.** `~/repos/homelab/docs/decisions/adr-004-monitoring-approach.md` (accepted 2026-07-21, predates the subtree merge) documents that `watchtower`'s collector "runs natively on homelab" via its own repo's deploy convention, and that homelab intentionally does not maintain a parallel monitoring stack or the watchtower deployment artifacts itself. No systemd unit, docker-compose service, or `.env` for watchtower exists anywhere under `~/repos/homelab` — the only two hits for "watchtower" in that repo are the ADR itself and one incidental reference in `services/quick-capture/server/src/routes/repos.ts` (a generic repo listing, not a deploy reference). This means homelab's repo can't be used to directly settle "which copy is live" (it was never the source of truth for that), but it corroborates that watchtower's deploy path is self-hosted within whichever watchtower repo is canonical — and the post-migration PRs in argus (#177 systemd fix, #183 CF Pages auto-deploy restore, #229 bws token consolidation) are the ones actively maintaining that deploy path today.

### Bottom line

`~/repos/watchtower` was the pre-migration standalone repo, subtree-merged into `~/repos/argus` as `apps/watchtower` + `apps/watchtower-collector` + `apps/watchtower-usage-shim` around 2026-08-08/09, and all real development since (systemd fixes, CI/deploy fixes, secrets consolidation) has happened only in argus. `~/repos/watchtower` is safe to treat as a stale duplicate for the purposes of the SQLite cutover work — the schema, collector code, and any future migration work should target `~/repos/argus/apps/watchtower/` and `~/repos/argus/apps/watchtower-collector/`, not the standalone repo. (This research did not delete or archive `~/repos/watchtower` — that's a separate decision for the map/orchestrating session, not made here.)
