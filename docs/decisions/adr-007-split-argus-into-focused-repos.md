---
title: ADR-007 — Split Argus Monorepo into Focused Repositories
status: superseded
superseded_by: ADR-010
date: 2026-07-04
summary: "ADR-007 (superseded by ADR-010): the never-executed plan to split argus into focused repos"
read_when:
  - tracing the repo-split reasoning that ADR-010 reversed
---

# ADR-007: Split Argus Monorepo into Focused Repositories

> **Superseded by [ADR-010](adr-010-monorepo-consolidation-and-layout.md) (2026-08-17).**
> The split described below was never carried out; the 2026-08 [argus-infra consolidation](https://github.com/deanjstone/argus/issues/163)
> ran the opposite direction and folded six repos *into* argus. Kept for the reasoning, not as current policy.

## Context

The argus monorepo has grown to bundle several distinct concerns: the agent CLI and engine
(orchestration core), machine configuration (dotfiles, skills, hooks, settings), the Telegram
relay bot (ccbot), the memory MCP server (mcp-memory), and dev stack install scripts. All of
these live under a single repository and deploy via separate but entangled paths.

The primary pain point is cognitive overhead — it is not immediately clear what to touch when
making a change, because deployment boundaries do not map to repository boundaries. Updating a
Claude Code skill, changing a hook, deploying the engine to homelab, or restarting ccbot all
require navigating the same repo with different mental models of what is safe to modify and
what triggers a redeploy.

This also conflicts with the intended role of argus as a stable orchestration surface. As agent
and agent-engine mature into the primary interface for all development work (dispatching to
focused sub-agents per project), they need to be decoupled from the things that change
constantly: per-machine config, Telegram relay logic, and sysadmin tooling.

ADR-002 defined the orchestrator role; ADR-003 established the argus/myargus boundary. This
decision refines the internal structure of argus to enforce a cleaner deployment and
responsibility boundary.

## Decision

Split the argus monorepo into five focused repositories:

**`argus`** (this repo, trimmed)
- `packages/agent/` — CLI entrypoint, project picker, WT tab launcher
- `packages/agent-engine/` — HTTP server, vector search, context API
- Stable orchestration core; only changes when the CLI or engine API changes

**`argus-config`**
- `config/wsl2/`, `config/windows/` — machine settings, rules
- Claude Code skills used for development workflows
- Hooks, keybindings, statusline config
- `install-linux.sh`, `install-windows.ps1` moved to `sys-admin`
- Boundary: *how Claude Code behaves across sessions*

**`sys-admin`**
- `stack/` — declarative dev stack definitions and install scripts (absorbs dev-stack and
  current install scripts from argus)
- `scripts/` — automation for provisioning, service management, updates across
  Windows/WSL2/homelab
- `skills/` — sysadmin-flavoured Claude Code skills (`provision-server`, `update-tools`,
  `syncthing-pair`, and equivalents)
- `docs/` — runbooks, environment state notes
- Boundary: *how the machines are configured and operated*
- Claude operates here in a SysAdmin role managing settings and applications across all three
  environments (Windows, WSL2, homelab)

**`ccbot`**
- Telegram relay bot; multi-group routing and briefing timer
- Own repo and deploy lifecycle; no longer couples bot restarts to engine deploys

**`mcp-memory`**
- Memory MCP server (stdio + Cloudflare Workers)
- Already conceptually separate; formalised as an independent repo

The key boundary rule: **argus-config = how Claude Code behaves; sys-admin = how the machines
are configured.** Sysadmin-flavoured skills currently in argus-config move to sys-admin.

## Consequences

- Each repo has a single clear deployment concern; a config change never forces an engine
  rebuild and vice versa
- `argus` becomes a thin, stable core that rarely changes — appropriate for a primary
  orchestration surface
- `sys-admin` provides a dedicated workspace where Claude operates as SysAdmin, with skills,
  scripts, and runbooks co-located
- `argus-config` symlink targets change: `~/.claude/` symlinks currently pointing into
  `argus/config/wsl2/` will point into `argus-config/` after migration
- Migration work required: extract each package into its own repo, update deploy scripts,
  update symlinks on all machines (WSL2, homelab), verify ccbot and mcp-memory CI/deploy are
  self-contained
- Cross-cutting changes (e.g. a new skill that depends on a new engine API) require coordinated
  commits across two repos — accepted as an infrequent trade-off given the cleaner day-to-day
  boundaries
