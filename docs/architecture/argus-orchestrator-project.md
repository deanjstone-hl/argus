---
created: 2026-05-30
modified: 2026-05-30
cssclasses: [hide-properties_reading]
type: wiki/projects
hall_type: facts
tags: [projects, argus, claude-code, orchestrator, wsl2, tmux]
sources: [[Argus Orchestrator Strategy]]
status: planning
summary: Historical 2026-05 project note for the Argus orchestrator session
read_when:
  - tracing the origin of the orchestrator design
---

# Argus Orchestrator — Project

Argus is a persistent, always-available Claude Code orchestrator agent on WSL2. Primary communication point for cross-cutting work: project actions, stack management, tool setup, and delegation to sub-agents via Telegram.

## What it is

A Claude Code CLI session running in a named tmux window (`main:argus`) that always starts in `~/argus/`. Not a daemon or custom service — just a Claude session with a permanent identity document (CLAUDE.md) and context docs.

The key change from ad-hoc Claude sessions: Telegram prompts land in **a named, persistent tmux window** with consistent CLAUDE.md loaded and memory restored at `SessionStart`.

## Architecture

```
iOS (Telegram) → ccgram-argus → Claude Code CLI (tmux main:argus)
                                      │
                                      ├── ~/argus/CLAUDE.md
                                      ├── ~/argus/context/ (stack.md, projects.md, tools.md)
                                      └── spawns sub-agents → ~/repos/*/
```

## In scope

- Stack management (settings.json, hook scripts, deploy workflows)
- Project bootstrapping (new repos, scaffolding, wiring into claude-stack)
- Cross-project tasks (anything touching multiple repos)
- Status queries ("what's running?", "what's deployed?")
- Delegation: breaking down tasks, spawning sub-agents
- Planning: drafting strategy docs

## Out of scope (delegate to project session)

- Deep coding within a single project
- Obsidian vault editing (separate CORTEX session)
- iOS Scriptable scripts

## Directory layout

```
~/argus/
├── CLAUDE.md         ← orchestrator identity, capabilities, rules
├── context/
│   ├── stack.md      ← canonical project map and service inventory
│   ├── projects.md   ← per-project summaries
│   └── tools.md      ← CLI tools, aliases, bw-secrets patterns
├── workspace/        ← scratch area for in-progress delegated work
├── docs/decisions/   ← ADRs for orchestrator-level decisions
└── logs/             ← not git-tracked
```

## Implementation phases

- [ ] **Phase 1** — Home directory + identity: `~/argus/` structure, CLAUDE.md, context docs, git repo
- [ ] **Phase 2** — tmux integration: argus window in `wsl2-boot.sh`, ccgram-argus verification, MCP memory at SessionStart
- [ ] **Phase 3** — Context maintenance: post-commit hook refreshing `context/projects.md`
- [ ] **Phase 4** — Sub-agent workflow: prompt templates, inline delegation test, result-collation pattern

## Decisions (resolved 2026-05-23)

| # | Decision |
|---|----------|
| 1 | Own standalone git repo at `~/argus/` |
| 2 | WSL2-only for now; Windows later |
| 3 | All Telegram messages → `main:argus` |
| 4 | Git post-commit hook per `~/repos/*` repo triggers context refresh |

## Related

- [[Dark Argus - Project]] — vault automation agent crew (CORTEX-side)
- [[Moshi WSL2 Stack]] — underlying tmux + Tailscale infrastructure
- [[Remote Agent Access]] — mobile access pattern
- [[Multi-Agent Orchestration]] — sub-agent patterns
