---
title: Repo-survey — ecosystem overlap with herdr/collie/herdr-remote
status: complete
created: 2026-08-05
ticket: https://github.com/deanjstone/argus/issues/130
map: https://github.com/deanjstone/argus/issues/129
---

# Repo-survey: ecosystem overlap with herdr / collie / herdr-remote

## Question

Survey argus-ecosystem repos for existing overlap with herdr / collie / herdr-remote
capabilities, before any adoption decision is made on where they land. This document
feeds two downstream decision tickets: herdr adoption depth per component, and
collie-vs-herdr-remote as reference architecture.

## Method

Read each candidate repo's `CLAUDE.md`/`README.md` and the actual source files that
implement the relevant surface (not just the one-line projects-registry description),
directly in `~/projects/`. Scanned the rest of `~/projects/` for any other repo owning
an interactive terminal/agent-session or remote-monitoring surface. Fetched
`herdr-remote`'s GitHub README for comparison context on its tunnel architecture.

## Findings, ranked by overlap strength

### 1. `code-relay` (~/projects/code-relay) — strongest conceptual overlap, weakest current implementation

**What it is today:** A pnpm-workspace monorepo — Vite/React/Tailwind PWA
(`apps/web`) + Fastify backend (`apps/server`) — described in its own `CLAUDE.md` as
"Provider-agnostic PWA remote console for AI coding agents"
(`~/projects/code-relay/CLAUDE.md:3`). Its PRD (`docs/PRD.md`) states the vision in
almost identical terms to collie/herdr-remote: *"a mobile-first interface for
interacting with AI coding agents running on trusted infrastructure... provider-agnostic
through a unified backend abstraction layer,"* pitched as **"GitHub Mobile for AI
coding agents"** (`docs/PRD.md:12-18`). Backend binds to Tailscale IP only, no public
exposure (`docs/PRD.md:101`, `CLAUDE.md:20`) — same tailnet-only stance as collie and
the house policy (never `tailscale funnel`).

**What's actually built vs. still a plan:** The PRD's actual differentiators are
**not implemented yet**. `docs/TODO.md` still lists as open backlog items: *"ACP
integration — connect server to Claude Code ACP socket," "brrr.now integration,"*
*"PWA manifest,"* *"Tailscale cert,"* *"systemd service"* (`docs/TODO.md:9-16`). What
exists today (`apps/server/src/routes/sessions.ts`, `engine.ts`, `projects.ts`) is a
thin Fastify proxy: `/sessions/launch` forwards to an env-configured
`LGN5_LISTENER_URL` (a listener on the Windows box, `LGN5`) to launch a session, and
`/run` + `/search` proxy straight through to agent-engine's `/chat` and
`/vector/search` endpoints (`apps/server/src/routes/engine.ts:23-53`). The PWA
(`apps/web/src/App.tsx`) is a 3-tab shell — Launch / Run / Search — with no
streaming session view, no approval drawer, no per-agent state model. None of the
`RelayEvent` normalized-event-stream types defined in the PRD
(`SessionStarted`, `ApprovalRequested`, `ToolInvoked`, etc., `docs/PRD.md:79-93`) are
implemented in source yet — they're a design, not code.

**Overlap with herdr/collie/herdr-remote:** Functionally the *closest match in intent*
of any repo surveyed — same "remote console for coding agents over Tailscale, with
push notifications and approvals" shape as collie, explicitly modeled on the same
problem herdr-remote solves (their tagline literally borrows "GitHub Mobile"-style
framing). But it is materially earlier-stage: collie and herdr-remote both already do
real-time per-agent state monitoring and pane control today; code-relay's session
model is a single `/launch` proxy call with no live event stream back. It duplicates
part of agent-cli's job too — `sessions.ts`/`projects.ts` talk to the same kind of WT
tab-launch listener concept as agent-cli's `wt.ts`, just fronted by a mobile PWA
instead of a CmdPal/CLI picker.

