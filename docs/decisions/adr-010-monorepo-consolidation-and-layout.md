---
title: ADR-010 — Monorepo Consolidation; apps/ vs packages/ Placement Rule
status: accepted
date: 2026-08-17
supersedes: ADR-007
summary: "ADR-010: argus is the consolidated monorepo; apps/ vs packages/ placement rule"
read_when:
  - adding or moving a package
  - deciding between apps/ and packages/
---

# ADR-010: Monorepo Consolidation; `apps/` vs `packages/` Placement Rule

> **Update ([#1173](https://github.com/deanjstone/argus/issues/1173)):** the email packages named below (`apps/email`, `apps/email-worker`, `apps/email-mcp`) now live in [`deanjstone/email`](https://github.com/deanjstone/email) or were removed; paths below are history.

## Context

ADR-007 (2026-07-04) decided to split argus into focused repositories, on the reasoning that
deployment boundaries did not map to repository boundaries and that argus should shrink to a
stable orchestration surface. That is not what happened. Between 2026-07 and 2026-08 the
[argus-infra consolidation](https://github.com/deanjstone/argus/issues/163) ran the opposite
direction, folding six repos *in* via `git subtree`: `ccbot`, `code-relay`, `watchtower` (split
three ways), and `argus-context`'s `mcp-server` / `wiki` / `vault-core`. ADR-007 was never
superseded, so `docs/decisions/` still describes a repo strategy the codebase abandoned a month
ago — actively misleading to anyone, human or agent, deciding where new code belongs.

The consolidation also exposed a second gap: **nothing in the repo defines what `apps/` means
versus `packages/`.** Not `AGENTS.md`, not `.claude/SYSTEM.md`, not any ADR. Placement was
decided per-merge by whoever landed the subtree, and the result carries no information:

- `packages/email` is a deployed Cloudflare Worker (`wrangler.jsonc`, D1 migrations).
- `packages/email-mcp` is a deployed Worker *and* a stdio MCP server — structurally identical to
  `apps/mcp-server`, which sits in `apps/`.
- `packages/vault-core` is the only genuine library, and nothing imports it: a search for
  `workspace:`-protocol dependencies across every `package.json` in the repo returns zero.

So `packages/` currently holds two deployable Workers and one dormant library, while `apps/`
holds a CLI, an HTTP server, a systemd bot, a PWA, a Vite site, two pollers, a Worker, and a
doc generator. The distinction does no work, and the naming compounds it: the two MCP surfaces
use opposite schemes (`mcp-server` vs `email-mcp`) in different top-level directories.

## Decision

**1. The consolidated monorepo is the intended end state.** ADR-007 is superseded. New work
belongs in this repo unless it has a genuine reason to be standalone (a different account, a
public OSS surface, or a hard licensing boundary). The three related repos in `AGENTS.md`
(`argus-config`, `sys-admin`) stay separate because they are machine configuration, not product
code — the boundary ADR-003 already draws.

**2. Placement rule:**

- **`apps/*`** — an independently deployable or runnable unit. It has a runtime target: a
  systemd service, a Cloudflare Worker, a CLI binary, or a deployed site. If it can be started,
  deployed, or invoked on its own, it is an app.
- **`packages/*`** — an importable library, consumed by other workspace members via the
  `workspace:*` protocol, never deployed on its own. If nothing imports it and it has no runtime
  target, it does not belong in `packages/` — it belongs in `apps/`, or it should not exist.

The nested-workspace question (`code-relay`, `mcp-server`, `wiki`) is orthogonal and unchanged:
a package's own internal pnpm workspace determines whether the root `pnpm-workspace.yaml`
excludes it, not which top-level directory it lives in.

**3. Naming rule:** a package directory is named for its **domain**, not its mechanism. Agent
tool surfaces take a `<domain>-mcp` suffix. Concretely this renames `apps/mcp-server` →
`apps/memory-mcp` and moves `packages/email` → `apps/email-worker`, `packages/email-mcp` →
`apps/email-mcp`.

## Consequences

- `packages/` retains exactly one member, `vault-core`, and regains a meaning: things in it are
  libraries. It stays despite having no current importers, because it is scaffolded shared
  schema that `memory-mcp` and `wiki` are intended to consume — but under this rule, a
  `packages/` member that is still unimported at its next review is a deletion candidate, not
  a permanent resident.
- Three directory moves follow, each touching `deploy.sh`, `wrangler.jsonc` worker names,
  release tracks, and CI paths. They land as their own PR.
- `mcp-server` → `memory-mcp` changes a deployed Worker's package name but not its public
  hostname (`memory.myargus.cc`) or its MCP tool namespace (`claude-memory`).
- Future subtree merges answer two independent questions: deployable-or-library (this ADR) and
  nested-workspace-or-flat (`AGENTS.md`, "Subtree-merged packages").
