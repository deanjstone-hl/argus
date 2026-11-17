---
title: ADR-001 — Multi-Agent Orchestrator Evaluation
status: accepted
date: 2026-05-24
context: agent-briefing.html P2 — Assess orchestrator options alongside Agent View
summary: "ADR-001: no external multi-agent orchestrator (Claude Squad, Plandex, Ruflo rejected)"
read_when:
  - considering an orchestrator framework
---

# ADR-001: Multi-Agent Orchestrator Evaluation

## Context

Agent View (Claude Code v2.1.139+) is now integrated into the stack via ccgram-argus. It provides a supervision dashboard for background sessions launched with `claude --bg`. The question is whether a dedicated orchestrator layer is needed to handle dispatch and task chaining above this.

Three candidates were evaluated: Claude Squad, Plandex, and Ruflo (claude-flow).

## Evaluation

### Claude Squad (smtg-ai/claude-squad · v1.0.17 · March 2026)

A Go TUI that owns and manages Claude Code sessions internally via its own tmux layer. Does not emit `claude --bg` or integrate with Agent View. Requires an interactive terminal. Would collide directly with the existing tmux layout and ccgram-argus hooks.

**Verdict: Poor fit.** Replaces the stack rather than extending it.

### Plandex (plandex-ai/plandex · cloud defunct Nov 2025)

A self-contained AI coding agent that calls LLM APIs directly — it is not a Claude Code wrapper. Has no concept of `claude --bg` or Agent View. Cloud backend shut down; self-host only with slowing development.

**Verdict: Poor fit.** Wrong abstraction level and declining trajectory.

### Ruflo / claude-flow (ruvnet/ruflo · v3.6.12 · May 2026)

The closest architectural match. Headless, WSL2-native, installs via Claude Code hooks (`npx claude-flow init`), and orchestrates via MCP subagent calls rather than replacing Claude Code. Supports agent DAGs and shared vector memory. 31k GitHub stars, actively maintained.

Risks:
- Installs hooks on init — requires auditing against existing ccgram-argus hook config before enabling
- Orchestrates via MCP/subagent calls, not explicit `claude --bg`; Agent View visibility of spawned tasks is unconfirmed
- Heavyweight footprint (314 MCP tools, WASM, HNSW memory) for what may be a simple dispatch need

**Verdict: Partial fit. Worth prototyping with hook audit first.**

## Decision

**None of the three tools are adopted now.** The immediate multi-agent dispatch need is met by the existing stack:

- `claude --bg` + Agent View for background session launch and supervision
- ccgram-argus Telegram bridge for remote visibility and control
- Argus CLAUDE.md `Agent` tool for structured sub-agent delegation

If a dedicated dispatch layer is needed later (task queues, dependency chaining across sessions), the preferred path is:

1. **First option:** A lightweight custom shell/Node dispatcher that reads a task queue and shells out `claude --bg "..."` — simpler than adopting a framework
2. **Second option:** Prototype Ruflo with a careful hook audit, confirming ccgram-argus hook compatibility and Agent View visibility of spawned sessions before committing

## Consequences

- No new tooling introduced
- Ruflo remains on the watchlist — re-evaluate when a concrete DAG-style task chaining need arises
- Plandex and Claude Squad are closed
