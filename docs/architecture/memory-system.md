---
title: Memory System
status: superseded
superseded_by: deanjstone/memory-mcp docs/CONVENTIONS.md
implemented: 2026-06-06
tags: [memory, cortex, architecture]
summary: Superseded 2026-06 memory design; the canonical spec is docs/CONVENTIONS.md in deanjstone/memory-mcp
read_when:
  - tracing how the memory system evolved
---

# Memory System

> **Superseded — historical record of the 2026-06 design, not current state.** Canonical spec:
> [`docs/CONVENTIONS.md` in `deanjstone/memory-mcp`](https://github.com/deanjstone/memory-mcp/blob/main/docs/CONVENTIONS.md). What changed:
>
> - Memory lives in the `~/CONTEXT` vault, not `CORTEX/MEMORY/`. The index is `~/CONTEXT/MEMORY.md`;
>   topic files are under `~/CONTEXT/02.MEMORY/`. The `~/.claude/memory` symlink was removed
>   (argus-config#94, context#55); `autoMemoryDirectory` points at `~/CONTEXT` directly.
> - The store is authoritative, not disk. The only write path is the `memory_remember` MCP tool,
>   which writes the row and the mirror file together; hand-edited files never reach the store.
> - New memories land in `~/CONTEXT/00.INBOX/` until the filing agent moves them.
> - The SessionStart `sync-files-to-supabase` hook still runs, but only as a backstop for files that
>   arrive outside `memory_remember`, not as the write path.
> - The `~/.argus/daily-consolidation.sh` flag, the `staged/` drafts and the ccbot hooks below are
>   retired. Consolidation now arrives as a pull request on the CONTEXT vault.
>
> Kept for the design reasoning only. Treat every path and hook below as historical unless
> CONVENTIONS.md says otherwise.

Cross-platform, self-improving memory for Claude Code across WSL2, Windows, and iOS.

## Architecture overview

```
~/.claude/memory/  →  symlink  →  CORTEX/MEMORY/
                                          ↕
                                  Syncthing (Synctrayzor)
                                          ↕
                                  Windows (Obsidian / VSCode)
                                          ↕
                                  iOS (SyncTrain / Obsidian)
```

Disk files are canonical. Supabase (mcp-memory) is the search layer, kept current automatically.

---

## Layer map

| Layer | What | Location | Loaded |
|-------|------|----------|--------|
| L0 | Identity / global rules | `~/.claude/CLAUDE.md` | Always (auto) |
| L0 | Argus orchestrator rules | `~/argus/CLAUDE.md` | Always (auto, Argus only) |
| L1 | Memory index | `~/.claude/memory/MEMORY.md` | Always (system context) |
| L2 | Memory files | `~/.claude/memory/*.md` | On demand |
| L2 | Per-project learnings | `<project>/LEARNINGS.md` | On demand |
| L3 | Deep vault search | `CORTEX/REFERENCE/` | Via cortex-search skill |
| L4 | Consolidation drafts | `~/.claude/memory/staged/` | Human review only |

---

## Memory types

| Type | Purpose | Example files |
|------|---------|---------------|
| `user` | Who Dean is, preferences, expertise | `user_windows_gpu.md` |
| `feedback` | How to work — corrections and confirmations | `feedback_agent_prompts.md` |
| `project` | Active project context, status, key paths | `project_argus.md` |
| `reference` | Where to find things in external systems | `reference_local_llm_ollama.md` |

---

## Cross-platform access

| Platform | Access method | Read | Write |
|----------|--------------|------|-------|
| WSL2 Claude Code | `~/.claude/memory/` symlink | ✅ | ✅ |
| Windows Obsidian | `CORTEX/MEMORY/` direct | ✅ | ✅ |
| Windows VSCode | Same path | ✅ | ✅ |
| iOS Obsidian | Syncthing → SyncTrain | ✅ | ✅ |
| MCP Supabase | Auto-sync on SessionStart | ✅ (search) | auto |

---

## Learning loop

Baked into `~/.claude/CLAUDE.md`. At the end of any session where:
- a correction was made
- a preference was expressed
- a significant project decision happened
- a new workaround or pattern was discovered

→ Claude proactively proposes and writes memory entries without waiting to be asked.
Apply filter: *would this change how I act next time?*

### `/remember-session` skill

On-demand extraction. Scans the conversation, applies the filter, writes entries to
`~/.claude/memory/` + updates `MEMORY.md`. Also writes a session summary to
`~/.claude/memory/sessions/YYYY-MM-DD-session-name.md`.

---

## Episodic layer

### Session stubs (`sessions/`)

`SessionEnd` hook → `~/.argus/session-stub.sh`:
- Fires when a named session closes (`/rename` was used)
- Writes `sessions/YYYY-MM-DD-session-name.md` with timestamp + cwd
- No-op if `/remember-session` already wrote a full summary

### Subagent log (`sessions/subagents.md`)

`SubagentStop` hook → `~/.argus/subagent-log.sh`:
- Appends one row per completed background agent
- Columns: date, time, parent session, cwd, stop reason
- Running append-only table; queryable via cortex-search

---

## Per-project learning (LEARNINGS.md)

Each active project should have a `LEARNINGS.md` in its root. Template at
`CORTEX/SYSTEM/templates/project learnings template.md`.

Argus appends to it after sub-agents complete if they produced architectural
decisions, gotchas, or confirmed patterns. Sections:

- Architectural decisions
- Known gotchas
- Patterns that work
- Mistakes to avoid
- Key files

---

## Supabase sync (auto, Phase 4)

`SessionStart` hook → `~/repos/argus/apps/memory-mcp/scripts/sync-files-to-supabase.ts`:
- Reads every typed page in `~/CONTEXT/02.MEMORY/*.md`, then lists live rows and tombstones once
- Matches each page to its typed row by the mirror's file-name rule and writes only a changed body, under that row's key
- Creates a typed row (key = file stem) for a page no row claims; skips a page whose key was forgotten or that sits beside a live untyped row ([#747](https://github.com/deanjstone/argus/issues/747), [#749](https://github.com/deanjstone/argus/issues/749))
- Never deletes a row ([#720](https://github.com/deanjstone/argus/issues/720)); always exits 0 — never blocks session start

Disk files are canonical. **No manual dual-write required.**

---

## Daily consolidation (Phase 5)

Argus-only `SessionStart` hook → `~/.argus/daily-consolidation.sh`:
- Writes `~/.argus/consolidation-due` flag once per day (day-guard via `~/.argus/last-consolidation-date`)
- No-op on subsequent sessions same day

Argus CLAUDE.md instructs Claude to run when flag is present:
1. Read all `~/.claude/memory/*.md`
2. Identify: duplicates, stale entries, promotion candidates, index drift
3. Write `~/.claude/memory/staged/consolidated-draft-YYYY-MM-DD.md`
4. Remove flag, report one line

**Never auto-applies.** Staged draft is for human review in Obsidian (Windows/iOS).

---

## Hook wiring summary

> **Historical (ccbot sections).** ccbot-argus is decommissioned (argus#302) and its source was removed in #407. The `ccbot enhanced-hook-notify` rows below describe the integration as it was built and are kept as a record. Their hook entries were removed in argus-config#215.

| Event | Script | Effect |
|-------|--------|--------|
| `SessionStart` (global) | `ccbot enhanced-hook-notify session-start` | Telegram notification |
| `SessionStart` (global) | `mcp-memory/scripts/sync-todos.mjs` | Rebuild docs/TODO.md |
| `SessionStart` (global) | `mcp-memory/scripts/sync-files-to-supabase.mjs` | Sync disk → Supabase |
| `SessionStart` (Argus only) | `~/.argus/daily-consolidation.sh` | Write consolidation flag once/day |
| `SessionEnd` (global) | `ccbot enhanced-hook-notify session-end` | Telegram notification |
| `SessionEnd` (global) | `~/.argus/session-stub.sh` | Write episodic stub |
| `SubagentStop` (global) | `ccbot enhanced-hook-notify subagent-done` | Telegram notification |
| `SubagentStop` (global) | `~/.argus/subagent-log.sh` | Append to subagents.md |

---

## Key file locations

| File | Purpose |
|------|---------|
| `~/.claude/memory/` | Symlink → `CORTEX/MEMORY/` |
| `~/.claude/memory/MEMORY.md` | L1 index — loaded every session |
| `~/.claude/memory/sessions/` | Episodic session log |
| `~/.claude/memory/staged/` | Consolidation drafts (review before applying) |
| `~/.argus/daily-consolidation.sh` | Day-guard script |
| `~/.argus/consolidation-due` | Flag: consolidation pending |
| `~/.argus/last-consolidation-date` | State: last consolidation date |
| `~/.argus/session-stub.sh` | SessionEnd stub writer |
| `~/.argus/subagent-log.sh` | SubagentStop log appender |
| `~/repos/argus/apps/memory-mcp/scripts/sync-files-to-supabase.ts` | Disk → Supabase sync |
| `~/.claude/skills/remember-session/SKILL.md` | `/remember-session` skill |
| `CORTEX/SYSTEM/templates/project learnings template.md` | LEARNINGS.md template |

---

## What's not automated

- **Applying consolidation drafts** — human reviews `staged/` and decides what to merge, delete, or promote
- **Creating LEARNINGS.md** — Claude creates it when relevant; you can also create manually from the template
- **iOS writes back** — edits made in Obsidian iOS sync to Windows via Syncthing, then WSL2 sees them via `/mnt/c/`

---

## Future (not yet built)

- Activate memory-mcp bidirectional Supabase↔Supabase sync (local ↔ remote instances)
- Semantic search over memory via Supabase embeddings (currently plain-text only)
