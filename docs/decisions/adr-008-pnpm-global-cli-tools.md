---
title: ADR-008 — pnpm Standard with Global CLI Tool Installs
status: accepted
date: 2026-07-09
context: cross-project package manager policy
summary: "ADR-008: pnpm everywhere, dev CLI tools installed globally"
read_when:
  - adding a dependency or a dev CLI tool
---

# ADR-008: pnpm Standard with Global CLI Tool Installs

> **Canonical copy.** This is the one source for the cross-project pnpm global-CLI policy. The
> per-repo ADRs that record the same policy defer to it: myargus ADR-011 and atto1 ADR-002 record
> their repo's adoption and point back here; memory-mcp ADR-001 is superseded, since memory-mcp
> now lives in this repo ([#418](https://github.com/deanjstone/argus/issues/418)).

## Context

This repo already uses pnpm (`pnpm-lock.yaml`, `pnpm-workspace.yaml`) for app/package dependencies. What was undecided: how dev-only CLI tools (tsc, vite, eslint, tsx, etc.) get installed — as per-project devDependencies, or globally via `pnpm add -g`.

## Decision

- **App and package dependencies**: stay local, per-project, via `pnpm install` / `pnpm add`. No change.
- **CLI/dev tools** (linters, bundler CLIs, one-off codegen tools) that don't need per-project version pinning: install globally with `pnpm add -g <tool>`, not as local devDependencies.
- pnpm remains the sole package manager for this repo; no npm/yarn.

## Rationale

- Avoids reinstalling identical CLI binaries in every workspace package's `node_modules`.
- pnpm's global store already dedupes content-addressably, so global installs cost near-zero extra disk over local ones.
- Local `node_modules` stays leaner and faster to install for CI and fresh clones.
- Tools with real per-project version sensitivity (e.g. a bundler whose major version affects build output) still get pinned locally as a devDependency — this ADR doesn't override that when it matters.

## Consequences

- New dev tooling should default to `pnpm add -g` unless the project genuinely needs a pinned version checked into `package.json`.
- Contributors/CI need pnpm's global bin dir on `PATH` (already the case via `~/bin` config on this machine).
- No lockfile or workspace changes required — this only affects future tool additions.
