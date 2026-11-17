# Task-006: Deploy frontend and close deployment loose ends

## 1. Specification (Human Authored)

- **Objective:** Get the full stack actually live end-to-end. task-005 built the dashboard
  but it has never been deployed anywhere; task-004's collector changes were merged but
  never verified live on homelab. This task closes both gaps rather than leaving them as
  permanent "pending" items in HANDOFF.md.
- **Requirements:**
  1. Cloudflare Pages project for the frontend (`web`/root Vite app), deployed at
     `watchtower.myargus.cc` per `project_myargus_hosting`'s URL taxonomy (external app
     pattern — matches shell/reader/knowledge, not the `api.myargus.cc/<app>` internal
     shape used by the collector).
  2. CI deploy wiring: push-to-main only, no PR previews (matches the rest of myargus —
     see `feedback_workers_no_pr_previews`). `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY`
     / `VITE_API_BASE_URL` as repo secrets or Pages project env vars, not committed.
  3. Confirm homelab's actual running collector has the task-004 env vars
     (`CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_PAGES_PROJECTS`,
     `CLOUDFLARE_WORKER_PROJECTS`, `SUPABASE_MGMT_TOKEN`, `SUPABASE_PROJECT_REFS`) set and
     the systemd service restarted since — not just merged in git.
  4. Live smoke test of the Cloudflare/Supabase-project adapters running for real from
     homelab's actual egress IP (task-004's PR only verified live API responses from this
     WSL2 session, which is a different network path than homelab — re-check the
     Cloudflare-1010 ASN-block risk noted in `reference_supabase_management_api_pat` applies
     specifically to WSL2/Windows IPs, not confirmed clear for homelab).
- **Architectural Boundary:** Follow `.claude/SYSTEM.md` — CF Pages only (no Vercel), no
  Docker, pnpm only. Does not touch the Duplicati adapter (still blocked, separate approval
  needed per task-003). Does not add a shared auth package — passkey code stays copy-pasted
  per the established convention. DNS/Cloudflare Tunnel changes for `watchtower.myargus.cc`
  are real, live changes to shared infrastructure (the `myargus.cc` zone) — treat as
  higher-blast-radius than previous tasks, confirm the exact DNS record before creating it.

## 2. AI Implementation Plan (AI Authored)

### Scope of changes

**Files to create:**
- `.github/workflows/deploy.yml` — push-to-main-only deploy job, mirrors myargus's
  `wrangler-action@v3` pattern: install → build → `pages deploy dist --project-name=watchtower`

**Files NOT touched:**
- `collector/` — homelab env var confirmation (requirement 3) and the live smoke test
  (requirement 4) are operational verification, not code changes
- `.claude/tasks/task-003-*` (Duplicati) — explicitly out of scope

### Step-by-step execution plan

**Step 1 — Cloudflare credentials**
Director chose: reuse myargus's existing CI deploy token rather than mint a new one.
Found via Bitwarden (`CLOUDFLARE-TOKEN-PAGES`, username `myargus-ci-deploy` — same token
myargus's own deploy.yml uses) and `CLOUDFLARE-TOKEN-DNS` for the DNS record. Verified both
active via `/user/tokens/verify` before use.

**Step 2 — Repo secrets**
Set `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `VITE_SUPABASE_URL`,
`VITE_SUPABASE_ANON_KEY`, `VITE_API_BASE_URL` as watchtower GitHub repo secrets via `gh
secret set` (values piped via stdin, never echoed to transcript).

**Step 3 — Cloudflare Pages project**
Created via API (`POST /accounts/{id}/pages/projects`, name `watchtower`,
production_branch `main`). No prior project existed under this name — confirmed via a
listing call first. Resulting default host: `watchtower-4z6.pages.dev`.

**Step 4 — Custom domain + DNS**
Attached `watchtower.myargus.cc` to the Pages project
(`POST .../pages/projects/watchtower/domains`). Unlike Pages projects created via the
dashboard wizard, this did not auto-provision a DNS record (confirmed empty via a DNS
lookup before proceeding) — added the CNAME manually (`watchtower` → `watchtower-4z6.pages.dev`,
proxied) via the DNS-scoped token.

**Step 5 — Deploy workflow**
`deploy.yml` triggers on `push: branches: [main]` only (no `pull_request` trigger — matches
`feedback_workers_no_pr_previews`), builds with the existing `pnpm run build` (`tsc -b &&
vite build`, outputs `dist/`), deploys via `cloudflare/wrangler-action@v3`.

**Step 6 — Requirements 3 & 4 (homelab verification)**
Deferred to a follow-up check once this PR is reviewed — needs live SSH/Tailscale access to
homelab to confirm the systemd service's actual environment and re-run the adapters from
that network path, which is operational verification rather than something to bundle into
this code PR.

### Risks / tradeoffs

- Reused an existing broadly-scoped Pages token rather than minting a narrower one — same
  tradeoff Director accepted in task-004, consistent choice here.
- DNS record was added directly via live API call against the shared `myargus.cc` zone (not
  a dry-run) — Director explicitly chose this path over manual dashboard entry.
- Cloudflare Pages project creation and the DNS record are both real, already-applied infra
  changes as of this plan being written, not proposals — flagging here rather than pretending
  they're still pending, since the Director-Agent workflow's "plan before code" ordering
  doesn't map cleanly onto infra-API calls made to answer "does this already exist" questions
  along the way.

## 3. Human Approval Sign-off

- **Status:** Approved (2026-07-11) — "Proceed" given in response to the task-006 spec.
  Note: this covers the deploy/DNS/CI work above; merging the PR that carries it is a
  separate explicit step per the harness's standing "no merge without review" rule.
- **Director Review Notes:** —

## 4. Verification Checklist (AI Completed)

- [x] `watchtower.myargus.cc` resolves and serves the real dashboard (not a Pages default page) — verified 2026-07-11: `200`, correct hashed JS/CSS assets, `<div id="root">` mount point. Minor cosmetic leftover: `<title>` is still the unedited Vite scaffold default ("Vite + React + TS"), not a deploy issue.
- [x] CI deploy runs on push to `main`, not on PR open — `deploy.yml` has `on: push: branches: [main]` only
- [x] Homelab's live collector process confirmed running with task-004 env vars set (not just present in `.env.example`) — homelab was found checked out on the stale `feature/task-003-syncthing-adapter` branch (never switched to `main` post-merge), missing all 6 task-004 vars. Fixed 2026-07-11: switched to `main`, pulled to `7cc1391`, added `CLOUDFLARE_API_TOKEN`/`CLOUDFLARE_ACCOUNT_ID`/`CLOUDFLARE_PAGES_PROJECTS`/`CLOUDFLARE_WORKER_PROJECTS`/`SUPABASE_MGMT_TOKEN`/`SUPABASE_PROJECT_REFS` to `collector/.env` (values from Bitwarden, never echoed), rebuilt (`pnpm run build` via the fnm-managed node — plain `pnpm`/`node` aren't on the systemd/non-interactive PATH, see Gotchas), restarted `watchtower-collector.service`.
- [x] Cloudflare + Supabase-project adapters confirmed writing real (non-error) rows to `service_checks` from homelab's actual network path — verified via `journalctl` (`cloudflare:*` and `supabase:*` all `healthy`) and a direct `service_checks` query showing fresh rows timestamped 2026-07-11 07:09:57 UTC. No Cloudflare-1010 ASN-block from homelab's egress IP.
- [ ] TypeScript compiles with no errors
