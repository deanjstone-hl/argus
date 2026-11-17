# Task-007: AI coding usage adapter

## 1. Specification (Human Authored)

- **Objective:** Add a new watchtower adapter that surfaces AI coding tool token usage and
  API-equivalent cost (Claude Code, and anything else `ccusage` detects) as a dashboard
  card, across WSL2, Windows, and homelab.
- **Requirements:**
  1. Reuse [`ccusage`](https://github.com/ccusage/ccusage) as the parsing/cost engine —
     do not reimplement Claude Code / Codex / Gemini CLI JSONL log parsing or pricing
     tables. Reference implementation for the "how" of scheduling + aggregation:
     [`ai-coding-usage-card`](https://github.com/Baek-Seunghyun/ai-coding-usage-card)
     (MIT), which already solves per-device snapshotting and SVG rendering — watchtower
     only needs the snapshotting half, not the SVG half, since it has a live dashboard.
  2. Report per-host totals (tokens, API-equivalent cost, cache-hit ratio, top model) and
     a combined all-hosts total, matching the existing per-adapter `detail` JSON shape
     consumed by `src/lib/format-detail.ts`.
  3. States: `healthy` (data collected within the last 24h), `degraded` (stale >24h but
     host was reachable), `unreachable` (cross-host poll failed) — no `down` state, since
     "no AI usage" isn't a failure.
  4. New credentials/tokens (if the chosen design needs a shim auth token) sourced from
     Bitwarden, never committed — same pattern as Syncthing/Duplicati.
- **Architectural Boundary:** Follow `.claude/SYSTEM.md`. No Docker. No second collector
  process. Do not fork or vendor `ccusage`'s source — depend on it as a package/CLI.

## 2. AI Implementation Plan (AI Authored)

### Open design question requiring Director decision before implementation

`ccusage` reads **local** JSONL logs (`~/.claude/projects/**/*.jsonl` etc.) — it has no
REST API of its own, unlike Syncthing/Duplicati. SYSTEM.md's rule is "poll outward over
Tailscale rather than running a second collector," which was written for services that
already expose a REST API. AI coding logs don't, so there are two ways to satisfy the
spirit of that rule:

- **Option A — thin local shim, homelab polls it.** A minimal stateless HTTP endpoint on
  each non-homelab host (WSL2, Windows) that runs `ccusage --json` on request and returns
  the result. Not a second *collector* (no scheduling, no state, no adapters of its own —
  it only echoes ccusage's own output), so it doesn't violate the "no second collector"
  rule the way a full watchtower-collector clone would. Matches the Duplicati precedent
  (cross-host REST poll) most closely.
- **Option B — per-host push, matching `ai-coding-usage-card`'s model.** Each host runs
  `ccusage` on a local cron/Task Scheduler entry and pushes its snapshot directly to
  Supabase (bypassing the homelab collector entirely for this one adapter). Simpler to
  build and exactly mirrors the reference repo's proven `USAGE_CARD_DEVICE` snapshot
  pattern, but is architecturally inconsistent with every other adapter (all currently
  flow through the homelab collector) and adds three independent cron schedules instead
  of one.

Recommendation: **Option A**, for consistency with the existing adapter architecture and
to keep "data flows through the collector" as an invariant a future reader can rely on.
Needs explicit Director sign-off before Step 1 begins, since it's a new architectural
pattern (first "shim on a remote host" adapter) rather than a straightforward adapter add.

### Scope of changes (assuming Option A; will be revised if Option B is chosen)

**Files to create:**
- `collector/src/adapters/ai-usage.ts` — polls the WSL2 shim (`localhost` if collector
  ever runs there, else Tailscale) and the Windows shim (`100.64.0.3:<port>`) over
  Tailscale, plus runs `ccusage --json` directly for homelab's own local usage; merges all
  three into one `detail` payload with a per-host breakdown and a combined total.
- `usage-shim/` (new small workspace member, one host-agnostic script) — a tiny HTTP
  server (Node, no framework) that runs `npx ccusage@latest --json` and returns stdout;
  bearer-token gated; deployed on WSL2 and Windows via existing scheduled-task tooling,
  not systemd (Windows has no systemd).
- `collector/.env.example` (modify) — add `AI_USAGE_WSL2_URL`, `AI_USAGE_WSL2_TOKEN`,
  `AI_USAGE_WINDOWS_URL`, `AI_USAGE_WINDOWS_TOKEN` placeholders.
- `collector/src/index.ts` (modify) — register the new adapter.
- `src/lib/format-detail.ts` (modify) — per-adapter label mapping for the new detail shape
  (tokens, cost, per-host sub-list — same nested-list pattern already used for Syncthing's
  `folders`).

**Files NOT touched:** existing adapters, auth, deploy workflow.

### Step-by-step execution plan

**Step 1 — Director decision on Option A vs B.** Do not write code until this is settled.

**Step 2 — Confirm `ccusage` JSON output shape.** Run `npx ccusage@latest --json` locally
against real Claude Code logs on this machine (WSL2) and inspect the actual schema —
do not assume field names from the reference repo without checking, since `ccusage` is a
third-party tool that can change its output between versions.

**Step 3 — Build and deploy the shim** (if Option A) to WSL2 and Windows, each behind a
bearer token stored in Bitwarden, following the scheduled-task pattern already used
elsewhere on Windows (matches how other WSL2/Windows automation in this environment is
registered).

**Step 4 — Implement `ai-usage.ts`**, wire into `index.ts`, add the Supabase row shape.

**Step 5 — Frontend:** extend `format-detail.ts`'s label map; verify the card renders
correctly with real multi-host data, including a smoke test of the `unreachable` state
(stop one shim, confirm the card degrades correctly rather than dropping the whole card).

### Risks / tradeoffs

- The shim is a new always-on network surface on WSL2 and Windows, even if minimal and
  token-gated — worth Director awareness, since it's the first adapter that requires
  installing anything outside the homelab/frontend split.
- `ccusage`'s cost figures are "API-equivalent," not actual spend, for subscription users
  (Claude Max/Pro) — the card must label this clearly to avoid being misread as a real
  bill, matching the disclaimer the reference repo already carries.
- Running `npx ccusage@latest` on every poll re-resolves the package each time; pin a
  version instead (`ccusage@x.y.z`) once a stable release is chosen, to avoid a poll
  silently breaking on an upstream ccusage release.

## 3. Human Approval Sign-off

- **Status:** Approved (2026-07-17)
- **Director Review Notes:** Option A approved (shim on WSL2/Windows, polled by homelab
  collector over Tailscale). Proceed with implementation using TDD.

## 4. Verification Checklist (AI Completed)

- [x] Director has chosen Option A or B before any code is written
- [x] Adapter reports correct combined + per-host totals against real ccusage data on at
      least two hosts — verified against a live deployment (2026-07-17): homelab (local
      source) and WSL2 (remote shim over Tailscale) are both wired into the homelab
      collector and confirmed reachable with real ccusage output (`curl` against the WSL2
      shim from homelab returns HTTP 200 with real token/cost totals). Windows deferred —
      see follow-up issue below.
- [x] `unreachable` state correctly distinguished from stale-but-reachable (`degraded`) —
      covered by `collector/src/adapters/ai-usage.test.ts` (degraded-one-stale,
      degraded-one-unreachable, unreachable-all-fail cases); also observed live — homelab's
      own ccusage data is stale (no recent local AI CLI usage) and correctly reports
      `degraded`, not `unreachable`, while still successfully reaching the WSL2 host
- [x] No credentials committed to repo — only `.env.example` placeholders touched; verified
      via `git status`/`git diff` review. Real WSL2 shim token generated locally
      (`openssl rand -hex 32`), stored in Bitwarden as "Watchtower: usage-shim (wsl2)", and
      wired into `usage-shim/.env` (WSL2) and `collector/.env` (homelab) — both real `.env`
      files are gitignored, neither was committed
- [x] TypeScript compiles with no errors — `npx tsc -b --noEmit` clean at repo root; `tsc`
      clean in both `collector/` and `usage-shim/`; `eslint .` clean; `vite build` succeeds;
      all 15 unit tests pass (4 usage-shim + 7 collector + 4 root)

## 5. Deployment Status (2026-07-17)

- **homelab**: `collector` rebuilt and restarted via `systemctl --user restart
  watchtower-collector`. Its systemd unit was missing a `PATH` override, so the adapter's
  `npx ccusage@20.0.17` call failed silently (`ai-usage -> unreachable`) until an
  `Environment=PATH=...` line was added pointing at the fnm-installed node bin dir. Fixed
  and confirmed live.
- **WSL2** (this host, LNV-LGN5): `usage-shim` built and running as a systemd --user
  service (`watchtower-usage-shim.service`, enabled + started), token in Bitwarden as
  "Watchtower: usage-shim (wsl2)", wired into homelab's `collector/.env` as
  `AI_USAGE_WSL2_URL`/`AI_USAGE_WSL2_TOKEN`. Confirmed reachable and authenticating
  correctly from homelab.
- **Windows**: deferred. Blocked on two elevated-access steps not reachable from WSL2 —
  NSSM isn't installed (used for the existing Syncthing Windows service, same pattern
  would apply here), and the PowerShell execution policy blocks `npx`/npm scripts outright.
  Node 26.2.0 is already present. Tracked as
  [argus#283](https://github.com/deanjstone/argus/issues/283).
