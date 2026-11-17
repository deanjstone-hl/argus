# Task-004: Cloudflare and Supabase-project adapters

## 1. Specification (Human Authored)

- **Objective:** Implement the third adapter family from task-001's inventory: Cloudflare
  Workers/Pages and Supabase project health, both polled outward over plain HTTPS (no
  Tailscale, no local host access — these are cloud APIs reachable from anywhere).
- **Requirements:**
  1. Cloudflare adapter reports last deployment status (and error rate if the API exposes
     it) for the Workers/Pages projects in scope.
  2. Supabase adapter reports each monitored project's status (`ACTIVE_HEALTHY` vs other
     states) via the Management API.
  3. Both report one of `healthy`, `degraded`, `down`, `unreachable`, per task-001's
     reachability semantics — these are always-on cloud services, so a failed poll is
     `unreachable` only if it looks like a transient network/API issue, `down` if the API
     itself reports the project as failed/errored.
  4. New credentials (Cloudflare API token + account ID, Supabase Management API token)
     sourced from Bitwarden at deploy time, never committed — matching the pattern used for
     Syncthing's API key in task-003.
  5. Poll interval 5m for both, per task-001's inventory table.
- **Architectural Boundary:** Follow `.claude/SYSTEM.md`. Frontend dashboard remains out of
  scope (task-005). Do not add a new Supabase project or auth flow for watchtower itself —
  this task only *reads* other projects' status via the Management API, unrelated to
  watchtower's own auth (shared myargus project, per SYSTEM.md).

**Scope confirmation (from repo/memory survey, 2026-07-11):**

Cloudflare Workers/Pages projects found across the user's repos:
- `myargus` — Pages (shell app, live at myargus.cc)
- `knowledge` — Pages
- `stockade` — Pages
- `reader-api` — Worker
- `argus-memory-mcp` — Worker (mcp-memory project)

Supabase projects found in memory:
- `iyqhnvandyalaujyqbtj` — shared "myargus" project (shell, knowledge, reader, stockade,
  budget auth)
- `centbxttgyenxtkknepx` — mcp-memory's own backend
- `mldxlujlinhlsmfyzcwp` — old budget/stockade project, per `project_myargus_auth` memory
  slated for retirement/migration into the shared project — **excluded** from monitoring
  scope unless Director says otherwise, since it may not be long for this world.

Neither list is a Director-confirmed inventory yet — task-001 specified adapter *approach*
per service type, not an exhaustive project list. This task proposes the above as the
initial monitored set; Director should confirm or amend in sign-off below before
implementation starts.

**Credential availability:**
- Supabase Management API: a working PAT (`sbp_...`) already exists in `~/.claude.json`'s
  Supabase MCP config, per `reference_supabase_management_api_pat` memory — reusable here,
  should be copied into a dedicated Bitwarden item rather than read out of `.claude.json` at
  deploy time (keeps the collector's credential sourcing uniform with Syncthing's pattern).
- Cloudflare API token + account ID: **not found in plaintext anywhere** — they exist only
  as GitHub Actions repository secrets (`CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`) on
  the myargus repo, per ADR-009. A new, separately-scoped token will need to be minted in
  the Cloudflare dashboard (Workers/Pages **read-only** permission is sufficient for a
  monitoring adapter — should not reuse the CI deploy token, which likely has write scope)
  and stored in a new Bitwarden item.

## 2. AI Implementation Plan (AI Authored)

### Scope of changes

**Files to create:**
- `collector/src/adapters/cloudflare.ts` — polls Cloudflare API for Workers/Pages
  deployment status per configured project name(s).
- `collector/src/adapters/supabase-projects.ts` — polls Supabase Management API
  (`GET /v1/projects` or `/v1/projects/{ref}`) for configured project refs. (Named to avoid
  clashing with the existing `collector/src/supabase-client.ts`, which is watchtower's own
  DB write client, not a monitored target.)

**Files to modify:**
- `collector/src/index.ts` — register both adapters, reading a comma-separated project
  list from env (`CLOUDFLARE_PROJECTS`, `SUPABASE_PROJECT_REFS`), same pattern as
  `SYSTEMD_UNITS`.
