# Task-003: Syncthing and Duplicati adapters

## 1. Specification (Human Authored)

- **Objective:** Implement the second adapter family from task-001's inventory: Syncthing
  (homelab-local) and Duplicati (cross-host via Tailscale, corrected scope — see below).
- **Requirements:**
  1. Syncthing adapter polls `localhost:8384/rest/system/status` + `/rest/db/status` via API
     key, reporting sync errors / out-of-sync items.
  2. Duplicati adapter polls its REST API over Tailscale (not localhost — see corrected
     inventory), reporting last backup result and staleness vs schedule.
  3. Both report one of `healthy`, `degraded`, `down`, `unreachable`, following task-001's
     reachability semantics (`unreachable` for failed cross-host polls).
  4. New credentials (Syncthing API key, Duplicati API token) sourced from Bitwarden at
     deploy time, never committed.
- **Architectural Boundary:** Follow `.claude/SYSTEM.md`. Cloudflare/Supabase-project
  adapters and the frontend dashboard remain out of scope (task-004/005).

**Corrected inventory (supersedes task-001's original Duplicati row):**

Investigation on 2026-07-11 found task-001's assumption wrong on two counts:
- Duplicati is **not installed on homelab** (`dpkg -l`, `ss -tlnp`, `docker ps`, `find /`
  all confirm no package, no listener on :8200, no container).
- `/mnt/backups/duplicati` on homelab is an SFTP-only backup *destination*: owned by a
  dedicated `dupbackup` system user (`uid 1001`, shell `/usr/sbin/nologin`, home dir = the
  backup path itself). Its `authorized_keys` contains exactly one key, commented
  `duplicati@LNV-LGN5`.
- Duplicati is actually installed and actively configured on the Windows laptop
  (`C:\Program Files\Duplicati 2`), with live server state (`Duplicati-server.sqlite`,
  multiple named backup job databases, a registered `machineid.txt`) under
  `%LOCALAPPDATA%\Duplicati`. It pushes backups to homelab over SFTP as `dupbackup`.
- The Windows host is Tailscale-reachable as `lnv-lgn5` (`100.64.0.3`), so the collector
  (running on homelab) can reach Duplicati's REST API over the tailnet — **if** Duplicati's
  webserver is reconfigured to listen beyond `localhost` and an API token is issued. Neither
  is true today; Duplicati's default bind is loopback-only.

Per Director decision (2026-07-11): proceed with the Tailscale REST API approach rather than
a homelab-side file-freshness proxy or deferring Duplicati entirely.

## 2. AI Implementation Plan (AI Authored)

### Step 1 — Open questions requiring a live Windows-side change

This task requires modifying a **currently-running production backup service** on the
Windows laptop — not a read-only investigation like task-002's ccbot/systemd checks. Two
things must happen on `lnv-lgn5` before any collector code can be meaningfully tested:

1. **Rebind Duplicati's webserver.** Duplicati's server settings (`--webservice-interface`)
   currently default to listening on loopback only. It needs to bind to `any` (or
   specifically the Tailscale interface, `100.64.0.3`) so homelab can reach it. This is
   changed via the Duplicati web UI's own settings (Settings → Remote access →
   "Allow remote access") or by editing the server's startup arguments if it runs as a
   Windows service (`Duplicati.WindowsService.exe`) — needs to be confirmed by inspecting
   how the Windows service is currently registered before deciding which path to use.
2. **Issue an API token/password**, scoped for the collector's use, stored in Bitwarden
   under a new item (matching the `SupaBase: myargus (service_role)` pattern from
   task-002), never written to `collector/.env.example` beyond a placeholder.

Both changes affect the live backup tool protecting the Windows machine's data — they will
be proposed via AskUserQuestion with concrete steps before being applied, not done silently.
Read-only reconnaissance (checking how the Windows service is currently registered, what
its startup arguments are) can proceed without further sign-off since it's non-destructive.

### Step 2 — Workspace/file scope

**Files to create:**
- `collector/src/adapters/syncthing.ts` — `fetch` to `localhost:8384/rest/system/status`
  and `/rest/db/status` with `X-API-Key` header; `errors.length > 0` or stale `db/status` →
  `degraded`; connection failure → `down` (homelab-local, so `down` not `unreachable`,
  matching task-001's semantics for always-on local services).
- `collector/src/adapters/duplicati.ts` — `fetch` to
  `http://100.64.0.3:<port>/api/v1/...` with bearer/API-token auth; connection
  failure/timeout → `unreachable` (cross-host, laptop may be asleep, matching task-001's
  semantics); reachable but last backup result `Fatal` → `down`, `Warning` or stale beyond
  schedule → `degraded`.
- `collector/.env.example` (modify) — add `SYNCTHING_API_KEY`, `DUPLICATI_HOST`,
  `DUPLICATI_API_TOKEN` placeholders.
- `collector/src/index.ts` (modify) — register both new adapters in the static list.

**Files NOT touched:** Cloudflare/Supabase-project adapters (task-004), frontend (task-005).

### Step 3 — Execution order

1. Read-only recon on `lnv-lgn5`: confirm how Duplicati's Windows service is registered and
   its current listen config (no changes yet).
2. Propose the exact rebind + token steps via AskUserQuestion; apply only after explicit
   approval, since it changes a live backup tool's network exposure.
3. Implement `syncthing.ts` (no blockers — API key already needed, homelab-local, no
   cross-host work).
4. Implement `duplicati.ts` once the Windows-side rebind/token exist.
5. Wire both into `index.ts`, smoke-test against the real services (stop-and-verify pattern
   from task-002: confirm `unreachable` is reported correctly by testing with the laptop
   asleep/offline, not just the happy path).

### Risks / tradeoffs

- Exposing Duplicati's webserver beyond localhost — even Tailscale-only — widens its attack
  surface slightly; mitigated by requiring an API token and by Tailscale's own ACLs already
  restricting the tailnet to this user's devices.
- Duplicati REST API's exact endpoint/response shape needs confirming against the installed
  version (not assumed from memory) before `duplicati.ts` is written — will check the local
  `Duplicati.Server.dll`/docs or the running web UI's network calls rather than guessing.
- `unreachable` vs `down` distinction for Duplicati matters more than for Syncthing: the
  laptop sleeps, homelab doesn't — a naive adapter would false-alarm every time the laptop is
  closed.

## 3. Human Approval Sign-off

- **Status:** Approved (2026-07-11)
- **Director Review Notes:** Approved. Sequencing confirmed: implement Syncthing adapter
  first (no blockers); Duplicati webserver rebind + API token is a separate step requiring
  its own explicit approval before any Windows-side change is made.

## 4. Verification Checklist (AI Completed)

- [x] Syncthing adapter reports correct state against the real homelab instance — manual
      run (2026-07-11) reported `healthy` alongside the other 4 adapters; Supabase row
      confirmed correct per-folder detail (`CONTEXT` idle, `CORTEX` scanning, 0 errors)
- [ ] Duplicati webserver rebind + API token applied only after explicit Director approval
      (not started — separate approval step per this task's plan)
- [ ] Duplicati adapter correctly distinguishes `unreachable` (laptop offline) from `down`
      (laptop online, backup actually failed) — not started, blocked on the above
- [x] No credentials committed to repo — Syncthing API key sourced from new Bitwarden item
      `Syncthing: homelab (API key)`, `.env` only on homelab (gitignored)
- [x] TypeScript compiles with no errors — clean build on homelab (`pnpm --filter
      watchtower-collector build`)
