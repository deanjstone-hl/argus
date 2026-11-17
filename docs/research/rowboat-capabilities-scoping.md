---
title: Rowboat Repo — Capability Extraction Scoping
date: 2026-07-18
status: draft
approved: false
tags: [plan, scoping]
---

> Moved from `deanjstone/myargus` `docs/rowboat-capabilities-scoping.md` in [myargus#309](https://github.com/deanjstone/myargus/issues/309). Bare `#N` issue references in this note are myargus issues.

# Rowboat → myargus capability scoping

Source: `~/repos/reference/rowboat` (rowboatlabs/rowboat, cloned read-only for pattern study — see `reference_rowboat_repo` memory).

## What's actually in the repo

Two unrelated products live in this monorepo — don't treat it as one thing to "port":

1. **`apps/rowboat` + `apps/cli` + `apps/python-sdk`** — the original Rowboat Labs SaaS: a multi-tenant Next.js multi-agent builder with billing/Stripe, org/project multi-tenancy, a Composio MCP-server marketplace UI. This is a hosted-SaaS product shape. myargus is single-user/personal-OS, not multi-tenant — the billing/org layer has no target here.
2. **`apps/x` (+ `apps/rowboatx` companion frontend)** — the newer desktop Electron "AI coworker": Gmail/Fireflies/Slack → Obsidian-style knowledge graph, a turn-oriented durable agent runtime, a second-pass LLM permission classifier, and four "work surfaces" (email client, notes, browser, code mode, meeting notes).

Almost everything worth taking is in `apps/x`, not `apps/rowboat`.

## Capability-by-capability assessment

| Capability | Rowboat location | myargus fit | Verdict |
|---|---|---|---|
| Knowledge graph ingest (email/Slack/meetings → graph) | `apps/x/packages/core/src/knowledge/` | Directly extends `apps/knowledge`'s already-stated roadmap ("ingest sources will expand beyond AI chats") | **Do — incremental extension of an existing app, not a new one** |
| Generic permission-gated external-tool interface (Composio discovery: list-toolkits → search-tools → execute-tool) | `apps/x/packages/core/src/runtime/tools/domains/composio.ts` | Reusable pattern for agent-engine's `ArgusRegistry` — lets Gmail/Slack/Calendar actions live behind one gated interface instead of bespoke `deleteEmail()`-style functions | **Do — adopt the pattern in agent-engine, not the Composio dependency itself** |
| Email client work surface (read/trash/send, permission-gated) | `apps/x/packages/core/src/knowledge/sync_gmail.ts`, email work surface UI | Matches the already-open `project_argus_email_feature` intent (Argus consuming/deleting email) | **Do — highest-value net-new hosted capability; already scoped elsewhere, this just confirms the reference pattern** |
| Turn-oriented durable agent runtime (JSONL event log, replay, pre-side-effect barrier) | `apps/x/packages/core/src/runtime/`, `turn-runtime-design.md` | Architectural upgrade for agent-engine's DAG executor — durability/replay is a real gap today | **Consider — infra hardening, not a new hosted app; medium effort** |
| Second-pass LLM auto-permission classifier (deny-by-default for destructive/broad-scope calls) | `apps/x/packages/core/src/security/auto-permission-classifier.ts` | Overlaps with existing auto-mode classifier work (`feedback_automode` memory) in argus-config/ccbot | **Consider — pattern reference for hardening auto-mode, not a myargus.cc app** |
| Meeting note taker (Fireflies-style transcript ingest + summarize) | work surface in `apps/x` | Feeds the same knowledge-graph ingest pipeline as email/Slack | **Fold into the knowledge-ingest expansion above, not a standalone feature** |
| Notes work surface | `apps/x` renderer (`live-notes-view.tsx`, `live-note-sidebar.tsx`) | Reconsidered — see below | **Do, narrowed scope** |
| Browser work surface (agent-controlled browser) | `apps/x` renderer (`BrowserPane.tsx`) + `runtime/tools/domains/browser.ts` | Reconsidered — see below | **Do, re-architected for web (no Electron)** |
| Code mode (agent writes/runs code) | `apps/x` renderer | Redundant — Claude Code already is the coding agent | **Skip** |
| Multi-project workspaces UI | `apps/rowboat` | Loosely mirrors the existing shell app dashboard; not worth replicating | **Skip** |
| Multi-agent visual builder + MCP marketplace | `apps/rowboat/app/projects/[projectId]/workflow`, `.../tools` | Reconsidered — see below (billing/multi-tenancy still excluded) | **Do, narrowed scope** |

## Reconsidered items (user flagged interest 2026-07-18)

### Notes work surface

Rowboat's version is **"live notes"** — not a static notes editor. A note has an `objective` field; a background agent runs periodically against it, appending updates (meeting prep docs, research notes that self-update as new knowledge-graph facts arrive). That's the differentiator from a plain CORTEX markdown page — the agent, not the user, keeps it current.

- **What to actually build:** a `live-notes` feature inside `apps/knowledge` (not a new app) — a note row with `objective`, `lastRunAt`, `isActive`; a scheduled/triggered agent-engine task (`feedback_loop` or a simple cron-style DAG task) that re-runs the objective against the current graph state and appends/edits the note body.
- **Depends on:** the knowledge-ingest expansion (item 2 above) actually landing first — a live note re-running against a graph with only chat-export data isn't very useful yet.
- **Hosting:** fits entirely inside `apps/knowledge` + agent-engine; no new subdomain, no new Supabase project.
- **Effort:** medium — mostly a scheduling/state-machine problem (start/stop/error-state per note) plus prompt design for the "re-run objective" agent call; UI is a straightforward CRUD list.

### Browser work surface

Rowboat's is an Electron `WebContentsView` layered under renderer chrome — that mechanism does not exist on the web. Cannot be ported as-is; needs re-architecture for a browser-hosted personal OS:

- **Two real options:**
  1. **Headless-browser-as-a-service on the homelab** — Playwright/Chromium running on the homelab box (already the "workhorse" pattern per `project_myargus_hosting`), driven by agent-engine tool calls, with either (a) a noVNC/CDP screen-cast streamed into a myargus web pane, or (b) fully headless (no live view, just action + screenshot-on-demand results returned to chat). Reuses the existing CF Pages portal / homelab workhorse / CF Tunnel template.
  2. **Client-side iframe pane with a fixed allowlist** — much cheaper, but can't do agent-driven navigation/clicks on arbitrary sites (X-Frame-Options/CSP blocks most sites in an iframe anyway) — effectively only useful for sites you control. Not a real substitute for (1).
- **Recommendation:** option 1, but scope it to **headless action-execution only** first (agent fills a form / extracts data / clicks through a flow and reports back), not a live interactive browsing pane — that's most of Rowboat's value (agent does web tasks for you) without building a streaming video pipe.
- **Security:** this is the highest-blast-radius item in the whole list — an agent with a real browser session can authenticate as you on arbitrary sites. Needs the same permission-gating Rowboat itself uses (`browser-control` tool behind explicit allow, not `none`/auto-allow) and should almost certainly reuse Rowboat's `browser-use`-style skill library (`load-browser-skill` — per-site selectors/gotchas) rather than free-roaming navigation.
- **Effort:** high — new homelab service, CDP/Playwright driver, tool-registry wiring in agent-engine, permission gating, and skill-library adoption or reimplementation.

### Multi-agent visual builder / MCP marketplace

Narrowing this to just the **workflow/tools UI** (`app/projects/[projectId]/workflow`, `.../tools`), explicitly excluding billing, org/project multi-tenancy, and the hosted MCP-server marketplace (myargus has one user, not a marketplace of installable third-party MCP servers to browse).

- **What's actually reusable:** the visual DAG/workflow editor UI pattern (nodes = agent-engine `DAGTask`s, edges = dependencies) as a front-end for **agent-engine's existing `ArgusPlanner`** — today DAG plans are generated by Haiku from a prompt; a visual builder would let you hand-author or edit a plan instead of only prompting for one.
- **Fit:** a new page, not a new app — most naturally lives in the myargus `shell` app (which already hosts the System Map at `/map`) as something like `/workflows`, calling agent-engine's HTTP API to submit/run a hand-built `DAGPlan`.
- **Effort:** medium-high — needs a node-graph editor (React Flow or similar), a `DAGPlan` JSON schema-to-UI mapping, and an agent-engine endpoint to accept a pre-built plan instead of only Haiku-generated ones (may already be possible via `/task/feedback` or a new `/task/run-plan` route — needs checking against current agent-engine routes).
- **No billing, no org/project multi-tenancy, no MCP marketplace browsing UI.**

## Recommended sequencing

1. **Email feature** (already tracked under `project_argus_email_feature`) — build the Gmail read/write surface using Rowboat's permission-gated generic-tool pattern instead of hand-rolled mutation functions. This is the one item with a concrete near-term payoff.
2. **Knowledge-ingest expansion** — extend `apps/knowledge`'s indexer to accept email/Slack/meeting-transcript sources using the same chunking/entity/graph pipeline already built for chat exports. No new app; new ingest adapters in the existing one.
3. **Agent-engine tool-registry pattern** — adopt the list→search→execute generic external-tool shape in `ArgusRegistry` so future integrations (Slack, Calendar) don't each need bespoke mutation code. Do this once #1 needs a second external integration, not speculatively now.
4. **Runtime durability + auto-permission classifier** — architecture references to revisit when agent-engine's DAG executor or the automode classifier next gets touched. Not scheduled work today.

Everything under "Skip" should not be revisited unless the user's needs change (multi-tenancy, agent-controlled browser, or a visual multi-agent builder become actual requirements).

## Why no new subdomain

None of the original "Do" items need a new `*.myargus.cc` app under ADR-008's URL taxonomy. Of the reconsidered items: live notes and the workflow builder also fold into existing apps (`apps/knowledge`, `shell`); the browser work surface is the one item that would need new homelab infrastructure (a Playwright/CDP service), not a new subdomain — it's called via agent-engine, not browsed to directly.

## Updated sequencing (2026-07-18)

1. Email feature (unchanged — highest near-term payoff, already open).
2. Knowledge-ingest expansion (unchanged — prerequisite for live notes).
3. **Live notes** — once #2 lands, layer the objective/re-run mechanism on top.
4. **Workflow builder** (`/workflows` in shell) — independent of #1–3, can be done in parallel; needs an agent-engine route check first.
5. **Browser work surface** — largest, highest-risk item; do last and scoped to headless action-execution only, with explicit permission-gating before any autonomous use.
6. Agent-engine tool-registry pattern / runtime durability / auto-permission classifier — unchanged, opportunistic infra work.