**Adoption-candidate assessment:** Strong candidate for replacement *by* collie or a
herdr-remote-architecture build — it is pursuing the exact same destination the map
issue's part (b) is deciding between, just not there yet. Weaker candidate to be the
thing herdr/collie get bolted *onto*, since it owns no actual session/pane substrate
of its own (it delegates launch to LGN5 and chat to agent-engine). Its biggest asset
is the PRD itself: the `RelayEvent` schema and approval-drawer/push-notification
design in `docs/PRD.md` is a well-thought-out spec that could be either retired in
favor of herdr-remote's already-built equivalent, or kept as the UX target if collie
is judged too herdr-specific.

### 2. `ccbot` (~/projects/ccbot) — direct architectural overlap with herdr's session-state model

**What it does today:** Telegram (plus Slack/Matrix/LINE/email channel adapters —
see `~/projects/ccbot/src/channels/`) bridge for remote supervision of Claude Code
sessions (`CLAUDE.md:3`). Two load-bearing pieces:

- `src/utils/agent-view-monitor.ts` polls `claude agents --json` every 15s and emits
  `sessionAdded`/`sessionRemoved`/`sessionStateChanged`/`sessionStuck`/`goalUpdated`
  events over an `AgentSession` model with states `running | waiting | stuck |
  completed` (`agent-view-monitor.ts:4,17-23`). This is functionally the same shape
  as herdr's semantic per-agent state detection (blocked/working/done/idle) described
  in the ticket background — but ccbot derives it by polling the Claude Code CLI's own
  `agents --json` output rather than herdr's socket API.
- `src/utils/tmux.ts` is a thin wrapper around the `tmux` binary
  (`has-session`, `list-sessions`, `send-keys`, etc., `tmux.ts:1-50`) used by
  `relay/background-session-bridge.ts` and `tmux-monitor.ts` to translate monitor
  events into Telegram pushes and to relay commands like `/compact [workspace]` back
  into the named tmux session (`CLAUDE.md:41`).

**Overlap:** This is the piece of the ecosystem closest to herdr's actual
value proposition — persistent session multiplexing + semantic state detection +
remote command injection — except built on raw `tmux` + CLI polling instead of
herdr's purpose-built socket API (`agent.wait`, `pane.report_agent`, `pane.read`,
event subscriptions). Herdr's model is a superset: it also gets you
detach/reattach-over-SSH and a plugin marketplace (which is how collie itself
attaches). ccbot's Telegram surface is the actual "remote-access model" half of the
map's part (b) — a working, already-shipped competitor to what collie/herdr-remote
also do via Telegram bot / phone web app.

**Adoption-candidate assessment:** Stronger candidate than code-relay for **herdr
adoption depth part (a)** specifically, because it already owns real session-state
logic that herdr's engine could directly replace (swap `agent-view-monitor.ts`'s
`claude agents --json` poll for herdr's `pane.report_agent`/event-subscription API,
swap `tmux.ts` calls for herdr's socket commands). Its Telegram channel is also a
plausible target for whichever remote-access architecture wins part (b) — herdr-remote
already ships a Telegram bot client, so if herdr-remote's architecture is adopted,
ccbot's Telegram bridge could become redundant with — or a merge candidate for —
herdr-remote's own bot rather than something to keep maintaining in parallel.

### 3. `agent-cli` (~/projects/argus/packages/agent-cli) — narrower overlap, but real

**What it does today:** `src/lib/wt.ts` launches Windows Terminal tabs
(`wt.exe new-tab ... wsl.exe -e bash -ic ...`) running `claude --name <label>`
(`wt.ts:39-49`). As already known from the ticket background, this is `wt.exe`-specific
and tabs die when the window closes — no persistence, no detach/reattach, no
socket-level introspection of the running session. `src/lib/engine.ts` and
`src/commands/*` are the CLI's project-picker/engine-client surface, not a
session-multiplexing layer.

**Overlap:** This is the *launcher* half of what herdr replaces — herdr's
workspace/tab/pane hierarchy with persistent client/server split (detach/reattach
incl. over SSH) is a strict superset of what `wt.ts` does. It owns no monitoring or
remote-access surface at all (that's ccbot's job); its overlap with herdr is purely
"process launch + terminal tab," the shallowest of the three repos surveyed.

