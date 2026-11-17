---
title: Repo-survey — Telegram/Slack bot-integration patterns for the ccbot rewrite
status: complete
created: 2026-08-10
ticket: https://github.com/deanjstone/argus/issues/215
map: https://github.com/deanjstone/argus/issues/214
---

# Repo-survey: Telegram/Slack bot-integration patterns for the ccbot rewrite

## Question

Survey popular open-source repos that integrate with Telegram and/or Slack, covering
both (a) general-purpose bot-framework building blocks and (b) existing
AI-coding-agent↔chat bridge projects at ccbot's own altitude, focused on ccbot's four
known rewrite problems: duplicate-notification/multi-process fan-out, channel
abstraction for a Telegram+Slack-only bridge, topic/thread routing, and testing
bot-integration code. Full question: argus#215.

## Method

Read ccbot's current source directly (`apps/ccbot/src/relay/background-session-bridge.ts`,
`apps/ccbot/src/utils/agent-view-monitor.ts`, `src/start-all-webhooks.ts`,
`src/start-telegram-webhook.ts`, `src/start-slack-socket.ts`, `package.json`) to ground
the comparison in ccbot's actual current architecture, not just the map's summary. Read
the four cited prior-art issues (argus#85, #105, #130, #131) in full, including their
resolution comments, to avoid re-deriving what those surveys already found. Verified
every repo's star/fork/activity numbers directly via `gh api repos/<owner>/<repo>`
(GitHub REST API, not a secondary aggregator) as of 2026-08-10. Fetched official
docs/READMEs directly (grammy.dev, docs.slack.dev, docs.openclaw.ai, project READMEs)
for architecture and testing claims, quoting exact terminology where useful.

## ccbot's current architecture (baseline for comparison)

Confirmed by reading source directly, corroborating the map's (#214) root-cause note:

- `src/start-all-webhooks.ts` is a supervisor that `spawn()`s one **child process per
  enabled channel** (`start-telegram-webhook.js`, `start-slack-socket.js`, plus
  LINE/Matrix/email) — each gets its own stdio-inherited Node process.
- `agent-view-monitor.ts` (`AgentViewMonitor`) is a per-process `EventEmitter` that
  polls either `claude agents --json` or herdr's socket API on a 15s timer
  (`POLL_INTERVAL`), diffs against an in-memory `Map` roster, and emits
  `sessionAdded`/`sessionRemoved`/`sessionStateChanged`/`sessionStuck`/`goalUpdated`.
  Nothing about it is shared across processes — it's constructed fresh in whichever
  process instantiates it.
- `background-session-bridge.ts` (`BackgroundSessionBridge`) subscribes to one
  `AgentViewMonitor` + one `QuotaBurnGuard` instance and calls a single injected
  `send()` closure for every event. Each channel process wires its own
  `AgentViewMonitor` + `QuotaBurnGuard` + `BackgroundSessionBridge` triple, with `send`
  bound to that channel's own API.
- Net effect: the same underlying session-lifecycle transition is detected
  independently by N processes, ~15s apart, and rendered N times — once per enabled
  channel. There is no shared event bus, no single source of truth, and no
  dedup/idempotency layer anywhere in the chain.
- Test coverage: 3 files under `apps/ccbot/test/` (`herdr-agents.test.ts`,
  `known-projects.test.ts`, `agent-view-monitor.test.ts`) against ~10,027 lines of
  TypeScript source (`find apps/ccbot/src -name '*.ts' | xargs wc -l`). None of the
  channel adapters, the relay/bridge layer, or the two `start-*` entrypoints have any
  test coverage.
- Dependencies today: `@slack/bolt` (already the Slack building block — no change
  needed there) + hand-rolled Telegram HTTP calls (no `grammY`/`telegraf`/
  `node-telegram-bot-api` dependency currently — `src/channels/telegram/telegram.ts`
  talks to the Bot API directly).

## Prior art already covered — not re-derived here

- **argus#85** — `agency-agents` review; no direct Telegram/Slack bridge overlap, not
  cited further.
- **argus#105** — n8n-claw vs ccbot feature audit. Established the "normalize inbound
  message to one common shape before it reaches core logic" pattern
  (`Normalize Message` node collapsing voice/photo/PDF/location/text branches) and the
  "split long message before send" outbound pattern — both reused below as instances
  of the channel-abstraction question (finding 2).
- **argus#130** — herdr ecosystem repo-survey. Confirmed ccbot itself is the
  strongest in-house candidate for herdr socket-API adoption depth; not otherwise
  about Telegram/Slack bridge architecture.
- **argus#131** — herdr-remote deep-dive. Its Telegram bot
  (`relay/herdr_telegram.py`) is a **negative example** worth restating here since it's
  directly relevant to the rewrite's security posture: single-chat-ID allowlist that's
  wide open ("discovery mode") until first configured, and it talks to the relay over
  localhost so it can (and does) sidestep the relay's own already-weak Cloudflare-tunnel
  auth. Useful as "what not to copy" for ccbot's own Telegram auth, not as an
  architecture reference for the fan-out/routing/testing questions this ticket covers.

## (a) General-purpose bot-framework building blocks

All star/fork/activity figures below pulled via `gh api repos/<owner>/<repo>` on
2026-08-10.

| Repo | Stars | Last push | Notes |
|---|---|---|---|
| [grammyjs/grammY](https://github.com/grammyjs/grammY) | 3,712 | 2026-08-09 | Actively maintained, TypeScript-native |
| [telegraf/telegraf](https://github.com/telegraf/telegraf) | 9,173 | **2025-01-11** | Most stars, but no push in ~19 months |
| [yagop/node-telegram-bot-api](https://github.com/yagop/node-telegram-bot-api) | 9,194 | 2026-07-14 | Still active, JS not TS-native |
| [slackapi/bolt-js](https://github.com/slackapi/bolt-js) | 2,936 | 2026-08-07 | Official Slack SDK, already ccbot's dependency |
| [slackapi/bolt-python](https://github.com/slackapi/bolt-python) | 1,320 | 2026-08-04 | Official Slack SDK, Python |

**Telegram side — grammY over Telegraf for the rewrite.** Despite Telegraf's larger
star count, it hasn't been pushed to since 2025-01-11 (~19 months stale as of this
survey). grammY is TypeScript-native (ccbot's stack), actively maintained (pushed the
day before this survey), and has first-party forum-topic API support
(`createForumTopic`, per [grammY API reference](https://grammy.dev/ref/core/api)) plus
a documented plugin split between **middleware plugins** (inbound) and **transformer
plugins** (outbound) — the transformer hook is what several testing tools below build
on. node-telegram-bot-api remains active and has the most stars of the three, but it
predates TypeScript-first design and isn't a meaningfully better fit than grammY for a
clean-slate TS rewrite.

**Slack side — Bolt stays.** ccbot's `package.json` already depends on `@slack/bolt`
(current). Bolt's `App` class separates transport into a swappable **Receiver**
abstraction: `SocketModeReceiver` (persistent outbound WebSocket, no public URL needed
— what ccbot uses today per `start-slack-socket.ts`) vs. the default HTTP receiver
(inbound webhook, needs a public endpoint). Per the [Socket Mode docs](https://docs.slack.dev/tools/bolt-js/concepts/socket-mode/),
Socket Mode "allows your app to connect and receive data from Slack via a WebSocket
connection," maintained by your process initiating the connection rather than Slack
POSTing to a public URL — the same shape as ccbot's Telegram long-polling. No
framework change indicated here; the Receiver abstraction itself (a pluggable
transport object separate from listener/business logic) is a pattern worth carrying
into the rewrite's own Telegram side (see finding 2).

**Notable negative finding on testing:** Bolt-js has two long-open, still-unresolved
issues literally titled ["Adding unit tests examples to the documentation" (#383)](https://github.com/slackapi/bolt-js/issues/383)
and ["How to test?" (#1336)](https://github.com/slackapi/bolt-js/issues/1336) — even
Slack's own official framework has no first-party testing guide. Bolt's `test:unit`
script uses mocha, and the community works around the gap by injecting a fake
`receiver` object into the `App` constructor. This matters for finding 4 below.

## (b) AI-coding-agent ↔ chat bridge projects

All figures via `gh api repos/<owner>/<repo>` on 2026-08-10.

| Repo | Stars | Last push | Scope |
|---|---|---|---|
| [openclaw/openclaw](https://github.com/openclaw/openclaw) | 385,743 | 2026-08-10 | 10+ channels incl. Telegram+Slack, single-gateway architecture |
| [RichardAtCT/claude-code-telegram](https://github.com/RichardAtCT/claude-code-telegram) | 2,752 | 2026-03-30 | Telegram-only, Python, EventBus + project-topic sync |
| [hanxiao/claudecode-telegram](https://github.com/hanxiao/claudecode-telegram) | 608 | 2026-01-25 | Telegram-only |
| [linuz90/claude-telegram-bot](https://github.com/linuz90/claude-telegram-bot) | 452 | 2026-05-01 | Telegram-only |
| [six-ddc/ccbot](https://github.com/six-ddc/ccbot) | 269 | 2026-07-08 | Telegram↔tmux, **name collision** with our own ccbot |
| [alexei-led/ccgram](https://github.com/alexei-led/ccgram) | 240 | 2026-08-08 | Telegram↔tmux/herdr, swappable-backend protocol |
| [terranc/claude-telegram-bot-bridge](https://github.com/terranc/claude-telegram-bot-bridge) | 126 | 2026-05-30 | Telegram-only, lightweight |
| [gergomiklos/heyagent](https://github.com/gergomiklos/heyagent) | 93 | 2026-05-28 | Telegram bridge, Claude Code + Codex |

**openclaw/openclaw is the standout finding of this survey.** 385,743 stars as of
2026-08-10 (confirmed via GitHub API directly), created 2025-11-24 — i.e. under nine
months old, making it almost certainly the single most popular open-source project in
this entire problem space, at an altitude well above ccbot (it's a general
personal-AI-assistant gateway spanning 10+ chat platforms, not agent-coding-specific),
but its **gateway architecture directly answers ccbot's fan-out problem**:

- Per [docs.openclaw.ai](https://docs.openclaw.ai/): *"Run one Gateway across channel
  plugins, WebChat, and mobile nodes."* One process, not one process per channel.
  *"The Gateway is the single source of truth for sessions, routing, and channel
  connections."*
- Channels are **plugins** attached to the one Gateway process — Telegram, Slack,
  Discord, WhatsApp, etc. all install on demand and run inside the same process, not as
  separate long-running daemons.
- Sessions are isolated **by context, not by channel**: *"Isolated sessions per agent,
  workspace, or sender."* The dedup/single-emission property falls out of this for
  free — one Gateway means one poller/state-owner, so a lifecycle event is detected
  once, and each attached channel plugin decides independently how to render it for its
  own wire format.
- **Telegram plugin specifics** (per [docs.openclaw.ai/channels/telegram](https://docs.openclaw.ai/channels/telegram),
  directly relevant to ccbot's existing per-project Forum Topics routing in
  `topic-manager.ts`): forum topics are addressed as a session-key suffix
  `:topic:<threadId>`; each topic can route to a distinct `agentId` with its own
  workspace/memory/session; topic config supports a wildcard `topics."*"` default that
  named topics override; the **General topic (threadId=1) is special-cased** — message
  *sends* must omit `message_thread_id` because Telegram rejects it there, but *typing*
  actions still include it. Duplicate-delivery prevention is handled via "per-chat/
  per-thread sequencing through the grammY runner" plus the structural guarantee that
  "only one active poller can use a bot token at a time." **ccbot's `topic-manager.ts`
  and `thread-map.ts` should be checked against this General-topic special case
  specifically** — it's an easy Telegram Bot API footgun the rewrite should verify it
  already handles or add explicitly.
- **Slack plugin specifics** (per [docs.openclaw.ai/channels/slack](https://docs.openclaw.ai/channels/slack)):
  supports Socket Mode (default, matches ccbot today), HTTP receiver mode, and a
  **Relay Mode** for multi-instance deployments where "a trusted router owns the single
  Socket Mode connection and forwards typed events to destination gateways" — directly
  relevant if the multi-machine relay (argus-config#68, currently out of scope) is ever
  revisited, since it's the same single-connection-owner problem at a different layer.
  Thread routing keys are built the same way as Telegram: DM sessions collapse to
  `session.dmScope=main`, channel sessions key as
  `agent:<agentId>:slack:channel:<channelId>`, and thread replies append
  `:thread:<threadTs>` to that key, so "the root and later thread replies share one
  OpenClaw session."
- **Testing**: confirmed via `gh api repos/openclaw/openclaw/contents` that the repo
  has a root-level `vitest.config.ts`, a top-level `test/` directory (with its own
  nested `test/vitest/vitest.config.ts`), and a separate `qa/` directory — i.e. a
  9-figure-star, actively-maintained multi-channel bridge invests in dedicated test
  infrastructure as a first-class part of the repo layout, not an afterthought. (Full
  per-file test content wasn't pulled — this is a structural finding, not a claim about
  coverage percentage.)
- **Caveat**: openclaw operates at a materially higher altitude than ccbot — it's a
  general personal-assistant gateway with 10+ channel plugins, memory, multi-agent
  routing, and a plugin marketplace, not a single-purpose Claude-Code-session bridge.
  The *gateway/single-source-of-truth* and *session-key-suffix* patterns are directly
  portable to ccbot's much narrower Telegram+Slack scope; the plugin-marketplace and
  multi-agent-routing machinery is not something ccbot's rewrite needs to reproduce.

**RichardAtCT/claude-code-telegram** — closest peer to ccbot in actual scope (Claude
Code specifically, not a general assistant), 2,752 stars, Python/FastAPI/aiosqlite
stack. Per its own `CLAUDE.md`: an **EventBus** in `src/events/` decouples inbound
triggers (webhooks, scheduler) from the `AgentHandler` that processes them — webhooks
go through "signature verification → deduplication → publish WebhookEvent to
EventBus" before anything touches Claude integration logic, i.e. dedup happens once,
at the ingestion boundary, before fan-out to any handler. Multi-project Telegram-topic
sync is handled by a `ProjectRegistry` (YAML-configured projects) + `ThreadManager`
that keeps topics in sync with projects, with an explicit `/sync_threads` command for
manual resync and a configurable pacing interval
(`PROJECT_THREADS_SYNC_ACTION_INTERVAL_SECONDS`, default 1.1s) to respect Telegram's
rate limits when bulk-creating/renaming topics — a concrete, reusable idea for
`topic-manager.ts`'s own topic-creation flow if it doesn't already pace its API calls.
Testing: pytest + pytest-asyncio (`asyncio_mode = "auto"`), a `tests/` tree mirroring
`src/`, `make test` for coverage, and `mypy --strict` for type checking — a much more
conventional test setup than ccbot's current 3 files, worth using as the direct
scope-equivalent reference (this project is single-platform, single-purpose, close to
ccbot's own destination shape) rather than openclaw's much larger structure.

**alexei-led/ccgram** — smaller (240 stars) but architecturally the most relevant
precedent for the map's *other* known problem (the herdr/tmux backend split already
tracked separately). Its README states the multiplexer access "lives behind a
Multiplexer Protocol in `multiplexer/base.py` — a pure, I/O-free module with no backend
imports," with both `multiplexer/tmux.py` and `multiplexer/herdr.py` implementing "the
same protocol and return the same neutral value types," enforced by "an architectural
fitness test" (a test that asserts the boundary itself isn't violated, not just
behavior). This is a directly reusable idea for ccbot's own channel abstraction: define
a minimal Channel protocol/interface first (independent of any SDK types), implement
Telegram and Slack against it, and add a fitness test that fails the build if either
implementation reaches into the other's or into a shared mutable global.

**six-ddc/ccbot** (269 stars, unrelated to `deanjstone/argus`'s own `ccbot` beyond the
name) and the smaller Telegram-only bridges (hanxiao, linuz90, terranc, heyagent) were
checked and don't add architecture beyond what's already covered by openclaw and
RichardAtCT's projects — noted for completeness of the survey but not cited further.

**Cursor's official Slack integration** (not a self-hosted OSS repo — a SaaS
Slack-Marketplace app, per [docs.cursor.com/en/slack](https://docs.cursor.com/en/slack))
is architecturally a different model (OAuth-installed Slack app + hosted backend, not a
bridge you run yourself) but is a useful *UX* comparison point: agents are launched via
`@Cursor` mentions in-channel, and completion is reported back into the same thread
with a PR link — i.e. Slack's own threading is the routing primitive, no custom
topic/thread-mapping layer needed on Cursor's side because they don't support
per-project routing the way ccbot's Forum Topics do. Not a pattern to copy given
ccbot's per-project routing requirement, but confirms Slack thread-based routing (as
opposed to Telegram's Forum Topics) is the natural Slack-side equivalent — consistent
with what openclaw's Slack plugin does.

**Notable gap:** no popular *Slack-focused* AI-coding-agent bridge (self-hosted,
OSS) was found comparable in maturity to the Telegram-side crop above. Every
Telegram-first ccbot-alike project surveyed either has no Slack support at all or
added it as an afterthought; openclaw is the only one with comparably first-class
Slack support, because it's not agent-coding-specific. This is itself a data point:
ccbot's Slack support (via Bolt, already working) is less thoroughly prior-arted than
its Telegram support, so the Telegram-side patterns above (topic routing, dedup) may
need more original design work on translation to Slack than on Telegram, where more
precedent exists to draw from directly.

## Findings mapped to ccbot's four focus questions

### 1. Duplicate-notification / multi-process fan-out

Every mature multi-channel reference surveyed (openclaw, RichardAtCT's EventBus,
Chatwoot's Inbox model — see below) converges on the same shape: **one process owns
session/event state; N thin channel adapters attach to it and each independently
decides how to render an event for its own wire format.** ccbot's current design
inverts this — N processes each own a full copy of the state machinery
(`AgentViewMonitor` + `QuotaBurnGuard` + `BackgroundSessionBridge`), so duplication is
structural, not a bug to patch. Concretely for the rewrite:

- Collapse `start-telegram-webhook.ts` and `start-slack-socket.ts` into one process (or
  at minimum one shared `AgentViewMonitor`/`QuotaBurnGuard` instance, e.g. via a small
  IPC/socket layer if separate processes are kept for isolation) so the poll-and-diff
  logic runs exactly once regardless of how many channels are enabled.
- `BackgroundSessionBridge` should support multiple registered `send` targets (one per
  enabled channel) instead of being instantiated once per channel with a single bound
  `send`. This is a small, mechanical change to the existing class — turn the single
  `send: SendFn` constructor param into an array/registry of channel senders, called
  once per event, once per channel, from a single shared event stream.
- (Confirmed via [Chatwoot's DeepWiki architecture docs](https://deepwiki.com/chatwoot/chatwoot/7.8-webhook-processing-and-message-routing),
  a mature omnichannel support-desk tool with the identical N-channels-one-state
  problem): Chatwoot additionally dedupes at the *data* layer — every inbound message
  is checked against `Message.where(conversation_id: X, source_id: Y)` before
  insertion, an idempotency check independent of the process-topology fix above. Worth
  adding as defense in depth even after the single-process fix, in case a future
  redeploy/restart ever causes a double-emit.

### 2. Channel-abstraction patterns for Telegram+Slack only

Two directly reusable shapes, both from primary sources above:

- **openclaw's channel-plugin model**: channels are plugins attached to one Gateway,
  each responsible only for protocol normalization (inbound) and wire-format rendering
  (outbound) — no channel owns business logic or session state itself. For a
  **two-channel-forever** bridge (per the map's explicit Telegram+Slack-only scope),
  ccbot doesn't need openclaw's full dynamic-plugin-loading machinery — a much simpler
  fixed two-implementation interface (`interface ChannelAdapter { send(...);
  resolveThread(...); }`) captures the same separation without the marketplace
  overhead.
- **ccgram's Multiplexer Protocol pattern**: a pure, I/O-free protocol module (no
  imports of either backend), two same-shaped implementations, and an *architectural
  fitness test* enforcing the boundary at CI time — not just at review time. This is
  the more directly applicable precedent for ccbot given the exact 2-backend shape
  (Telegram/Slack here vs. tmux/herdr there), and pairs naturally with the herdr
  cutover work already tracked separately (ccbot#25).
- n8n-claw's **Normalize Message** pattern (already surfaced in argus#105): collapse
  channel-specific inbound payloads (voice/photo/PDF/location/text for Telegram; Slack's
  own event shapes) into one common internal message shape *before* any core relay
  logic runs, and reverse that at the boundary on the way out (n8n-claw's own
  **Split Long Message** node for Telegram's message-length cap). ccbot's rewrite
  should locate this normalization boundary explicitly rather than letting
  channel-specific shapes leak into `BackgroundSessionBridge` or the relay core.

### 3. Topic/thread routing patterns

openclaw's session-key-suffix convention is the most directly transferable pattern
found, and is a good concrete spec to check ccbot's own `topic-manager.ts` /
`thread-map.ts` against:

- Telegram: `<chatId>:topic:<threadId>`, with the **General topic (threadId=1)
  special-cased** — sends omit `message_thread_id` (Telegram rejects it there), but
  typing indicators still include it.
- Slack: `agent:<agentId>:slack:channel:<channelId>`, with thread replies appending
  `:thread:<threadTs>` — root message and all replies share one session/state entry.
- RichardAtCT's `ThreadManager`/`ProjectRegistry` (YAML-driven project↔topic sync,
  explicit `/sync_threads` resync command, rate-limit-respecting pacing interval on
  topic-creation calls) is the closer scope-match to ccbot's actual per-project Forum
  Topics feature and worth using as the reference for the topic *creation/maintenance*
  side specifically (as opposed to openclaw's routing-key side).

### 4. Testing approaches for bot-integration/relay code

Concrete, directly-applicable patterns found, ranked by how close a match they are to
ccbot's own destination shape:

- **grammY**: outbound Bot API calls are intercepted via **transformer functions**
  (grammY's own outbound-middleware concept, documented at
  [grammy.dev/advanced/transformers](https://grammy.dev/advanced/transformers)) that
  record calls for later assertion instead of hitting the real API; inbound is tested
  by constructing synthetic `Update` objects and feeding them via `bot.handleUpdate()`.
  Two small community libraries build directly on this:
  [dcdunkan/grammy_tests](https://github.com/dcdunkan/grammy_tests) and
  [PavloPoliakov/grammy-with-tests](https://github.com/PavloPoliakov/grammy-with-tests)
  (a worked example repo). This is the single most directly reusable pattern for
  ccbot's Telegram side if the rewrite adopts grammY per finding (a) above.
- **Slack Bolt**: no official testing guide exists (Bolt-js issues #383, #1336, both
  still open) — the de facto community pattern is constructing `new App({ receiver:
  customReceiver, ... })` with a hand-built fake `Receiver` (Bolt's own
  transport-abstraction seam) and driving it directly with hand-constructed event
  payloads, run under mocha (Bolt-js's own `test:unit` script). Since ccbot already
  depends on `@slack/bolt`, this seam is already available without any dependency
  change — the rewrite just needs to actually use it.
- **RichardAtCT/claude-code-telegram** (closest scope-peer): pytest + pytest-asyncio,
  `tests/unit/` + presumably `tests/integration/` mirroring `src/`, `mypy --strict`,
  `make test` for coverage — the most directly comparable target test *shape* for a
  single-purpose Claude-Code↔chat bridge, modulo the Python-vs-TypeScript difference
  (would map to Vitest + `tests/unit`/`tests/integration` split + `--coverage`).
- **openclaw** (much larger, but same problem family): root `vitest.config.ts` + a
  dedicated `test/` dir with its own nested config + a separate `qa/` directory,
  confirming a mature multi-channel bridge treats test infrastructure as first-class
  repo structure, not a bolt-on — useful precedent for how much test-directory
  structure to budget for relative to ccbot's current single flat `test/` folder with
  3 files.
- **Design implication for the rewrite**: structure the new channel-adapter interface
  (finding 2) so that both Telegram and Slack adapters are testable the same way as
  grammY/Bolt's own testing seams — i.e. the adapter's outbound calls should go through
  an injectable client/transformer, not directly call `fetch`/`@slack/bolt` methods
  inline, so unit tests can intercept and assert without a live network call or
  external mocking library.

## Summary for the map (#214)

- The duplicate-notification bug is best fixed by inverting ccbot's process topology
  (one shared event-owning process/instance, N channel senders) — this is the
  consistent pattern across every mature multi-channel reference surveyed, not a
  ccbot-specific novel design.
- For a Telegram+Slack-only scope, a minimal fixed 2-implementation `ChannelAdapter`
  interface plus an architectural fitness test (ccgram's pattern) is a better fit than
  reproducing openclaw's dynamic plugin system.
- ccbot's existing Forum Topics routing should be checked against openclaw's
  General-topic (`threadId=1`) special case specifically, and its topic-creation flow
  against RichardAtCT's rate-limit pacing pattern.
- Recommend grammY (not Telegraf, which is 19 months stale) as the Telegram building
  block if the rewrite adopts a framework there instead of continuing the hand-rolled
  HTTP calls; keep Bolt for Slack (no change indicated). Both frameworks' own
  transformer/receiver seams should double as the rewrite's unit-testing seams,
  following grammY's own transformer-mock pattern and Bolt's fake-receiver-injection
  pattern — directly closing the testing gap (3 files / ~10K LOC today) using the same
  mechanism the frameworks already expose, rather than inventing a new test harness.

## Sources

- ccbot source: `apps/ccbot/src/relay/background-session-bridge.ts`,
  `apps/ccbot/src/utils/agent-view-monitor.ts`, `apps/ccbot/src/start-all-webhooks.ts`,
  `apps/ccbot/src/start-telegram-webhook.ts`, `apps/ccbot/src/start-slack-socket.ts`,
  `apps/ccbot/package.json` (read directly, this repo, 2026-08-10)
- argus#85, argus#105, argus#130, argus#131 (GitHub issues, including resolution
  comments)
- [grammyjs/grammY](https://github.com/grammyjs/grammY) · [grammy.dev](https://grammy.dev/) · [grammy.dev/ref/core/api](https://grammy.dev/ref/core/api) · [grammy.dev/advanced/transformers](https://grammy.dev/advanced/transformers)
- [telegraf/telegraf](https://github.com/telegraf/telegraf)
- [yagop/node-telegram-bot-api](https://github.com/yagop/node-telegram-bot-api)
- [slackapi/bolt-js](https://github.com/slackapi/bolt-js) · [docs.slack.dev/tools/bolt-js/concepts/socket-mode](https://docs.slack.dev/tools/bolt-js/concepts/socket-mode/) · [bolt-js#383](https://github.com/slackapi/bolt-js/issues/383) · [bolt-js#1336](https://github.com/slackapi/bolt-js/issues/1336)
- [slackapi/bolt-python](https://github.com/slackapi/bolt-python)
- [openclaw/openclaw](https://github.com/openclaw/openclaw) · [docs.openclaw.ai](https://docs.openclaw.ai/) · [docs.openclaw.ai/channels/telegram](https://docs.openclaw.ai/channels/telegram) · [docs.openclaw.ai/channels/slack](https://docs.openclaw.ai/channels/slack)
- [RichardAtCT/claude-code-telegram](https://github.com/RichardAtCT/claude-code-telegram) (README + CLAUDE.md read directly)
- [alexei-led/ccgram](https://github.com/alexei-led/ccgram)
- [six-ddc/ccbot](https://github.com/six-ddc/ccbot), [hanxiao/claudecode-telegram](https://github.com/hanxiao/claudecode-telegram), [linuz90/claude-telegram-bot](https://github.com/linuz90/claude-telegram-bot), [terranc/claude-telegram-bot-bridge](https://github.com/terranc/claude-telegram-bot-bridge), [gergomiklos/heyagent](https://github.com/gergomiklos/heyagent)
- [Cursor Slack integration docs](https://docs.cursor.com/en/slack)
- [Chatwoot webhook processing / message routing — DeepWiki](https://deepwiki.com/chatwoot/chatwoot/7.8-webhook-processing-and-message-routing)
- [dcdunkan/grammy_tests](https://github.com/dcdunkan/grammy_tests), [PavloPoliakov/grammy-with-tests](https://github.com/PavloPoliakov/grammy-with-tests)
- Star/fork/push-date figures: `gh api repos/<owner>/<repo>` (GitHub REST API), run 2026-08-10
