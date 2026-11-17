---
title: /goal Command Evaluation
status: pending-test
date: 2026-05-24
context: agent-briefing.html P2 — Evaluate /goal for long-running tasks
summary: "Pending evaluation plan for Claude Code's /goal command"
read_when:
  - considering /goal for a long-running task
---

# /goal Command Evaluation

## What it does

`/goal "success condition"` sets an autonomous completion target in the current Claude Code session. Claude works across turns until the goal is met or it determines it is stuck. Pairs with Agent View for supervised autonomous sessions.

## Test approach

Run `/goal` on a scoped, verifiable task in a background session so the main session is not blocked.

**Recommended test task:** Pick a bounded coding task in an active project — e.g. adding a specific feature or fixing a known bug — where the success condition is objectively checkable (tests pass, endpoint returns expected value, file exists with correct content).

**Steps:**
1. Open a new session in the target project: `claude --bg "navigate to ~/repos/<project>"`
2. Or attach to an existing session and run `/rename test-goal`
3. Set the goal: `/goal "implement X such that Y is true — done when Z"`
4. Observe via Agent View (`claude agents`) or Telegram `/status test-goal`
5. Let it run without intervening — only step in if stuck for >10 min

## Key questions to answer

- Does `/goal` survive context compaction mid-task? Does it re-read CLAUDE.md after compact?
- Does it call for permission prompts on tool use, or does it attempt to proceed autonomously?
- How does it signal completion vs stuck? Does ccgram-argus pick up the state transition?
- Is the quality of outcome comparable to turn-by-turn supervision?
- Does it respect project-level `CLAUDE.md` instructions throughout?

## Quota note

A `/goal` session running autonomously will consume quota continuously. Use `/compact` before starting if the context is large. Monitor via ccgram-argus amber/red warnings.

## Status

Not yet tested as of 2026-06-02. Update this doc with findings after first real run.
