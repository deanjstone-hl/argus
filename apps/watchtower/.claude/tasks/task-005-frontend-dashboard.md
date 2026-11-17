# Task-005: Frontend dashboard

## 1. Specification (Human Authored)

- **Objective:** Build the read-only dashboard that shows current health for every adapter
  polled by the collector (systemd, disk, uptime, Syncthing, Cloudflare, Supabase — plus
  Duplicati once task-003 unblocks), reading from the `service_checks` table task-002's
  poller already writes to.
- **Requirements:**
  1. Passkey sign-in gate, reusing the shared myargus Supabase project and the established
     "copy locally" auth pattern (see below) — no new auth flow, no shared auth package.
  2. One card/row per distinct `service_key`, showing latest `status`, `host`, `detail`,
     and how long ago `checked_at` was, grouped by host (homelab / cloudflare / supabase /
     cross-host).
  3. Status colour-coding for `healthy` / `degraded` / `down` / `unreachable` — four
     distinct states, not a binary up/down; `unreachable` must read visually distinct from
     `down` (per the reachability semantics task-001 established — a sleeping laptop isn't
     an incident).
  4. Live-ish refresh (poll Supabase on an interval or use Supabase Realtime — implementer's
     call, document the choice) — no manual refresh-only dashboard.
  5. Visually consistent with myargus.cc's `DESIGN.md` tokens (dark-first, `#EF4444`
     watchtower accent per `project_per_project_colours`), copied in as this repo already
     does per `.claude/SYSTEM.md` — not a package dependency.
- **Architectural Boundary:** Follow `.claude/SYSTEM.md`. Read-only against `service_checks`
  — the frontend never writes to it (collector already does, via service-role key it holds
  independently). No new Supabase project, no custom auth. CI/deploy wiring (CF Pages) is
  in scope only as far as getting a working `pnpm run build` — actual Pages project
  creation/deploy pipeline can be its own follow-up if Director wants it split out.

**Existing scaffold (confirmed 2026-07-11, already on `main`, not from this task):**
- `src/App.tsx`, `src/lib/supabase.ts`, `src/main.tsx`, `src/index.css` — placeholder only
  ("scaffold only" text), Supabase client already wired to `VITE_SUPABASE_URL` /
  `VITE_SUPABASE_ANON_KEY`, no auth yet.
- `supabase/migrations/0001_service_checks.sql` — `service_checks` table already live:
  `service_key`, `host`, `status` (checked against the 4-value enum), `detail jsonb`,
  `checked_at`. RLS enabled, `select` granted to `authenticated` role only — matches
  requirement 1's passkey gate (an anon/unauthenticated visitor gets zero rows back, which
  is the intended failure mode, not a bug to work around).
- `package.json` already has `react`, `react-dom`, `@supabase/supabase-js`, Tailwind v4
  (`@tailwindcss/vite`) as dependencies — no new frontend framework choices to make.

**Passkey auth reuse (surveyed 2026-07-11):** No shared auth package exists anywhere in the
myargus ecosystem — every app (`shell`, `reader`, `knowledge`) copy-pastes its own
`SignIn.tsx` / `PasskeyGate.tsx` / `App.tsx` guard logic locally, which is the established
convention here, not a gap to fix. Auth uses Supabase's **native built-in passkey support**
(`createClient(url, key, { experimental: { passkey: true } })`, then
`supabase.auth.signInWithPasskey()` / `registerPasskey()` / `passkey.list()`) — not
`@simplewebauthn/browser`, no custom edge functions, no WebAuthn ceremony code to write.
Template files to copy from, in `~/repos/myargus`:
- `apps/shell/src/lib/supabase.ts` — client creation with the passkey experimental flag.
- `apps/shell/src/pages/SignIn.tsx` — passkey button + magic-link fallback.
- `apps/shell/src/components/PasskeyGate.tsx` — post-login enrollment screen shown when
  `passkey.list()` returns zero.
- `apps/shell/src/App.tsx` — session state (`getSession()` + `onAuthStateChange`) and route
  guard logic (unauthenticated → sign-in; zero passkeys → `PasskeyGate`; else → dashboard).

RP ID (`myargus.cc`) is a Supabase project-level Auth setting, not app config — nothing to
configure per-app for this.

## 2. AI Implementation Plan (AI Authored)

### Scope of changes

**Files to create:**
- `src/lib/supabase-auth.ts` (or extend existing `src/lib/supabase.ts`) — add the
  `experimental: { passkey: true }` client option; existing file only has the plain client.