**Adoption-candidate assessment:** Straightforward replace target for herdr's launch
layer specifically — the map issue's own framing ("replacing `wt.exe` in agent-cli")
matches what's in the source. Not a candidate for the remote-monitoring half at all;
it has no code in that space to replace.

### 4. Two more terminal/session launchers found scanning `~/projects/` — not named in the ticket, but in scope

The ticket asked to scan the rest of `~/projects/` for repos owning an interactive
terminal/agent-session surface. Two more turned up beyond agent-cli/ccbot/code-relay:

- **`cmdpal` (`deanjstone/cmdpal-argus`, ~/projects/cmdpal)** — a Windows CmdPal
  (PowerToys) extension that enumerates `~/projects/` in WSL2 and launches a `claude`
  session via Windows Terminal + tmux. Per its `CLAUDE.md`: *"`LaunchClaudeCommand.Invoke()`
  calls `ShellHelpers.OpenInShell("wt.exe", ...)` with a bash command that tries
  `tmux new-window` first, then falls back to a plain WT tab"*
  (`~/projects/cmdpal/CLAUDE.md:22`). This is a **third** independent implementation of
  the same "launch an agent session in a terminal tab, optionally via tmux" problem
  that agent-cli's `wt.ts` and code-relay's LGN5-listener proxy both also solve, from
  a different entry point (Windows Command Palette instead of a CLI or PWA). It's a
  legitimate herdr-launch-layer replacement candidate for the same reason agent-cli is,
  and worth folding into the same adoption-depth ticket rather than treating as a
  fourth separate decision — three repos independently reimplementing "launch claude
  in a terminal tab" is itself a signal that a shared herdr-based launch layer would
  collapse real duplication.
- **`hearth-fork` / `hearth-fork-rust-eval` (upstream `deanjstone/Hearth`, evaluated
  under `~/projects/hearth-fork*`)** — a self-modifying Electron (evaluating a
  Tauri/Rust port) desktop client for coding agents, with its own MCP server
  (`view_app`, `read_ui`, `click`, `fill`, `eval_js`) letting the agent see and drive
  its *own* UI (`~/projects/hearth-fork/CLAUDE.md:13-34`). This is a different problem
  axis from herdr/collie/herdr-remote: it's a local desktop GUI for one agent editing
  its own interface, not a session multiplexer or a remote-monitoring surface for
  supervising *other* agent sessions. No socket-API/pane-hierarchy overlap with herdr,
  and no phone/Telegram remote-access overlap with collie/herdr-remote. **Not a
  relevant adoption candidate** — flagged here only to record that it was checked and
  ruled out, per the ticket's "scan the rest of `~/projects/`" instruction.

### 5. `watchtower` (~/projects/watchtower) — ruled out, purpose confirmed unrelated

The ticket flagged watchtower's purpose as unconfirmed. Its `README.md` is the unedited
Vite/React template (no project-specific content), so `HANDOFF.md` was read instead.
It is a **service-health monitoring dashboard**: a homelab collector polling
systemd/disk/uptime, Syncthing, Cloudflare, and Supabase-project status into a
`service_checks` Postgres table, with a passkey-gated Supabase-Realtime dashboard
frontend (`~/projects/watchtower/HANDOFF.md:1-21`). This is infrastructure/service
uptime monitoring, not interactive terminal or coding-agent session monitoring — zero
overlap with herdr's pane model or collie/herdr-remote's per-agent remote access.
**Not a relevant candidate; can be dropped from further consideration in this map.**

### 6. Everything else scanned in `~/projects/` — no overlap found

Checked `CLAUDE.md`/`README.md` for: `mcp-memory` (Supabase-backed MCP memory server —
no terminal/session surface), `myargus` (household/shell web-app monorepo), `sys-admin`
(machine-config repo, explicitly scoped to *how machines are configured*, not agent
sessions), `argus-wiki` (a vendored fork of `langchain-ai/openwiki`, unrelated), plus
quick top-of-file checks on `atto1`, `airllm-eval`, `ant-eval`, `scriptable-private`,
`design-system`, `erto-apps`, `budget`, `ios-scripts`, `homelab`, `argus-context`,
`wedding-new-name`, `wedding-website`. None own an interactive terminal/agent-session
or remote-monitoring surface. Not detailed further here.

