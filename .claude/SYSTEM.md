# Argus — Architectural Constraints

This file is the permanent grounding document for Claude Code in this repository.
These rules are non-negotiable and must never be violated without explicit Director approval.

## Package Manager

- **pnpm only.** Never run `npm install` or `yarn` in any directory.
- All dependency changes must use `pnpm add` / `pnpm remove` from the workspace root.
- Never run `pnpm add` inside a package without checking whether the dep should live at the root.
- Build scripts approved in root `pnpm-workspace.yaml` under `allowBuilds`.

## Workspace Structure

- This is a pnpm workspace. Root `pnpm-workspace.yaml` declares `apps/*` and `packages/*` (`apps/` for deployables, `packages/` for shared libraries).
- Packages: the full table lives in `AGENTS.md` (Packages). All are flat root-workspace members; none is a nested workspace excluded from the root glob.
- Run installs from the workspace root — not from inside a package directory.

## Build Tooling

- Build each package individually: `pnpm run build` from within `apps/<name>/` (or `packages/<name>/` for shared libraries).
- Deploy via `./deploy.sh` where the package has one. Packages deployed by a GitHub workflow or `wrangler deploy` alone (watchtower) ship no stub and document the real path in their README. Never manually rsync or copy artifacts.
- Never invoke `tsc` directly from the workspace root — use `pnpm run build` inside the package.

## TypeScript

- TypeScript-first. All new source files must be `.ts`. Never create `.js` source files.
- Explicit types required for all public API. Avoid `any`; use `unknown` and narrow.

## Deploy Contract

- `apps/agent-cli` deploys to `~/.argus/agent-cli/` via its `deploy.sh`.
- `apps/agent-engine` deploys to `~/.argus/agent-engine/` (local) or homelab Docker (server target).
- Never modify `deploy.sh` without Director instruction.

## Director-Agent Workflow

- All non-trivial work begins with a GitHub issue — the issue is the source of truth, not a `.claude/tasks/` file. See `docs/agents/issue-tracker.md`.
- Claude writes the specification into the issue body under "## Specification", then appends its implementation plan under "## AI Implementation Plan" (files to create/modify/delete, step-by-step execution, risks) before writing any code.
- Claude summarises the plan in chat so the Director can review without opening the issue.
- Code execution is blocked until the Director provides explicit approval in chat.
- Claude executes, comments on the issue with the verification checklist and results, and closes it once the Director confirms the work is merged.
- Chat is the interface — the GitHub issue is the record.
- **Migration note (2026-07-17):** this repo's Director-Agent record moved from `.claude/tasks/task-NNN-*.md` files to GitHub issues, adopting Matt Pocock's skills convention in full rather than as a scoped exception. Task files created before this date remain as a historical archive; no new ones are created.
