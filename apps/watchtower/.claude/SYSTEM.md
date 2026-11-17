# watchtower — Architectural Constraints

This file is the permanent grounding document for Claude Code in this repository.
These rules are non-negotiable and must never be violated without explicit Director approval.

## Purpose

Watchtower is a personal infra monitoring dashboard: one place to see whether Syncthing,
Duplicati, systemd services (agent-engine), Cloudflare Workers/Pages, Supabase
projects, and Tailscale connectivity are healthy across WSL2, Windows, and homelab.

It is infra-ops tooling, deliberately kept **outside** the myargus.cc Turborepo monorepo —
different deployment shape, different blast radius, no reason to share its build/CI graph
with consumer apps.

## Package Manager

- **pnpm only.** Never run `npm install` or `yarn`.
- Dependency changes via `pnpm add` / `pnpm remove`.

## Stack

- **Frontend:** Vite + React + TypeScript, Tailwind v4 (`@tailwindcss/vite`, no config file).
  Visually consistent with myargus.cc's `DESIGN.md` tokens by convention, copied in rather
  than shared via package — this repo does not depend on the myargus monorepo.
- **Hosting (frontend):** Cloudflare Pages, static SPA. Same pattern as budget's "portal".
- **Collector/API:** runs on homelab (the "workhorse") — the only host with direct local
  reach to Syncthing/Duplicati/systemd. Exposed via Cloudflare Tunnel at
  `api.myargus.cc/watchtower`. For WSL2/Windows-hosted services, the homelab collector
  polls outward over Tailscale rather than running a second collector — treat
  "unreachable over Tailscale" as a distinct state from "service down," since laptops
  sleep.
- **Auth:** shared myargus Supabase project, passkeys (WebAuthn), RP ID `myargus.cc`. Do
  not create a separate Supabase project or a custom auth flow — see
  `[[decision_myargus_auth]]` in the argus memory system for the reasoning.
- **No Docker.** Collector runs as a native systemd user service on homelab, matching
  `agent-engine`'s pattern.

## TypeScript

- TypeScript-first. New files are `.ts`/`.tsx`. Never create `.js` source files.
- Explicit types; avoid `any`, prefer `unknown` + narrowing.

## Director-Agent Workflow

- All non-trivial work begins with a GitHub issue — the issue is the source of truth, not a `.claude/tasks/` file. See `docs/agents/issue-tracker.md`.
- Claude writes the specification into the issue body under "## Specification", then appends its implementation plan under "## AI Implementation Plan" (files to create/modify/delete, step-by-step execution, risks) before writing any code.
- Claude summarises the plan in chat so the Director can review without opening the issue.
- Code execution is blocked until the Director provides explicit approval in chat.
- Claude executes, comments on the issue with the verification checklist and results, and closes it once the Director confirms the work is merged.
- Chat is the interface — the GitHub issue is the record.
- **Migration note (2026-07-26):** this repo's Director-Agent record moved from `.claude/tasks/task-NNN-*.md` files to GitHub issues, adopting Matt Pocock's skills convention in full rather than as a scoped exception. This brings watchtower in line with the 2026-07-17 batch migration (argus, myargus, budget) and the 2026-07-24 code-relay follow-up — watchtower was simply the last straggler. Task files created before this date remain as a historical archive; no new ones are created.
