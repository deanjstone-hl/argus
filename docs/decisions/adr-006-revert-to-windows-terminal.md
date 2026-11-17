---
title: ADR-006 — Revert to Windows Terminal; Deprecate WezTerm Migration
status: accepted
date: 2026-06-22
summary: "ADR-006: stay on Windows Terminal + tmux; WezTerm and Zellij migration dropped"
read_when:
  - changing the terminal or multiplexer stack
---

# ADR-006: Revert to Windows Terminal; Deprecate WezTerm Migration

> **Supersedes** sys-admin
> [ADR-001 (Replace Windows Terminal with WezTerm)](https://github.com/deanjstone/sys-admin/blob/main/stack/docs/decisions/adr-001-replace-windows-terminal-with-wezterm.md)
> and [ADR-002 (Replace tmux with Zellij)](https://github.com/deanjstone/sys-admin/blob/main/stack/docs/decisions/adr-002-replace-tmux-with-zellij.md),
> both dated the day before this one. Both are marked `superseded` in sys-admin
> ([#418](https://github.com/deanjstone/argus/issues/418)).

## Context

In a prior session (2026-06-22), WezTerm was installed as a planned replacement for
Windows Terminal with tmux as the terminal multiplexer stack. The migration was in
progress: WezTerm installed, skills updated, ccbot Telegram bridge migration remaining.

The motivation was to consolidate on a GPU-accelerated, cross-platform terminal with
better multiplexer integration (Zellij was also being evaluated alongside).

After hands-on evaluation, the UI/UX of WezTerm did not meet expectations. Specific
concerns led to a decision to stop the migration before completing the ccbot integration
step.

## Decision

Deprecate the WezTerm migration. Remain on **Windows Terminal + tmux** as the terminal
stack. No further work on WezTerm configuration, Zellij evaluation, or ccbot migration
to WezTerm will be undertaken.

Skills that reference WezTerm launch patterns (`launch-claude`, `spawn-claude`) should
continue using `wt.exe` as the Windows Terminal entry point. The `wt.exe` patterns in
argus CLAUDE.md, context/tools.md, and hook scripts remain authoritative.
(`context/` was removed in [#968](https://github.com/deanjstone/argus/issues/968); the patterns live in the other two.)

## Consequences

- WezTerm is installed on Windows but will not be configured or used; it can be
  uninstalled at any time
- ccbot Telegram bridge migration TODO items referencing WezTerm are cancelled
- Windows Terminal remains the standard; no tab-color or profile changes are required
  beyond what is already in place
- Zellij evaluation is also dropped — tmux remains the session multiplexer
- The `project_wezterm_zellij_migration.md` memory entry should be updated to reflect
  the reversal
