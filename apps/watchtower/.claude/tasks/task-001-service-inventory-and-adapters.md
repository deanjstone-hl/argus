# Task-001: Service inventory and adapter design

> Historical task record. ccbot, mentioned below as a monitored unit, is decommissioned (argus#302, #382).

## 1. Specification (Human Authored)

- **Objective:** Establish the authoritative list of services watchtower must monitor and
  the integration approach ("adapter") for each, before any collector code is written.
  This is a design/spec task — no implementation yet.
- **Requirements:**
  1. Enumerate every service/host in scope, grouped by which host can reach it directly.
  2. For each service, specify: how health is queried (API, log, systemctl, port check),
     what "healthy" vs "degraded" vs "down" means for it, and polling interval.
  3. Identify cross-host reachability paths (Tailscale) and how "unreachable" is
     distinguished from "down" for hosts that sleep (laptop).
  4. Note auth/credentials needed per adapter and where they're stored (Bitwarden vs env).
- **Architectural Boundary:** Design only — do not write collector code, DB schema, or
  frontend components in this task. Follow `.claude/SYSTEM.md` (homelab-hosted collector,
  Tailscale outward polling, shared myargus Supabase auth, no Docker, pnpm only).

## 2. AI Implementation Plan (AI Authored)

*To be filled by Claude before writing any code.*

### Service inventory (draft, subject to Director review)

**Homelab-local (collector has direct access):**

| Service | Adapter approach | Health signal | Interval |
|---|---|---|---|
| Syncthing | REST API (`localhost:8384/rest/system/status` + `/rest/db/status`) with API key | Sync errors, out-of-sync items, last scan time | 60s |
| ~~Duplicati (localhost:8200)~~ | **Corrected 2026-07-11, see task-003:** Duplicati does not run on homelab. It runs on the Windows laptop (`lnv-lgn5`) and pushes backups to homelab over SFTP as a dedicated `dupbackup` nologin user. Homelab is a backup *destination*, not a place to poll. Adapter moved to the Tailscale cross-host table below. | — | — |
| systemd services (agent-engine, ccbot, etc.) | `systemctl show <unit> --property=ActiveState,SubState` via local shell exec (collector runs on homelab, no remote SSH needed for these) | ActiveState != "active" → down | 30s |
| Homelab disk/battery/uptime | `df`, `/sys/class/power_supply` (n/a for server — disk + uptime only) | Disk >90% used → degraded | 5m |

**Remote/cloud (collector polls outward via HTTPS, no Tailscale needed):**

| Service | Adapter approach | Health signal | Interval |
|---|---|---|---|
| Cloudflare Workers/Pages | Cloudflare API (`GET /accounts/:id/workers/services`, deployment status) | Last deployment status, error rate if available | 5m |
| Supabase projects | Supabase Management API project status endpoint | Project ACTIVE_HEALTHY vs other states | 5m |

**Cross-host via Tailscale (collector polls outward from homelab):**

| Service | Adapter approach | Health signal | Interval |
|---|---|---|---|
| WSL2 host (agent-engine dev instance, if run there) | HTTP health-check endpoint over Tailscale IP | 200 OK vs timeout | 60s |
| Windows host (Syncthing GUI, general reachability) | Tailscale ping / `tailscale status` peer check | Peer online vs offline | 60s |
| Duplicati (runs on `lnv-lgn5`, Windows) | REST API over Tailscale IP (`http://100.64.0.3:8200/api/v1`, requires Duplicati's webserver bound beyond localhost + API token) with auth token | Last backup result (Success/Warning/Fatal), time since last run vs schedule | 5m |

**Reachability semantics:** for any service reached over Tailscale, a failed poll produces
state `unreachable`, not `down`. `unreachable` is only escalated to `down`/alerting if the
service is expected to be always-on (homelab peers); for laptop/desktop hosts that sleep,
`unreachable` is informational only and never triggers an alert.

### Scope of changes

**Files to create:**
- None yet — this task produces the spec above (already embedded in this file) plus any
  follow-up task files for implementation (task-002+).

**Files to modify:** none
**Files to delete:** none
**Files NOT touched:** all application code — deferred to subsequent tasks.

### Step-by-step execution plan

**Step 1 — Review and refine inventory**
Director reviews the draft table above, adds/removes services, corrects intervals.

**Step 2 — Confirm adapter auth storage**
For each adapter requiring a credential (Syncthing API key, Duplicati token, Cloudflare
API token, Supabase Management API token), confirm it will be pulled from Bitwarden at
collector startup / deploy time, not committed to the repo.

**Step 3 — Split into implementation tasks**
Once approved, break into task-002 (collector core + systemd adapters), task-003
(Syncthing/Duplicati adapters), task-004 (Cloudflare/Supabase adapters), task-005
(frontend dashboard), following one-adapter-family-per-task granularity.

### Risks / tradeoffs

- Local shell exec for systemd status is homelab-only and intentionally not abstracted
  behind an HTTP call — simplest correct approach since collector already runs there.
- Polling intervals are a first guess; may need tuning once real API rate limits (Cloudflare,
  Supabase) are checked.

## 3. Human Approval Sign-off

- **Status:** Approved (2026-07-11)
- **Director Review Notes:** Draft inventory approved as-is. Proceed to task-002.

## 4. Verification Checklist (AI Completed)

- [x] Service inventory table reviewed and confirmed by Director
- [x] Adapter auth/credential storage plan confirmed for each service
- [x] Follow-up implementation tasks (task-002+) created once this spec is approved