- `collector/.env.example` — add `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`,
  `CLOUDFLARE_PROJECTS`, `SUPABASE_MGMT_TOKEN`, `SUPABASE_PROJECT_REFS` placeholders.

**Files NOT touched:** frontend (task-005), Syncthing/Duplicati adapters (task-003,
Duplicati still blocked separately).

### Step-by-step execution plan

**Step 1 — Confirm monitored project scope**
Director confirms/amends the Workers/Pages and Supabase project lists above before any
code is written — this task should not silently decide what counts as "in scope."

**Step 2 — Mint and store credentials**
- New Cloudflare API token, read-only Workers/Pages scope, account-restricted to the one
  account ID found. Stored as a new Bitwarden item (e.g. `Cloudflare: watchtower
  monitoring (read-only)`), not reusing the CI deploy token.
- Copy the existing Supabase Management PAT into its own Bitwarden item (e.g. `Supabase:
  Management API PAT`) rather than depending on `~/.claude.json` at deploy time.
- Confirm the Cloudflare account ID (currently only known as a GitHub secret) — will ask
  the Director to supply it directly, since it isn't sensitive on its own but isn't in any
  file this task can read.

**Step 3 — Implement `cloudflare.ts`**
`GET https://api.cloudflare.com/client/v4/accounts/{account_id}/pages/projects/{project}`
for Pages projects (latest deployment `latest_stage.status`), and the equivalent Workers
deployment/version endpoint for `reader-api` / `argus-memory-mcp`. Map deployment
`success`/`failure` → `healthy`/`down`; API/network error → `unreachable`.

**Step 4 — Implement `supabase-projects.ts`**
`GET https://api.supabase.com/v1/projects/{ref}` per configured ref, bearer auth with the
Management PAT. `status === 'ACTIVE_HEALTHY'` → `healthy`; other known states (e.g.
paused, restoring) → `degraded`; request failure → `unreachable`.

**Step 5 — Wire into `index.ts`, smoke-test**
Confirm both adapters report correctly from homelab specifically — see risk below on the
Cloudflare-ASN block affecting the Supabase Management API from this user's WSL2/Windows
IP; homelab has a different public IP and needs to be verified independently rather than
assumed to work just because it worked when tested from a dev machine.

### Risks / tradeoffs

- `reference_supabase_management_api_pat` memory notes `api.supabase.com` has previously
  returned HTTP 403 (Cloudflare ASN block, error code 1010) when called from this user's
  WSL2/Windows public IP. Homelab is a different physical connection/IP, so this may not
  reproduce — but it must be verified by an actual call from homelab during Step 5, not
  assumed clear. If it does reproduce, the adapter will need a fallback (e.g. routing
  through a Cloudflare Worker proxy) — flagged now so it isn't a surprise mid-implementation.
- Cloudflare's Pages vs Workers deployment-status endpoints differ in shape; the adapter
  will need to branch by project type rather than treating all five projects identically.
- Read-only credential scoping matters here more than for Syncthing/Duplicati: a leaked
  Cloudflare token with write access could redeploy or delete production sites, so the new
  token must be minted read-only, not reused from CI.

## 3. Human Approval Sign-off

- **Status:** Approved (2026-07-11)
- **Director Review Notes:** Approved. Monitored scope (Pages: myargus/knowledge/stockade;
  Workers: reader-api/argus-memory-mcp; Supabase refs: iyqhnvandyalaujyqbtj/
  centbxttgyenxtkknepx) confirmed as proposed. Cloudflare account ID and read-only API
  token still need to be supplied/minted before Step 3-4 can be implemented — Step 1-2
  proceed now, implementation blocked on those two credentials per the plan's own Step 2.

## 4. Verification Checklist (AI Completed)

- [ ] Director confirmed monitored Cloudflare/Supabase project scope
- [ ] Cloudflare token minted read-only, stored in Bitwarden, not reused from CI
- [ ] Supabase Management PAT stored in its own Bitwarden item
- [ ] `cloudflare.ts` reports correct status against real projects (Pages and Worker cases)
- [ ] `supabase-projects.ts` reports correct status against real projects, incl. verifying
      no Cloudflare-1010 block when called from homelab
- [ ] No credentials committed to repo
- [ ] TypeScript compiles with no errors
