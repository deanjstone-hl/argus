---
title: ADR-002 — Argus Orchestrator Role Definition
status: accepted
date: 2026-06-02
context: docs/TODO.md — argus role investigation
supersedes: partially extends ADR-001
summary: "ADR-002: what work belongs in the argus orchestrator session and how it dispatches"
read_when:
  - deciding whether work belongs in the orchestrator session
---

# ADR-002: Argus Orchestrator Role Definition

> **Note (2026-10-31):** the `context/` directory this ADR names was removed in [#968](https://github.com/deanjstone/argus/issues/968). Its stack and project snapshots had gone stale, and project discovery is the SessionStart `projects-registry.sh` hook. The orchestrator workspace is `~/.argus/workspace/`.

## Context

The argus session has been running for several weeks. ADR-001 settled the tooling question (no external orchestrator framework). This ADR addresses the operational question: what work actually belongs in this session, and what structures need to be clarified or created for the role to function well?

The investigation covered four areas:

1. Role audit — what lands here vs what should be delegated
2. ADR-001 status — does the tooling decision still hold?
3. Session vs directory boundary — what is `~/argus/` for?
4. Dispatch patterns — when to use each method

---

## Findings

### 1. Role audit

The CLAUDE.md scope definition is accurate but lacks an *operative threshold* — a concrete guide for when to handle something in-session vs delegate. In practice this causes two failure modes:

**Over-delegation:** Spawning sub-agents for tasks that take one Bash command (e.g. `git pull` across six repos). Each spawn has cold-start cost, permission friction, and quota overhead. The 2026-06-02 Haiku agent experiment confirmed this — six agents, zero results, one direct command fixed it.

**Under-delegation:** Deep coding or long doc-writing tasks staying in the argus session context, burning quota that should have gone to a project session. Less visible but likely more costly.

**Operative threshold (new):**

| Work type | Handle in argus | Delegate |
|---|---|---|
| Shell commands < 5 steps | ✓ | |
| Reading/updating context/ or docs/ | ✓ | |
| Status queries, health checks | ✓ | |
| Single-project code changes | | ✓ (project session) |
| Research tasks > ~3 file reads | | ✓ (Explore agent) |
| Long doc generation | | ✓ (claude sub-agent) |
| Cross-project tasks touching > 2 repos | | ✓ (split agents) |

### 2. ADR-001 status

Still holds. The current stack (Agent tool + `claude --bg` + ccgram-argus) covers all dispatch needs encountered since May. No framework adoption warranted.

Ruflo/claude-flow remains on the watchlist. Re-evaluate if: (a) task queues with dependencies between steps become a recurring pattern, or (b) more than ~5 background sessions need coordinating simultaneously.

### 3. Session vs directory boundary

`~/argus/` serves two distinct purposes that are both intentional and worth keeping separate mentally:

**As a repo:** Persistent config and context — `CLAUDE.md`, `context/`, `docs/`, `hooks/`. This is read by the session on startup and updated as the stack evolves. It is the orchestrator's *brain*.

**As a working directory:** Where the session runs. Claude reads `CLAUDE.md` from `$CWD` on startup, so this coupling is load-bearing — the session must start here to pick up orchestrator identity.

The **gap** is `workspace/`. It exists as a directory but has no defined purpose or convention. It should serve as the orchestrator's *runtime scratchpad*: ephemeral notes, in-flight delegation state, and cross-session task queues that are too transient for `context/` but need to survive beyond a single conversation.

**workspace/ convention (new):**

```
workspace/
  tasks.md          — cross-session work queue (see below)
  scratch/          — ephemeral notes, drafts; not committed
  briefings/        — sub-agent prompt drafts for recurring task types
```

`tasks.md` is committed and git-tracked. `scratch/` is gitignored.

### 4. Dispatch patterns

A concrete decision tree rather than a lookup table:

```
Is the task < 5 shell commands with no research?
  → Yes: do it in argus directly (Bash tool)

Is the task read-only research across the codebase?
  → Yes: spawn Explore sub-agent

Does the task write files in a single project?
  → Yes: spawn claude sub-agent (Sonnet) with explicit Write tool instructions, run_in_background: true

Does the task write files + need Bash (installs, deploys)?
  → Spawn claude sub-agent (Sonnet); include Bash instructions; confirm permissions beforehand

Is the task fire-and-forget with long runtime (> ~10 min)?
  → claude --bg "..." in the target project dir

Does the task cross multiple repos?
  → Split into per-repo sub-agents; collate results in argus
```

**What never to delegate to Haiku:** Anything requiring Bash. Haiku sub-agents hit permission walls and return nothing. Haiku is only useful for read-only research (Read, grep, WebFetch).

### 5. CORTEX articles

CORTEX vault is not readable from this session. Action: user to surface relevant orchestration articles from CORTEX for extraction into `docs/reference/`. Flag for next review cycle.

---

## Decisions

1. **Operative threshold** adopted as above. Update CLAUDE.md to include it.
2. **workspace/ convention** adopted. Create `tasks.md`, `scratch/`, `briefings/`. Add `scratch/` to `.gitignore`.
3. **ADR-001 still holds** — no new tooling.
4. **Dispatch decision tree** added to `context/tools.md`.
5. **CORTEX articles** — deferred; requires user action.

---

## Consequences

- CLAUDE.md gains a dispatch threshold section — reduces ambiguity for future sessions
- `workspace/` has a defined purpose — persistent task queue without polluting `context/`
- Haiku-for-Bash anti-pattern is formally documented (also in memory and feedback files)
- No new tooling, no structural changes to the stack