## herdr-remote comparison context (for the collie-vs-herdr-remote decision ticket)

Fetched `github.com/dcolinmorgan/herdr-remote`'s README directly for architecture
context (not a primary-source deep-dive, per the ticket's scope — just enough to sanity
check the map's framing):

- Three client layers (macOS menu bar app, phone web app, Telegram bot) connect via
  WebSocket to a central relay server, which polls local herdr instances or receives
  HTTP POST pushes from remote agents via a `herdr-push` plugin.
- **The relay is exposed publicly via Cloudflare Tunnel (`cloudflared`)** — this
  directly confirms the map issue's flagged tradeoff: the "no Tailscale needed" tagline
  is a public-tunnel architecture, which conflicts with the house's tailnet-only stance
  (`tailscale serve`, never `funnel`). Any adoption of herdr-remote's *architecture*
  would need its tunnel model replaced with a tailnet-bound equivalent, not adopted
  as-is.
- Reasonable maturity signal: 183 stars, 26 forks, but only ~112 total commits — a
  real but not deeply battle-hardened project, comparable in size to collie.

## Summary table

| Repo | Owns today | herdr pane/session overlap | collie/herdr-remote remote-access overlap | Adoption-candidate strength |
|---|---|---|---|---|
| `code-relay` | PWA + Fastify proxy shell (launch/run/search), PRD for full remote console | Low (delegates launch, no pane model) | High *in design*, low *in code* — closest conceptual match, least built | Strong candidate to be **replaced by** collie/herdr-remote-style architecture; PRD worth salvaging as UX spec |
| `ccbot` | tmux bridge + CLI-poll session-state model + multi-channel (Telegram/Slack/Matrix/LINE/email) remote supervision | High — same state-model problem herdr solves, via CLI polling instead of socket API | High — Telegram bot already shipped, functionally overlaps herdr-remote's Telegram client | Strongest candidate for **herdr adoption depth** (swap tmux+polling for herdr's socket API); Telegram surface may merge with or cede to herdr-remote's bot |
| `agent-cli` | `wt.exe` tab launcher, no persistence | Medium — pure launch-layer overlap, no monitoring | None | Clear replace target for herdr's launch layer specifically (matches ticket's own framing) |
| `cmdpal` (cmdpal-argus) | Windows CmdPal → `wt.exe`/tmux launcher | Medium — same launch-layer overlap as agent-cli, independently implemented | None | Same bucket as agent-cli — fold into the same launch-layer adoption decision, don't treat separately |
| `hearth-fork`/`Hearth` | Self-editing desktop GUI for one agent's own UI | None | None | Not a candidate — different problem axis, ruled out |
| `watchtower` | Infra/service-uptime dashboard | None | None | Not a candidate — ruled out, purpose confirmed |
| everything else scanned | — | None | None | Not relevant |

## Sources

- `~/projects/code-relay/CLAUDE.md`, `docs/PRD.md`, `docs/TODO.md`,
  `apps/server/src/routes/{sessions,engine,projects}.ts`, `apps/web/src/App.tsx`,
  `apps/web/src/components/LaunchForm.tsx`, `apps/server/src/index.ts`
- `~/projects/ccbot/CLAUDE.md`, `src/utils/agent-view-monitor.ts`, `src/utils/tmux.ts`
- `~/projects/argus/packages/agent-cli/src/lib/wt.ts`
- `~/projects/cmdpal/CLAUDE.md`, `README.md`
- `~/projects/hearth-fork/CLAUDE.md`
- `~/projects/watchtower/HANDOFF.md`, `README.md`
- `~/projects/{mcp-memory,myargus,sys-admin,argus-wiki}/CLAUDE.md` or `README.md`
  (top-level, for exclusion)
- `github.com/dcolinmorgan/herdr-remote` README (fetched via WebFetch, for comparison
  context only)
- Ticket background: https://github.com/deanjstone/argus/issues/130,
  map https://github.com/deanjstone/argus/issues/129