- `src/pages/SignIn.tsx` — adapted from `apps/shell`'s version, watchtower branding
  (`#EF4444` accent instead of shell's `#eab308`).
- `src/components/PasskeyGate.tsx` — adapted from `apps/shell`'s version.
- `src/hooks/useServiceChecks.ts` — fetches latest `service_checks` row per `service_key`
  (Supabase `select` with `order by checked_at desc` + client-side de-dupe by key, since
  Postgres `DISTINCT ON` isn't exposed through the JS client's query builder cleanly — will
  confirm the simplest correct approach once writing this, documented inline if it's
  non-obvious) and subscribes to updates (Realtime channel or polling interval — decided in
  Step 2 below).
- `src/components/ServiceCard.tsx` — one card: service key, host, status pill (4-colour),
  relative "checked X ago" time, detail summary.
- `src/components/StatusPill.tsx` — small colour-coded status badge, reused by
  `ServiceCard`.

**Files to modify:**
- `src/App.tsx` — replace scaffold placeholder with auth-gated routing (sign-in → passkey
  gate → dashboard), following `apps/shell`'s guard pattern.
- `src/index.css` — add DESIGN.md's dark-first tokens (background/surface/border/text
  scale) as Tailwind v4 `@theme` values, plus the `#EF4444` watchtower accent.
- `.env.example` (root, not `collector/.env.example`) — confirm `VITE_SUPABASE_URL` /
  `VITE_SUPABASE_ANON_KEY` placeholders are documented (may already exist; will check
  before assuming this needs a change).

**Files NOT touched:** `collector/` (already complete through task-004), CF Pages project
creation / deploy pipeline (flagged as an optional follow-up, not blocking this task's
"dashboard renders real data" objective).

### Step-by-step execution plan

**Step 1 — Auth**
Copy and adapt the four files listed above from `apps/shell`. Verify sign-in actually
completes against the shared myargus project (real passkey ceremony, not mocked) before
moving on — an auth-gated dashboard that silently never authenticates is worse than no
gate.

**Step 2 — Decide refresh strategy**
Supabase Realtime (`postgres_changes` subscription on `service_checks` inserts) is the
better fit here — the collector is already writing one row per check on independent
intervals (30s–5m depending on adapter), so a subscription avoids re-querying on a fixed
timer that's wrong for half the adapters. Will confirm Realtime is enabled for this table
(it isn't by default — needs `alter publication supabase_realtime add table
service_checks` as a follow-up migration) before committing to this over simple polling;
falls back to a 30s poll if Realtime setup turns out to be blocked for some reason.

**Step 3 — Data fetching + latest-per-key logic**
`useServiceChecks` hook: initial fetch of latest row per `service_key`, merged with
incoming Realtime inserts (replace-by-key, not append — dashboard only ever shows current
state, not history).

**Step 4 — Layout**
Group `ServiceCard`s by `host` value (`homelab`, `cloudflare`, `supabase`, plus whatever
task-003's Duplicati eventually reports) under section headers. Simple grid, no
chart/graph/history view in this task's scope — that's a plausible task-006 if wanted
later, not assumed here.

**Step 5 — Styling pass**
Apply DESIGN.md tokens throughout; use the `dataviz` skill's guidance for the status-pill
colour choices specifically (4 categorical states need to stay distinguishable in both
light and dark, and `unreachable` vs `down` needs to read as "different kind of concerning"
rather than same-severity twins) rather than picking colours ad hoc.

### Risks / tradeoffs

- Enabling Realtime on `service_checks` is a new migration (small, additive) — flagged
  explicitly since SYSTEM.md's "no new Supabase project" boundary doesn't cover "no new
  migrations," but it's worth Director's awareness since it changes the table's replication
  config, however minor.
- Four-state status colour coding is easy to get visually wrong (e.g. `unreachable`
  rendering as calmer than `degraded` when it should sometimes be treated with equal
  urgency for homelab-local always-on services) — will lean on the `dataviz` skill rather
  than improvising here.
- No auth = no data by RLS design (see scaffold note above) — if sign-in isn't wired
  correctly, the dashboard will render as an empty, silently-broken page rather than an
  obvious error. Step 1's real-ceremony test is meant to catch this before it ships.

## 3. Human Approval Sign-off

- **Status:** Approved (2026-07-11)
- **Director Review Notes:** Approved as proposed — passkey reuse pattern, Supabase
  Realtime with the additive migration, and dataviz-guided status colours all confirmed.

## 4. Verification Checklist (AI Completed)

- [ ] Passkey sign-in works end-to-end against the real shared myargus project
- [ ] Dashboard renders real `service_checks` rows for all currently-live adapters
      (systemd, disk, uptime, Syncthing, Cloudflare, Supabase)
- [ ] Status colours are visually distinct for all 4 states, verified in both light and
      dark
- [ ] Realtime (or documented polling fallback) actually updates the dashboard without a
      manual refresh
- [ ] `pnpm run build` and `pnpm run lint` clean
- [ ] No credentials committed; anon key only (never service-role) in frontend code
