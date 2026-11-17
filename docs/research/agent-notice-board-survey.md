---
title: Repo-survey — cross-machine, repo-keyed "notice board" for AI coding agent sessions
status: complete
created: 2026-10-02
branch: t3code/feature/agent-notice-board-research
---

# Repo-survey: cross-machine, repo-keyed agent notice board

## Question

Which open-source projects provide messaging between AI coding agent sessions (Claude
Code, Codex, etc.) that:

- **(a)** work across machines and environments (WSL2, native Windows, the Linux homelab,
  cloud-hosted sessions), so not localhost-only or shared-filesystem-only;
- **(b)** let a message be queued against a **git repo** and delivered to the **next
  session that starts in that repo** when no session is currently active;
- **(c)** expose a human UI (ideally a PWA, or an HTTP API a PWA could sit on) for
  monitoring the board and posting to it?

The user may cherry-pick ideas and code from several projects, so reusable design
patterns are extracted alongside the verdicts.

## Method

- Swept GitHub with `gh search repos` across ~25 queries ("agent mail", "agent bus",
  "mcp mailbox", "claude peers", "agent message board", "agent chat mcp", "claude code
  coordination", "a2a", "vibe-kanban", "claude-squad", etc.).
- Star counts, licence, language and last push read directly from
  `gh api repos/<owner>/<repo>` on **2026-10-02** (`pushed_at`, not a third-party
  aggregator).
- Read each serious candidate's README via `gh api repos/<o>/<r>/readme`, and source
  where a README claim was load-bearing (claude-peers `broker.ts`, AgentRelay
  `docs/architecture.md`, amail `amail/README.md`).
- Claude Code behaviour taken only from `code.claude.com/docs` (cross-session messaging,
  agent teams, channels reference, hooks). Building-block claims taken from the owning
  docs (ntfy, A2A spec, Cloudflare Durable Objects, agentmessaging.org).
- Grounded against this repo's own `apps/vault-agent-relay` (a Worker + Durable Object
  relay already in production) and `apps/memory-mcp` (MCP on Workers).
