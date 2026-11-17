---
title: Argus Orchestrator — Strategy
date: 2026-05-23
status: approved
approved: true
tags: [plan, argus, claude-code, orchestrator]
changes:
  - "2026-05-23: Open questions resolved — own repo, WSL2-only, all Telegram → Argus, git-hook context refresh"
summary: "Historical 2026-05 orchestrator strategy, built on the decommissioned Telegram bridge"
read_when:
  - tracing why the orchestrator is shaped the way it is
---

> **Historical (2026-05).** The `ccgram-argus` Telegram bridge this plan builds on is
> decommissioned, as is its successor ccbot (#302, #382). Kept as a record of the original
> orchestrator plan ([#418](https://github.com/deanjstone/argus/issues/418)).

## Purpose

Argus is a persistent, always-available Claude Code orchestrator agent on WSL2. It is the primary point of communication for cross-cutting work: project actions, stack management, tool setup, and delegation to sub-agents. Rather than opening a fresh Claude session in a specific project directory, the user routes requests through Argus, which either handles them directly or spawns focused sub-agents.

---

## What Argus Is Not

- Not a replacement for working directly in a project repo — Argus *delegates* to project sessions
- Not a daemon or custom service — it is a Claude Code CLI session in a named tmux window
- Not a new Telegram bot — it reuses the existing `ccgram-argus` bridge and Telegram channel
- Not dependent on ClawTeam (dropped 2026-05-19)

---

## Identity & Naming

"Argus" is already established as a namespace in the stack:
- `ccgram-argus` — Telegram bridge (`~/.argus/ccgram/`)
- `ArgusUI.js` — iOS Scriptable multi-branch UI

The orchestrator completes this identity. Its home directory is `~/argus/` — a project-like root that holds its CLAUDE.md, context docs, memory snapshots, and any tooling specific to the orchestrator role.

---

## Architecture

```
iOS (Telegram)
     │
     ▼
ccgram-argus  (~/.argus/ccgram/)
     │  hook bridge
     ▼
Claude Code CLI  ←── tmux window: main:argus
     │
     ├── reads CLAUDE.md from ~/argus/
     ├── reads MCP memory (context + project tags)
     ├── reads ~/argus/context/ (project map, stack overview)
     │
     └── spawns sub-agents → project dirs (~/repos/*)
           └── results written to ~/argus/workspace/ or project docs/
```

### Relationship to existing stack

| Component | Role in Argus context |
|---|---|
| `ccgram-argus` | Unchanged — delivers Telegram messages as Claude prompts, streams responses back |
| `claude-memory-mcp` | Argus reads memory at session start; writes lessons and project context back |
| `claude-tui-bot` | Secondary interface (tmux-based); Argus also accessible here |
| `~/repos/*` | Sub-agent work targets; Argus does not own project code |
| `dev-stack` dashboard | Argus can surface status queries to it |

---

## Home Directory Layout

```
~/argus/
├── CLAUDE.md            ← orchestrator identity, capabilities, rules
├── context/
│   ├── stack.md         ← canonical project map and service inventory
│   ├── projects.md      ← per-project summaries (status, key paths, deploy notes)
│   └── tools.md         ← CLI tools, aliases, bw-secrets patterns
├── workspace/           ← scratch area for in-progress delegated work
│   └── <task-slug>/     ← ephemeral; cleaned up when task closes
├── docs/
│   └── decisions/       ← ADRs for orchestrator-level decisions
└── logs/                ← not git-tracked; session notes, error captures
```

### What goes in CLAUDE.md

The orchestrator's `CLAUDE.md` is its identity document. It should define:
- What Argus is and its scope
- The project map (or reference to `context/projects.md`)
- How to spawn sub-agents (tmux-skill patterns, project dirs)
- When to delegate vs handle inline
- Communication conventions (Telegram thread behaviour, approval flows)
- Stack-specific rules (bw-secrets pattern, deploy workflows, Tailscale IPv4 patch)

---

## Communication Channel

Argus is the Claude Code session the user talks to via Telegram. The `ccgram-argus` bridge already wires `~/.claude/settings.json` hooks to `~/.argus/ccgram/dist/`. No changes to the bridge are required.

The key change is that instead of Telegram prompts landing in an ad-hoc Claude session, they land in a **named, persistent tmux window** (`main:argus`) that always starts in `~/argus/`. This ensures:
- CLAUDE.md is always loaded (consistent identity)
- Memory is loaded at `SessionStart`
- Context docs are always in scope

---

## Context Loading Strategy

Argus needs comprehensive context without a long preamble on every session start. Three layers:

1. **CLAUDE.md** — static identity, project map reference, rules (always loaded)
2. **MCP memory** — Supabase sync (planned: SessionStart hook to load `context`-tagged memories; currently: manual via `memory_list(tag: "context")` in tools.md)
3. **context/ docs** — Argus reads `context/stack.md` and `context/projects.md` proactively when needed; these are human-maintained and git-tracked

The `context/stack.md` doc is the single source of truth for "what projects exist and where." It is mirrored in MCP memory as a backup. At SessionStart, `sync-files-to-supabase.mjs` syncs all disk memories to Supabase; a future SessionStart hook will pull `context`-tagged entries back into the session context to avoid manual loading on every restart.

---

## Sub-agent Orchestration

Argus delegates by spawning Claude Code sub-agents (via the `Agent` tool or tmux + `claude` CLI) in the relevant project directory. Patterns:

- **Inline delegation** — `Agent(subagent_type, prompt)` with project dir set via `cwd`; results return to Argus context
- **Background delegation** — for long-running tasks; Argus monitors via `SubagentStop` hook notification
- **tmux spawn** — for tasks that need a persistent interactive session (use tmux-mgmt skill pattern)

Argus is responsible for:
- Framing the sub-agent prompt with enough context (file paths, constraints, current state)
- Collating results back into memory or project docs
- Reporting to the user via Telegram

Sub-agents are **not** Argus — they are disposable workers. They don't need `~/argus/` awareness.

---

## Scope

### In scope for Argus
- Stack management: updating settings.json, hook scripts, deploy workflows
- Project bootstrapping: creating new repos, scaffolding, wiring into claude-stack
- Cross-project tasks: anything touching multiple repos
- Status queries: "what's running?", "what's deployed?", "what's in memory?"
- Delegation: breaking down complex tasks, spawning sub-agents
- Planning: drafting strategy docs like this one

### Out of scope (delegate to project session)
- Deep coding work within a single project (open that project in Claude directly)
- Obsidian vault editing (separate session in CORTEX)
- iOS Scriptable scripts (scriptable-private session)

---

## Session Persistence

Argus runs in `tmux` window `main:argus`. The `wsl2-boot.sh` script pre-creates the `main` session; a new window for `argus` should be added to that bootstrap.

On SSH + Tailscale login, tmux auto-attach puts the user into the `main` session, where `argus` is one of the windows.

Argus does not need to be always running. Starting a new session in `~/argus/` with CLAUDE.md loaded is sufficient — MCP memory restores context.

---

## Implementation Phases

### Phase 1 — Home directory and identity
- [ ] Create `~/argus/` directory structure
- [ ] Write `~/argus/CLAUDE.md` (identity, scope, project map, rules)
- [ ] Write `~/argus/context/stack.md` (current stack snapshot from MCP memory)
- [ ] Write `~/argus/context/projects.md` (per-project summaries)
- [ ] Add `~/argus/` to git (new repo or track in `claude-stack`)

### Phase 2 — tmux integration
- [ ] Add `argus` window to `wsl2-boot.sh` bootstrap (starts in `~/argus/`, auto-launches claude)
- [ ] Verify `ccgram-argus` delivers Telegram messages to this session
- [ ] Confirm MCP memory loads at `SessionStart` in `~/argus/` context

### Phase 3 — Context maintenance workflow
- [ ] Write post-commit hook script (`~/argus/hooks/refresh-context.sh`) that regenerates `context/projects.md`
- [ ] Install hook into each `~/repos/*/` repo (or via a global git hook template in `~/.git-templates/`)
- [ ] Add `project/argus` entry to MCP memory server
- [ ] Link `context/stack-overview` MCP memory to `context/stack.md` file

### Phase 4 — Sub-agent workflow
- [ ] Document sub-agent prompt templates in `~/argus/context/tools.md`
- [ ] Test inline delegation to a project sub-agent from Argus
- [ ] Establish result-collation pattern (write to project `docs/`, then summarise to user)

---

## Decisions (resolved 2026-05-23)

| # | Question | Decision |
|---|---|---|
| 1 | Git tracking for `~/argus/` | **Own standalone repo** — referenced in claude-stack docs, evolves independently |
| 2 | Windows equivalent | **WSL2-only for now** — Windows can be added later; tmux and ccgram-argus are WSL2-native |
| 3 | Telegram routing | **All messages → Argus** — `main:argus` is the default landing window; Argus routes or delegates |
| 4 | Context freshness | **Git hook on `~/repos/`** — post-commit hook in each project repo triggers a `context/projects.md` refresh in Argus |

---

## Related Memory Keys

- `context/stack-overview` — current stack overview in MCP memory
- `project/ccgram-argus` — Telegram bridge runtime details
- `project/dev-stack/architecture` — WSL2 service architecture
- `tool/bw-secrets` — Bitwarden secrets pattern used across all deploy workflows