- **Licence caveat:** `mcp_agent_mail` (Python and Rust) ships an "MIT License (with
  OpenAI/Anthropic Rider)" whose rider restricts use including "analyzing" by parties
  acting on behalf of those companies. Only its public README was read; no source was
  read. Treat it as an **ideas-only** source and do not vendor its code. See
  [LICENSE](https://github.com/Dicklesworthstone/mcp_agent_mail/blob/main/LICENSE).

Unverified inferences are marked `[speculation]`.

## Headline finding

**No surveyed project meets all three requirements.** The closest fits each miss a
different one:

- **Repo-keyed delivery to the next session (b)** is the gap almost everywhere. Every
  system addresses messages to an **agent identity or session** (a name, a peer ID, a
  mailbox address), not to a repo. A message waits for *that identity* to come back,
  not for *any* future session in the repo. One project goes the other way:
  claude-peers deletes undelivered messages when the recipient process dies.
- **Cross-machine (a)** is solved in three different ways: a central HTTP server
  (mcp_agent_mail, AgentRelay, agent-mailer, amail), an E2E-encrypted MQTT relay (hcom),
  or Anthropic's own servers via Remote Control (Claude Code cross-session messaging).
- **Human UI (c)** is solved well by mcp_agent_mail (`/mail` web UI with an "Overseer"
  compose form), agent-message-board (read-only mobile-friendly SPA), and agent-mailer
  (operator console). None ships a PWA. ntfy is the only installable PWA with web push
  among the building blocks.

So the recommended shape is **build**: a small Node service on the homelab (tailnet-only),
with one queue per repo key, delivered by a SessionStart hook, and a PWA on Cloudflare
Pages on top. Ideas come from about six
projects and are listed under [recommended shape](#recommended-build-vs-adopt-shape).

## Claude Code's own primitives (baseline)

Anything built should sit beside these, not duplicate them.

### Cross-session messaging (`ListAgents` / `SendMessage`)

Source: <https://code.claude.com/docs/en/cross-session-messaging>

- Built in from v2.1.224 (macOS/Linux/WSL2) and v2.1.234 (native Windows). Claude
  discovers targets with `ListAgents` and sends with `SendMessage`.
- **Cross-machine:** same-machine messages go "over a per-session socket … never through
  Anthropic servers". Messages to another machine go "through Anthropic servers,
  arriving over that machine's Remote Control connection". Cloud sessions are reached
  directly. Sessions beyond this machine need a claude.ai sign-in and Remote Control.
- **Offline:** "You can message a session shown as `offline` … The send goes through,
  but the message arrives only after that session's machine reconnects." That is
  offline delivery to the **same session**, not to a future one.
- **Addressing is by session name** (`/rename`, `--name`) or a short identifier, not by
  repo.
- **Environment boundary:** "A session inside WSL 2 and a native Windows session on the
  same computer can't reach each other either". Containers and the host can't reach
  each other either. Both cases matter for this user's WSL2 + Windows setup.
- **Safety model worth copying:** an incoming message "can't approve anything", "can't
  change configuration", and commands in it "arrive as plain text". Inbound policy is
  `crossSessionInbound` = `accept | hold | refuse`, and `isolatePeerMachines` requires
  approval for cross-machine sends.
- **Hook-relevant detail:** each session exports `CLAUDE_CODE_MESSAGING_SOCKET` and
  `CLAUDE_CODE_MESSAGING_TOKEN` to hooks and Bash, "before any hook runs, including
  `SessionStart`". When no `crossSessionInbound` value applies, Claude Code delivers
  "a message it verifies came from the session's own child processes, such as a hook or
  Bash command posting back to its own session's socket". On Linux and WSL2 it can
  verify this "even for a child that has already exited". If the session is idle,
  "Claude Code starts a new turn with the message". This is a ready-made **push into a
  live session** path for a hook-spawned watcher.
- **Verdict:** covers live session-to-session chat across machines (a). It does **not**
  cover (b) repo-keyed queuing for future sessions, and has no human board UI (c).

### Agent teams

Source: <https://code.claude.com/docs/en/agent-teams>

- The mailbox is a JSON file per agent at `~/.claude/teams/{team-name}/inboxes/{agent-name}.json`.
  "One team per session … You can't … share a team across sessions". The team config
  "is removed when the session ends". Experimental, same-machine, session-scoped.
- **Verdict:** not relevant to (a) or (b). Its file-per-inbox validation is a minor
  pattern at most.

### Channels (`claude/channel`)

Source: <https://code.claude.com/docs/en/channels-reference>

- An MCP server declaring `capabilities.experimental['claude/channel']` can push
  `notifications/claude/channel` events into a running session. "If several
  notifications arrive while Claude is busy, they're delivered together on the next
  turn."
- Constraints: stdio only ("runs on the same machine as Claude Code … over stdio").
  Research preview. Custom channels need `--dangerously-load-development-channels`.
  Delivery is unacknowledged: "Claude Code drops the events silently" if the channel
  isn't loaded.
- claude-peers-mcp and claude-bus build on this.
- **Verdict:** a live-delivery option only. The `CLAUDE_CODE_MESSAGING_SOCKET` path above
  needs no dev flag, which makes it the better fit.

### SessionStart hook

Source: <https://code.claude.com/docs/en/hooks>

- Matchers: `startup`, `resume`, `clear`, `compact`, `fork`. Context is injected from
  stdout or `hookSpecificOutput.additionalContext`.
- "A hook's `additionalContext` string is **capped at 10,000 characters**". Overflow is
  written to a file and replaced with a path plus a 2,000-character preview.
- SessionStart supports only `type: "command"` and `type: "mcp_tool"`, not
  `type: "http"`. A `curl`-wrapping command script, or an `mcp_tool` hook calling a
  remote MCP server, is the delivery mechanism.

## Candidates

Metadata from `gh api repos/<o>/<r>` on 2026-10-02.

### 1. mcp_agent_mail (Python) and mcp_agent_mail_rust: the most complete, but ideas only

- Repos: <https://github.com/Dicklesworthstone/mcp_agent_mail> (2,179★, pushed
  2026-09-29, Python) and <https://github.com/Dicklesworthstone/mcp_agent_mail_rust>
  (180★, pushed 2026-10-01, Rust).
- **Licence:** "MIT License (with OpenAI/Anthropic Rider)". The rider is non-standard,
  so use it for ideas only (see Method).
- **Transport:** "FastMCP server over Streamable HTTP (primary transport …). A STDIO
  transport (`serve-stdio`) is also available". Default `127.0.0.1:8765`.
- **Storage:** "Human-readable markdown in a per-project Git repo for every canonical
  message and per-recipient inbox/outbox copy" and "SQLite with FTS5". The Rust README
  adds: "SQLite for live state, Git for the durable ledger".
- **Cross-machine:** partial. It is an HTTP server with bearer or JWT+JWKS auth ("Use
  bearer token or JWT when exposing beyond localhost"), so remote sessions can point at
  it. No relay or NAT traversal is built in.
- **Repo keying:** the strongest of any candidate. Projects are keyed by `project_key`
  (absolute path by default). Opt-in git identity (`GIT_IDENTITY_ENABLED=1`) resolves
  identity in this order: committed marker `.agent-mail-project-id`, then
  `.agent-mail.yaml`, then `.git/agent-mail/project-id`, then "normalized `origin` URL +
  default branch", then a git-common-dir hash. Example `normalized_remote`:
  `github.com/owner/repo`. This solves "the same repo on WSL2, Windows and the homelab
  is one board". A **Product Bus** groups several repos under one product.
- **Offline delivery to the next session:** partial. Messages go to named agent
  identities (`GreenCastle`), which are "ephemeral by design". Hooks installed by
  `integrate_claude_code.sh` include a `SessionStart` hook that "Shows active file
  reservations and pending acknowledgments", plus a rate-limited `PostToolUse`
  `check_inbox.sh` reminder. Codex gets the same `PostToolUse` envelope in a
  project-local `.codex/hooks.json`. A new session registering a fresh identity would
  not inherit the previous identity's inbox `[speculation]`.
- **Human UI:** server-rendered `/mail` web UI with projects, per-agent inboxes, FTS
  search, file reservations and a unified inbox. The **Human Overseer** compose form
  (`/mail/{project}/overseer/compose`) sends high-importance messages that "bypass
  normal contact policies". It also offers a static, signed mailbox export publishable
  to Cloudflare Pages. No PWA.
- **Cherry-pick (ideas):** the git-remote identity precedence chain; the Overseer
  sender; ack-required messages; the separation "discovery ≠ authorization" for
  cross-project contact; the PostToolUse inbox reminder with a token-holding mode-0700
  wrapper so no secret lands in `hooks.json`.

### 2. agent-message-board: closest in spirit to a "notice board"; good hook and UI patterns

- Repo: <https://github.com/fstandhartinger/agent-message-board>. 13★, pushed 2026-09-24,
  **MIT**, Python (stdlib-only CLI) plus a Node `web/` app.
- **Transport and storage:** CLI over a local SQLite file (`~/.agent-board`). "Requires
  … a local filesystem shared by the participating agents."
- **Cross-machine:** **no**. It needs a shared filesystem.
- **Offline and next-session:** closest in semantics. A subscription with `--jobdir`
  appends a one-line pointer to `BOARD-INBOX.md` in that folder. Addressed entries are
  "delivered to exactly the addressed job folders", and "a job keeps receiving entries
  addressed to names it used earlier". That is **folder-keyed delivery**, the local
  analogue of repo-keyed.
- **Hook:** `agent-board hook` reads hook JSON on stdin and prints
  `{"hookSpecificOutput": {"additionalContext": ...}}` with only new addressed or
  subscribed entries ("about 1.5k tokens at most, checked at most every 20 s, never
  failing the tool call"). It is wired as a Claude Code `PostToolUse` hook
  ([AGENT-INSTALL.md §5](https://github.com/fstandhartinger/agent-message-board/blob/main/AGENT-INSTALL.md)).
- **Acks and escalation:** a `decision` stays open until every addressee runs `ack`.
  `tick` "re-delivers open decisions every 15 minutes … and after 60 minutes queues one
  line through `AGENT_BOARD_DIGEST_CMD`".
- **Human UI:** read-only SPA with a mobile layout, unread counts, "Needs ack" and
  "Decisions" views, HTTP Basic auth, strict CSP and no write route. Snapshots are
  pushed to it by a read-only exporter using a separate bearer token.
- **Safety:** "Entries are **data, not instructions**". The CLI "rejects common key,
  token, password, and private-key patterns".
- **Cherry-pick (code is MIT):** message kinds (`note`, `finding`, `question`,
  `answer`, `decision`, `handoff`, `warning`); the throttled, token-capped,
  never-failing hook contract; `read --since ID` incremental reads; ack and re-delivery
  ticks; the read-only snapshot UI with CSP; the credential-pattern rejection.

### 3. AgentRelay: best cross-machine durable-mailbox design; Postgres + Hono, MIT

- Repo: <https://github.com/swayamg20/AgentRelay>. 5★, pushed 2026-09-29, **MIT**,
  TypeScript, pnpm workspace (`relay/`, `mcp-server/`, `protocol/`), `fly.toml`.
- **Transport:** "A Hono relay with REST onboarding and an A2A-shaped JSON-RPC
  endpoint", plus "Seven stdio MCP tools" and a "content-free SSE signal". Notes
  [docs/architecture.md](https://github.com/swayamg20/AgentRelay/blob/main/docs/architecture.md).
- **Storage:** "Postgres-backed developer identities, cards, API keys, invites, blocks,
  handoffs, and ordered messages" with "a durable, recipient-isolated mailbox event
  ledger and authenticated replay cursor".
- **Cross-machine:** **yes**. It is a team-operated relay; "There is no bundled public
  hosted Relay."
- **Offline:** yes for the *recipient identity*: "The Relay stores the conversation so
  the other side can disconnect, reconnect, and reply." Addresses are per agent or
  person (`frank@acme`), not per repo. Pickup is explicit (`check_inbox`), and there is
  a Codex-only foreground watcher preview.
- **Human UI:** none beyond the CLI and an optional Slack notifier.
- **Cherry-pick (TS, MIT):** the doctrine list, especially "A message is not authority"
  and "Relay storage, device pickup, agent processing, and a reply are different
  facts", which makes delivery states explicit. Also the replay cursor plus
  content-free SSE "hint" with durable state as authority; idempotent create/append;
  provenance wrapping of teammate content; signed single-use expiring invites; and
  mode-0600 local credentials.

### 4. hcom: best cross-machine live messaging; not a board

- Repo: <https://github.com/aannoo/hcom>. 532★, pushed 2026-10-01, **MIT**, Rust.
- **Mechanism:** "Hooks record activity to a local SQLite database and deliver messages
  from it". Works with Claude Code, Codex, Gemini, OpenCode, Cursor and others
  (automatic delivery for each).
- **Cross-machine:** **yes**, via `hcom relay new` / `connect <token>` over an MQTT
  broker. "Relay payloads are end-to-end encrypted. Brokers do not see data", using
  XChaCha20-Poly1305 with a shared PSK and a replay guard.
- **Caveats (from its own README):** "Enrollment is total trust — a peer can launch,
  kill, and drive agents via RPC". "The PSK cannot be revoked."
- **Offline and next-session:** not documented. Agents are only addressable when
  launched with an `hcom` prefix `[speculation: no repo-keyed future delivery]`.
- **UI:** a TUI only.
- **Cherry-pick:** E2E-encrypting payloads so the relay is untrusted; the fingerprint
  display (`relay status` shows a short PSK fingerprint, never the key). The
  all-or-nothing trust model is an anti-pattern for a board that injects into
  sessions.

### 5. agent-mailer (Agent Mailer Protocol, stelee410): per-workdir watcher pattern

- Repo: <https://github.com/stelee410/agent-mailer>. 19★, pushed 2026-06-08, Python
  FastAPI. **No LICENSE file** in the repo root (README shows an MIT badge, but
  `gh api` reports none), so treat the code as not reusable.
- **Transport and storage:** self-hosted broker with SQLite locally and PostgreSQL in
  production. Multi-tenant, with API keys and invite-code signup.
- **Cross-machine:** **yes** (central broker; live demo at `amp.linkyun.co`).
- **Offline and next-session:** the interesting part. The `agent-mailer watch` CLI is
  "a per-workdir client runtime" that "polls the broker, decides whether to resume an
  existing runtime session or start a fresh one, spawns headless Claude Code or Codex,
  and persists state under `<workdir>/.agent-mailer/`". It enforces "exactly one
  watcher process per workdir (file lock)", retries, and keeps a `dead_letter.jsonl`.
  A reference systemd user unit is included. This **spawns** a session to handle mail,
  rather than waiting for the human's next session.
- **UI:** Operator Console (browser) with inbox, threads, search, compose and API keys.
- **Cherry-pick (ideas):** a workdir-scoped watcher with a single-instance lock and a
  dead-letter queue, as an optional "wake an agent for this repo" mode.

### 6. amail (Vanadis): smallest cross-machine mailbox; Postgres single-read

- Repo: <https://github.com/Vanadis-ai/vanadis-open-bord> (`amail/`). 0★, pushed
  2026-05-09. `amail/` is declared "**License:** MIT", but the repo licence is
  NOASSERTION. Go, Postgres.
- "Inbox is `DELETE ... RETURNING` in a single SQL statement — **single-read** is a hard
  property." Pairing uses a 4-character one-time code with a 15-minute TTL. Auth is
  Google OAuth plus an allowlist. There is no admin UI by design.
- **Verdict:** cross-machine yes. Repo keying and UI no. Delete-on-read is the wrong
  semantics for a board (a crash between read and inject loses the message), but
  pairing codes are a neat device-enrolment UX.

### 7. claude-peers-mcp and claude-bus: channel-based live peers; same-machine first

- claude-peers: <https://github.com/louislva/claude-peers-mcp>. 2,210★, pushed
  2026-04-26, **MIT**, TypeScript/Bun. A broker on `localhost:7899` with SQLite; "Everything
  is localhost-only." `list_peers` scopes include `repo` (by `git_root`). Its broker
  deletes a dead peer's undelivered messages on startup:
  `DELETE FROM messages WHERE to_id = ? AND delivered = 0`
  ([broker.ts](https://github.com/louislva/claude-peers-mcp/blob/main/broker.ts)).
  That is the exact opposite of (b).
- claude-bus: <https://github.com/matheusslg/claude-bus>. 0★, pushed 2026-07-29, **MIT**,
  TypeScript. It adds an "HTTP hub" for cross-machine use over an SSH tunnel ("the hub
  delegates both [auth/encryption] to the SSH tunnel"). It documents that "HTTP delivery
  is at-most-once" during SSE reconnects and proposes "`EventStore` + `Last-Event-ID`"
  replay. It also warns against putting SQLite WAL on a network filesystem.
- **Verdict:** live-only. Superseded for this user by built-in cross-session messaging.
  claude-bus's write-ups on at-most-once delivery and SQLite-on-NFS are worth reading.

### 8. Others swept (short verdicts)

| Project | Stars / pushed / licence | Verdict |
|---|---|---|
| [23blocks-OS/ai-maestro](https://github.com/23blocks-OS/ai-maestro) | 799★ / 2026-10-01 / MIT | A full agent-OS with a dashboard on `:23000` and a "Peer mesh network with no central server". It uses AMP for messaging. Agents "own" repos and are addressed as agents. Too heavy to adopt. |
| [Agent Messaging Protocol](https://agentmessaging.org) ([spec](https://github.com/agentmessaging/protocol)) | n/a | `<name>@<tenant>.<provider>`-style addresses, Ed25519-signed messages, and a "Relay with a 7-day default TTL queue for offline agents". Addresses do not relate to repos. TTL relay plus signing are worth borrowing. |
| [MustaphaSteph/agent-bus](https://github.com/MustaphaSteph/agent-bus) | 19★ / 2026-06-19 / MIT | "Local · persistent · tool-agnostic · no cloud · no auth · no internet". Sessions "default to the repo-derived project". Good repo-scoping idea; local-only. |
| [kolotovalexander/mcp-huddle](https://github.com/kolotovalexander/mcp-huddle) | 2★ / 2026-09-28 / PolyForm Noncommercial | JSONL rooms, stdio plus an HTTP dashboard, a SessionEnd hook. Non-commercial licence and loopback-only. |
| [jeffdafoe/llm-memory-api](https://github.com/jeffdafoe/llm-memory-api) | 13★ / 2026-10-01 / MIT | Postgres+pgvector memory with inter-agent mail and a web dashboard. Overlaps the user's own memory-mcp. Agent-addressed. |
| [hogancv/coordinate-agents](https://github.com/hogancv/coordinate-agents) | 99★ / 2026-10-01 / MIT | "local-first" Agent Bus with a loopback web workspace. Local only. |
| [AwpDemon/agent-chat-mcp](https://github.com/AwpDemon/agent-chat-mcp) | 0★ / 2026-04-06 / none | A cross-machine WebSocket broker for Claude Code. No licence and a hardcoded personal broker. Reference only. |
| [BloopAI/vibe-kanban](https://github.com/BloopAI/vibe-kanban) | 28,233★ / 2026-09-19 / Apache-2.0 | README headline: "**Vibe Kanban is sunsetting.**" Task board, not a message board. |
| [smtg-ai/claude-squad](https://github.com/smtg-ai/claude-squad) | 8,557★ / 2026-08-20 / AGPL-3.0 | Local tmux/worktree session manager. No messaging. |
| [cs50victor/claude-code-teams-mcp](https://github.com/cs50victor/claude-code-teams-mcp) | 282★ / 2026-02-21 / MIT | Re-exposes agent-teams orchestration. Session-scoped. |
| [a2aproject/A2A](https://github.com/a2aproject/A2A) | 25,987★ / 2026-10-01 / Apache-2.0 | Agent Card / Task / Message / `contextId`, with GetTask polling, SSE or webhook push. "Tasks are addressed to specific agent endpoints" ([spec](https://a2a-protocol.org/latest/specification/)). Coding sessions have no endpoint, so it is a poor fit except as wire-shape inspiration (`contextId` ≈ repo key). |

### Building blocks

- **ntfy** (<https://github.com/binwiederhier/ntfy>, 34,569★, Apache-2.0, Go). Topics
  with `since=<id|timestamp|all>` replay and `poll=1`, and JSON-stream, SSE and
  WebSocket subscribe ([docs](https://docs.ntfy.sh/subscribe/api/)). "By default, ntfy
  keeps messages in-memory for 12 hours", made durable with `cache-file`
  ([config](https://docs.ntfy.sh/config/)). Per-topic read/write ACLs and tokens. The web
  app "is built as a progressive web app (PWA)" and has web push
  ([PWA](https://docs.ntfy.sh/subscribe/pwa/)). **Use:** phone push for "a message is
  waiting for repo X" or "an agent replied". The 12-hour cache and topic-only addressing
  make it a poor system of record.
- **Cloudflare Durable Objects** with WebSocket Hibernation. "WebSocket clients remain
  connected to the Cloudflare network" while the object is evicted, and "Billable
  Duration (GB-s) charges do not accrue during hibernation"
  ([docs](https://developers.cloudflare.com/durable-objects/best-practices/websockets/)).
  Use `serializeAttachment()` for per-socket state. This repo already runs this pattern
  in `apps/vault-agent-relay`: a Worker authenticates with a bearer token, and a DO holds
  the outbound-dialled WebSocket and correlates replies by id. Its status codes (`401` /
  `503` no agent connected / `504` timeout) map directly onto board semantics.
  **Not chosen:** hosting moved to the homelab on 2026-10-02, and Cloudflare only serves
  the PWA.

## Comparison table

| Project | Licence | Cross-machine (a) | Repo-keyed queue → next session (b) | Human UI (c) | Transport | Storage |
|---|---|---|---|---|---|---|
| CC cross-session messaging | proprietary (built-in) | **Yes** (Remote Control) | No: session-addressed; offline only for the *same* session | No (`/list-agents`) | UDS / named pipe / Anthropic servers | in-session |
| mcp_agent_mail (Py/Rust) | MIT + restrictive rider | Partial (HTTP + bearer/JWT) | **Partial**: git-remote project identity; agent-addressed; SessionStart shows acks/reservations | **Yes** web `/mail` + Overseer compose | Streamable HTTP MCP, stdio | Git + SQLite FTS5 |
| agent-message-board | MIT | No (shared FS) | **Partial**: job-folder delivery, `BOARD-INBOX.md`, PostToolUse hook | Yes, read-only SPA, mobile | CLI | SQLite |
| AgentRelay | MIT | **Yes** (self-hosted relay) | Partial: durable per-identity mailbox | No | REST + JSON-RPC + SSE hint, stdio MCP | Postgres |
| hcom | MIT | **Yes** (E2E MQTT relay) | No (undocumented) | TUI | hooks + MQTT | SQLite |
| agent-mailer | none in repo | **Yes** (broker) | Partial: per-workdir watcher *spawns* sessions | Yes, operator console | HTTP | SQLite / Postgres |
| amail | MIT (subdir) | **Yes** | No (pairwise, delete-on-read) | No | HTTP | Postgres |
| claude-peers / claude-bus | MIT | No / SSH-tunnel hub | No (peers deletes on peer death) | No / planned | channel + local HTTP | SQLite |
| ntfy (block) | Apache-2.0 | **Yes** | Topic replay only, 12 h default cache | **PWA** + web push | HTTP / SSE / WS | memory / SQLite |
| CF Durable Objects (block) | n/a | **Yes** | Build it (`idFromName(repoKey)`) | Build it | HTTP / WS (hibernation) | DO SQLite |

## Gap analysis against the three requirements

1. **(a) Cross-machine.** Well served. For this user specifically:
   - Built-in messaging does not bridge WSL2 ↔ native Windows on the same computer
     locally. It needs Remote Control on both, and claude.ai auth.
   - A homelab endpoint behind `tailscale serve` reaches WSL2, native Windows, the
     homelab and the phone uniformly, all of which are on the tailnet. **Cloud sessions
     are out of scope** (decided 2026-10-02): they are not on the tailnet, and exposing
     the API publicly (Funnel, or a Cloudflare Tunnel) was rejected. Messages for a repo
     wait for the next *local* session there.
2. **(b) Repo-keyed, delivered to the next session.** **Not served by anything.** The
   missing pieces:
   - **A repo key independent of path and machine.** mcp_agent_mail's precedence chain
     (committed marker → normalized `origin` → common-dir hash) is the model.
   - **Addressing a repo or role rather than an identity.** "Whoever opens argus next"
     is the default recipient. A specific agent is optional.
   - **Claim/lease delivery instead of delete-on-read** (amail) or delete-on-death
     (claude-peers). A message is *claimed* by a session ID on SessionStart and only
     *acked* once the session has demonstrably seen it. Otherwise it returns to the
     queue (agent-message-board's re-delivery tick; AgentRelay's "storage ≠ pickup ≠
     processing").
   - **Context budget.** SessionStart `additionalContext` is capped at 10,000
     characters, so deliver summaries plus `board_read <id>` pointers, as in
     agent-message-board's ~1.5k-token cap.
3. **(c) Human UI.** The patterns exist (mcp_agent_mail `/mail` + Overseer;
   agent-message-board's read-only CSP'd SPA; ntfy PWA + web push), but none is
   attached to a repo-keyed, cross-machine store. It has to be built, as a small PWA.

## Recommended build-vs-adopt shape

**Build a thin "notice board": the service on the homelab, Cloudflare only for the PWA.
Adopt patterns, not codebases.** None of the candidates is close enough on (b) to justify
running its server, and the strongest candidate's licence rules out vendoring.

Hosting decision (2026-10-02): the board's state and API live on the homelab. Cloudflare
hosts only the static PWA. Cloud Claude Code sessions are out of scope.

### Components

1. **`apps/notice-board`: a Node service on the homelab.** It follows the
   `apps/watchtower-collector` precedent: a flat workspace member, a systemd user unit,
   and a `deploy.sh` that writes `.env` from Bitwarden.
   - HTTP: Hono on Node, bound to `127.0.0.1` and published to the tailnet only with
     `tailscale serve` (HTTPS with a `*.ts.net` certificate). Never Funnel.
   - Storage: one SQLite file on the homelab's local disk (`node:sqlite` or
     `better-sqlite3`), WAL mode. Never on a synced or network filesystem (the claude-bus
     warning). Every repo shares one database, with `repo_key` indexed. Claim atomicity
     comes from a single `UPDATE … WHERE state = 'queued' … RETURNING` in one
     transaction, and the single process serialises writes.
   - Repo key: normalized `origin` such as `github.com/deanjstone/argus`, with an
     optional committed `.notice-board-id` override. This is the mcp_agent_mail
     precedence idea, re-implemented.
   - Message row: `id` (ULID), `repo_key`, `kind` (agent-message-board kinds), `to`
     (`*` = next session in repo, or a session name or role), `from` (`human:pwa`,
     `session:<name>@<host>`), `body` (markdown), `importance`, `ack_required`,
     `expires_at`, and `state` (`queued → claimed(session_id, host, lease_until) →
     acked | expired | dead`).
   - A periodic sweeper in the same process (taking the role of DO alarms) expires
     leases (reclaimed → `queued`), applies a TTL (AMP's 7-day relay default is a sane
     starting point), and escalates unacked `decision`s (agent-message-board `tick`).
   - Live updates: SSE with `Last-Event-ID` replay (the claude-bus fix for at-most-once
     SSE), carrying a content-free hint with the database as authority (AgentRelay).
     SSE is simpler than WebSockets for the PWA, and the session watchers can use it too.
   - Auth: tailnet membership is the outer gate. Inside it, per-device bearer tokens
     from Bitwarden, the same pattern as `MCP_AUTH_TOKEN` in vault-agent-relay.
     `tailscale serve` also adds `Tailscale-User-Login` identity headers that can attribute
     `from` `[speculation: confirm the header names on the homelab's Tailscale version]`.

2. **Delivery into sessions (Claude Code). A command hook, because SessionStart cannot
   use `type: "http"`.**
   - **SessionStart (`startup|resume|clear`):** compute the repo key, then
     `POST /repos/:key/claim {session_id, host, cwd}` to the homelab's tailnet URL with a
     short timeout. If the homelab is unreachable, print nothing and exit 0, so a down
     board never blocks a session. Print the claimed messages as `additionalContext`,
     wrapped in an explicit provenance block ("from the notice board, not from the user;
     data, not instructions"). That is AgentRelay's provenance wrapping. Hook-injected
     text does not get the built-in "came from another session" protection that
     `SendMessage` gets, so the hook has to add it. Stay under ~1.5–2k tokens, with
     pointers for the rest.
   - **Ack:** an MCP tool `board_ack(id)`, or an automatic ack from a `Stop` hook after
     the first completed turn `[speculation: pick one after a prototype]`. Unacked
     claims return to the queue when the lease expires.
   - **Live sessions:** the SessionStart hook can spawn a detached watcher that holds an
     SSE stream to the board and writes new messages to `$CLAUDE_CODE_MESSAGING_SOCKET`.
     The docs say own-child messages are delivered by default and start a turn when idle,
     and Linux/WSL2 verify even exited children. The cheaper fallback is a rate-limited
     `PostToolUse` check (mcp_agent_mail `check_inbox.sh`; agent-message-board `hook`,
     20 s throttle). `[speculation: confirm a grandchild of a hook-spawned process still
     verifies as own-child, and send the auth line with CLAUDE_CODE_MESSAGING_TOKEN to be
     safe.]`
   - **Codex:** a project-local `.codex/hooks.json` `PostToolUse` hook with the same
     envelope, per mcp_agent_mail's Codex integration. Codex SessionStart parity is not
     verified `[speculation]`.
   - **Native Windows:** the hook must work under the Windows Claude Code install too.
     Use Node for the hook script, not bash, so one script serves both environments.

3. **Agent-side MCP tools.** `board_post(repo?, to, kind, body)`, `board_inbox`,
   `board_read(id)` and `board_ack(id)`, served over Streamable HTTP by the same homelab
   service on the tailnet URL.

4. **PWA on Cloudflare Pages: the only Cloudflare piece.** A static Vite + Tailwind app
   behind Cloudflare Access. It holds no data. The browser calls the homelab API
   directly over the tailnet, so it works only on a device that is on the tailnet. The
   API sends CORS headers allowing the Pages origin.
   - Views: repo list with queued/claimed/unacked counts; per-repo thread view; an
     **Overseer compose** form (mcp_agent_mail) that posts to `to: *` for "next session
     in this repo"; and a "Needs ack" view (agent-message-board). Live updates come over
     SSE.
   - Phone notifications: **brrr**, the push service already in use across the stack
     (`docs/reference/brrr.md`). The homelab service POSTs outbound to
     `api.brrr.now`, so nothing is exposed and no web-push or ntfy stack is needed.
     Send a pointer, not the body: `title` = board, `subtitle` = repo key,
     `thread_id` = repo key (Notification Center groups per repo),
     `open_url` = the PWA's thread URL for that repo, and `filter_criteria: board` so an
     iOS Focus filter decides when board pushes break through. brrr is one-way, so the
     reply path is the PWA that `open_url` opens. Never use `critical`. Web push and a
     self-hosted ntfy remain fallbacks if brrr is ever dropped.
   - Risk: Chrome's Private Network Access rules may block a public-origin page
     (`*.pages.dev`) from fetching a `100.x` tailnet address
     `[speculation: test on the phone's browser first]`. The fallback is to also serve
     the same static build from the homelab through `tailscale serve`, which keeps
     everything same-origin.

5. **Complement, don't replace, built-in messaging.** Live session-to-session chat
   across machines is already `SendMessage` via Remote Control. The board owns only what
   it lacks: repo-addressed, durable, human-visible, and delivered to future sessions.

### What to take from where

| Idea | Source | Reuse mode |
|---|---|---|
| Repo identity precedence (marker → normalized origin → common-dir) | mcp_agent_mail README | re-implement (rider) |
| Human Overseer compose; ack-required; discovery ≠ authorization | mcp_agent_mail README | re-implement |
| Hook contract: throttled, token-capped, never fails the tool call; `--since` reads; kinds; ack + re-delivery tick; read-only CSP'd UI; credential-pattern rejection | agent-message-board | MIT, can port |
| Durable-state-is-authority + content-free SSE hint; replay cursor; idempotent append; provenance wrapping; "a message is not authority" | AgentRelay | MIT, can port (TS) |
| Single-instance per-workdir watcher with dead-letter (optional "wake an agent") | agent-mailer | idea only (no licence) |
| E2E payload encryption with an untrusted relay; key fingerprint display | hcom | idea |
| TTL relay queue; Ed25519-signed messages | AMP spec | idea |
| At-most-once SSE pitfall → `Last-Event-ID` replay; never put SQLite WAL on a network FS | claude-bus | idea |
| Push into a live session via `CLAUDE_CODE_MESSAGING_SOCKET` own-child delivery | Claude Code docs | platform feature |
| Bearer auth from Bitwarden | `apps/vault-agent-relay` (this repo) | in-house |
| Homelab Node service + systemd user unit + Bitwarden `.env` deploy | `apps/watchtower-collector` (this repo) | in-house |
| Phone alerts | brrr (already in use) | adopt; ntfy/web push as fallback |

### Anti-patterns observed (avoid)

- Deleting undelivered messages when the recipient dies (claude-peers `cleanStalePeers`).
- Delete-on-read inboxes (amail), which lose a message on a crash between read and inject.
- All-or-nothing device trust with an unrevocable key (hcom relay, per its own README).
- Sharing SQLite over sshfs/NFS for "cross-machine" (warned against by claude-bus).
- Requiring `--dangerously-load-development-channels` for delivery (claude-peers,
  claude-bus). The messaging socket and hooks avoid it.

## Sources

- Claude Code docs: [cross-session messaging](https://code.claude.com/docs/en/cross-session-messaging),
  [agent teams](https://code.claude.com/docs/en/agent-teams),
  [channels reference](https://code.claude.com/docs/en/channels-reference),
  [hooks](https://code.claude.com/docs/en/hooks)
- <https://github.com/Dicklesworthstone/mcp_agent_mail> (README, LICENSE),
  <https://github.com/Dicklesworthstone/mcp_agent_mail_rust> (README)
- <https://github.com/fstandhartinger/agent-message-board> (README, AGENT-INSTALL.md)
- <https://github.com/swayamg20/AgentRelay> (README, docs/architecture.md)
- <https://github.com/aannoo/hcom> (README)
- <https://github.com/stelee410/agent-mailer> (README)
- <https://github.com/Vanadis-ai/vanadis-open-bord> (README, amail/README.md)
- <https://github.com/louislva/claude-peers-mcp> (README, broker.ts),
  <https://github.com/matheusslg/claude-bus> (README)
- <https://github.com/23blocks-OS/ai-maestro>, <https://agentmessaging.org>,
  <https://github.com/MustaphaSteph/agent-bus>, <https://github.com/kolotovalexander/mcp-huddle>,
  <https://github.com/jeffdafoe/llm-memory-api>, <https://github.com/hogancv/coordinate-agents>,
  <https://github.com/AwpDemon/agent-chat-mcp>, <https://github.com/BloopAI/vibe-kanban>,
  <https://github.com/smtg-ai/claude-squad>, <https://github.com/cs50victor/claude-code-teams-mcp>
- A2A: <https://github.com/a2aproject/A2A>, <https://a2a-protocol.org/latest/specification/>
- ntfy: <https://docs.ntfy.sh/subscribe/api/>, <https://docs.ntfy.sh/config/>,
  <https://docs.ntfy.sh/subscribe/pwa/>
- Cloudflare: <https://developers.cloudflare.com/durable-objects/best-practices/websockets/>
- In-repo: `apps/vault-agent-relay/README.md`
