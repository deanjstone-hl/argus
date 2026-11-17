# Driving Claude on a subscription from a third-party app: mechanism survey

**Ticket:** [argus#304](https://github.com/deanjstone/argus/issues/304) (wayfinder research, child of [#303](https://github.com/deanjstone/argus/issues/303)), extended by [argus#311](https://github.com/deanjstone/argus/issues/311) — see [§6](#6-probes-closed-caller-injected-tool_result-and-the-harness-context-floor)
**Date:** 2026-08-25 (§§1–5), 2026-08-25 (§6)
**Scope:** Mechanism only. The terms-of-service / permission question is [argus#305](https://github.com/deanjstone/argus/issues/305) and is deliberately **not** evaluated here.

## How to read this document

Every claim is tagged:

- **[FACT-DOC]** — stated in an Anthropic-published primary source, cited inline.
- **[FACT-OBS]** — directly observed on this machine. Environment: Claude Code CLI `2.1.241`, `@anthropic-ai/claude-agent-sdk` `0.3.241`, Linux (WSL2), account `subscriptionType: "max"`, no `ANTHROPIC_API_KEY` in the environment.
- **[INFERENCE]** — my reasoning from the above, not directly verified. Treat as a hypothesis.

Raw probe artefacts were written to a scratch directory and are not committed; every `[FACT-OBS]` line below quotes the observed output verbatim so the finding stands without them. Where a later probe supersedes an earlier `[INFERENCE]`, the original line is left in place and annotated rather than deleted, so the reasoning trail stays readable.

### Sources

| Ref | Source | Type |
|---|---|---|
| S1 | <https://code.claude.com/docs/en/authentication> | Anthropic docs |
| S2 | <https://code.claude.com/docs/en/headless> | Anthropic docs |
| S3 | <https://code.claude.com/docs/en/agent-sdk> (Agent SDK overview) | Anthropic docs |
| S4 | <https://code.claude.com/docs/en/agent-sdk/custom-tools> | Anthropic docs |
| S5 | `@anthropic-ai/claude-agent-sdk@0.3.241` → `sdk.d.ts`, `bridge.d.ts` (shipped TypeScript declarations, with doc comments) | First-party source |
| S6 | `claude --help`, `claude auth --help`, `claude setup-token --help` on v2.1.241 | First-party CLI |
| S7 | Local probe runs of `claude -p --output-format stream-json` and the Agent SDK | Direct observation |
| S8 | `sdk.d.ts` from `@anthropic-ai/claude-agent-sdk@0.3.241` — `SDKUserMessage` (`priority`, `shouldQuery`, `tool_use_result`) | First-party source |
| S9 | #311 probe rig: a dependency-free MCP stdio server (`respond`/`hang` modes) + a stream-json driver that injects caller-authored `tool_result` blocks; plus a 13-row CLI harness-context matrix and a like-for-like SDK run. Section [§6](#6-probes-closed-caller-injected-tool_result-and-the-harness-context-floor) | Direct observation |

---

## Executive summary

Four mechanisms exist. Only two are real candidates, and they are the same mechanism at different altitudes.

| # | Mechanism | Subscription auth? | Caller-defined tools? | Plain completion endpoint? | Stability |
|---|---|---|---|---|---|
| 1 | Claude Code CLI headless (`claude -p --output-format stream-json`) | Yes | Yes, via MCP | No — approximation only | Documented, versioned |
| 2 | `@anthropic-ai/claude-agent-sdk` (spawns the CLI) | Yes | Yes, in-process MCP | No — approximation only | Documented, versioned |
| 3 | `claude setup-token` → `CLAUDE_CODE_OAUTH_TOKEN` | Yes, 1-year token | n/a (feeds 1 & 2) | n/a | Documented |
| 4 | Third-party OAuth/PKCE against Anthropic | **Does not exist** | — | — | — |

**The headline findings:**

1. **There is no third-party OAuth flow.** No public authorization-server metadata is published, and Anthropic's own Agent SDK documentation states plainly that third-party developers are not allowed to offer claude.ai login. This is a well-evidenced negative — see [§4](#4-third-party-oauth-the-negative-finding).
2. **The CLI/SDK is not a completion endpoint and cannot be made into one.** It is an agent harness — session persistence and agent-loop semantics come with it whether you want them or not. It is, however, *cheap*: the floor is **636 tokens** on both the CLI and the SDK once `--setting-sources ""` / `settingSources: []` is set ([§6.3](#63-probe-2--the-harness-context-floor---setting-sources--closes-the-gap-entirely) — this supersedes the ~16k figure §1.5 originally reported). The separate trap is that the leanest mode, `--bare`, is *explicitly API-key-only* — it refuses to read subscription credentials ([§1.6](#16---bare-mode-the-trap)).
3. **A caller *can* fully own the tool surface**, but only by implementing MCP servers, and the CLI always drives the loop. The caller never receives a `tool_use` it is responsible for answering out-of-band; it receives an MCP `tools/call` and returns a result ([§1.4](#14-can-the-caller-supply-its-own-tools)). **The one remaining escape hatch was probed and is closed** — caller-authored `tool_result` blocks on stream-json stdin are silently stripped ([§6.1](#61-probe-1--caller-injected-tool_result-is-silently-stripped)). The inversion is final.
4. **Thinking content is delivered redacted.** Signatures arrive in full; the reasoning text is empty ([§1.3](#13-thinking-blocks-and-signatures)).

---

## 1. Claude Code CLI headless

### 1.1 Confirmed surface

**[FACT-OBS]** `claude --version` → `2.1.241`. `claude --help` (S6) confirms `-p/--print`, `--output-format <text|json|stream-json>`, `--input-format <text|stream-json>`, `--include-partial-messages`, `--verbose`, `--tools`, `--allowedTools`, `--disallowedTools`, `--mcp-config`, `--strict-mcp-config`, `--system-prompt`, `--append-system-prompt`, `--json-schema`, `--max-budget-usd`, `--permission-mode`, `--bare`, `--disable-slash-commands`, `--setting-sources`.

**[FACT-DOC]** (S2) `--output-format` values: "`text` (default): plain text output / `json`: structured JSON with result, session ID, and metadata / `stream-json`: newline-delimited JSON for real-time streaming."

**[FACT-DOC]** (S2) "Use `--output-format stream-json` with `--verbose` and `--include-partial-messages` to receive tokens as they're generated. Each line is a JSON object representing an event… The last line of the stream is a `result` message with the final response text, cost, and session metadata."

### 1.2 The stream-json event schema, as observed

**[FACT-OBS]** Probe: `claude -p --output-format stream-json --verbose --tools "" --model sonnet 'Reply with exactly: PONG'`. Top-level `type` values observed across all probes:

| `type` | `subtype` | Notes |
|---|---|---|
| `system` | `hook_started` / `hook_progress` / `hook_response` | Emitted only because this machine has SessionStart hooks configured. **[FACT-DOC]** (S2) these precede `system/init`. |
| `system` | `init` | Session metadata. Keys observed: `cwd`, `session_id`, `tools`, `mcp_servers`, `model`, `permissionMode`, `slash_commands`, `apiKeySource`, `claude_code_version`, `output_style`, `agents`, `skills`, `plugins`, `capabilities`, `memory_paths`, `fast_mode_state`. |
| `system` | `status` | Observed once; undocumented in S2. |
| `stream_event` | — | Present only with `--include-partial-messages`. Wraps a raw Anthropic Messages API streaming event under `.event`. |
| `assistant` | — | `.message` is an Anthropic Messages API assistant message. Carries `parent_tool_use_id`, `session_id`, `uuid`, `request_id`. |
| `user` | — | Carries `tool_result` blocks back into the stream. |
| `rate_limit_event` | — | Undocumented in S2; see below. |
| `result` | `success` | Terminal event. |

**[FACT-DOC]** (S2) also documents `system/api_retry` (fields `attempt`, `max_retries`, `retry_delay_ms`, `error_status`, `error`) and `system/plugin_install`. Neither fired in my probes.

**Text deltas — [FACT-OBS].** With `--include-partial-messages`, the inner `.event` objects are verbatim Anthropic streaming events:

```json
{"type":"stream_event","event":{"type":"content_block_delta","index":0,
 "delta":{"type":"text_delta","text":"1"}},
 "session_id":"…","parent_tool_use_id":null,"uuid":"…"}
```

Observed inner event types: `message_start`, `content_block_start`, `content_block_delta`, `content_block_stop`, `message_delta`, `message_stop`.

**Usage — [FACT-OBS].** The `result` event's `usage` carries `input_tokens`, `output_tokens`, `output_tokens_details.thinking_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens`, `cache_creation.{ephemeral_5m,ephemeral_1h}_input_tokens`, `server_tool_use`, `service_tier`, and an `iterations` array (per-request breakdown). Separately, `modelUsage` gives a per-model rollup including `costUSD`, `contextWindow`, `maxOutputTokens`, and `provider` (observed: `"firstParty"`). `total_cost_usd` sits at the top level.

**[FACT-DOC]** (S2) warns these are estimates: "Both figures are client-side estimates and can differ from your actual bill."

**Rate limits — [FACT-OBS].** A `rate_limit_event` fired on every probe:

```json
{"type":"rate_limit_event","rate_limit_info":{"status":"allowed","resetsAt":1787641800,
 "rateLimitType":"five_hour","overageStatus":"rejected",
 "overageDisabledReason":"org_level_disabled_until","isUsingOverage":false}}
```

**[INFERENCE]** This event is subscription-specific plumbing — it reports the Pro/Max 5-hour rolling window, which has no API-key analogue. A third-party app consuming this stream would get usable quota telemetry for free. It is not documented in S2, so treat the shape as unstable.

### 1.3 Thinking blocks and signatures

**[FACT-OBS]** Probe: `claude -p --output-format stream-json --verbose --include-partial-messages --tools "" --strict-mcp-config --model sonnet 'ultrathink: is 1093 prime? Answer yes or no only.'`

A thinking content block was emitted, ahead of the text block:

```
BLOCK_START {"type":"thinking","thinking":"","signature":""}
DELTA first thinking_delta   {"type":"thinking_delta","thinking":"","estimated_tokens":50}
DELTA first signature_delta  {"type":"signature_delta","signature":"EsYECqgBCBEYAipAihvXOA+iAeA+…"}
```

**[FACT-OBS] — the notable part.** The final assistant `thinking` block had `len(thinking) == 0` and `len(signature) == 784`. Across the whole stream there were 2 `thinking_delta` frames carrying **0 characters** of thinking text in total. The reasoning content was fully redacted; the cryptographic signature was delivered intact.

**[FACT-DOC]** (S5, `sdk.d.ts`) corroborates that this is a designed mode, not a glitch — the type declarations describe: *"Live thinking-token estimate, digested from `thinking_delta.estimated_tokens` during the redacted-thinking phase (where the API otherwise streams only pings)."*

**[FACT-DOC]** (S5) also documents signed-thinking replay semantics: *"This turn continued the preceding truncated assistant turn inside its trailing signed thinking block (max-output-tokens recovery). Its thinking signatures are cumulative over that preceding thinking-only turn, so a history replayed through the bridge must carry this flag back for the normalizer to keep the run's prefix on the wire."*

**[INFERENCE]** For a third-party app this means: you can show a "thinking…" progress indicator driven by `estimated_tokens`, and you must round-trip the opaque `signature` if you ever replay history, but you cannot display or log the model's reasoning. Whether redaction is universal or specific to this account tier / model was **not** established — I observed one account on `claude-sonnet-5`. Anyone depending on thinking text should re-test.

### 1.4 Can the caller supply its own tools?

**Short answer: yes for the tool *surface*, no for the tool *loop*.**

**[FACT-OBS]** I wrote a ~30-line dependency-free MCP stdio server exposing one tool (`secret_number`) and ran:

```bash
claude -p --output-format stream-json --verbose \
  --tools "" --strict-mcp-config --mcp-config mcp.json \
  --allowed-tools "mcp__probe__secret_number" \
  --permission-mode acceptEdits --disable-slash-commands \
  --system-prompt "You are a terse assistant with one tool." --model sonnet \
  'What is the secret number? Use the tool, then state it.'
```

Result — the caller's tool was the *only* tool in the session:

```
init.tools       = ["mcp__probe__secret_number"]
init.mcp_servers = [{"name":"probe","status":"connected"}]
```

The tool round-tripped correctly. The assistant emitted a standard Anthropic `tool_use` block:

```json
{"type":"tool_use","id":"toolu_01BAiq3stjSzQSDVhR9CBKec",
 "name":"mcp__probe__secret_number",
 "input":{"reason":"User asked for the secret number."},
 "caller":{"type":"direct"}}
```

…and the result came back as a `user` message:

```json
[{"tool_use_id":"toolu_01BAiq3stjSzQSDVhR9CBKec","type":"tool_result",
  "content":[{"type":"text","text":"4271"}]}]
```

My MCP server's log confirms the CLI called *into* it, passing the tool-use correlation id in MCP `_meta`:

```
REQ initialize / REQ notifications/initialized / REQ tools/list / REQ tools/call
CALL {"name":"secret_number","arguments":{"reason":"…"},
      "_meta":{"claudecode/toolUseId":"toolu_01BAiq3stjSzQSDVhR9CBKec","progressToken":2}}
```

**[FACT-OBS]** Note that `--tools ""` alone is **not** sufficient to clear the tool surface: in my first probe, `--tools ""` left 30+ `mcp__agent-intern__*` tools in `init.tools`, inherited from this machine's user-level MCP config. Clearing the surface requires `--tools "" --strict-mcp-config` together. **[FACT-DOC]** (S4) confirms the division: "`tools: []` … All built-ins are removed. Claude can only use your MCP tools." and "MCP tools are unaffected" by the `tools` option.

**[FACT-DOC]** (S4) the SDK equivalent runs in-process, not as a subprocess: "After defining a tool, wrap it in a server with `createSdkMcpServer` (TypeScript) or `create_sdk_mcp_server` (Python). **The server runs in-process inside your application, not as a separate process.**"

**The architectural answer.** There is **no** mechanism where the caller passes raw Anthropic tool definitions and receives a `tool_use` it must answer out-of-band. The contract is inverted:

- **Anthropic Messages API:** caller sends `tools[]`, receives `tool_use`, caller runs the loop.
- **Claude Code CLI / Agent SDK:** caller registers an MCP server, the CLI runs the loop and *calls back into the caller* via MCP `tools/call`.

**[FACT-DOC]** (S3) Anthropic states this distinction themselves in their product comparison table — Agent SDK is for "Building an agent **without implementing the tool loop yourself**", whereas the Client SDK is for "Calling the API directly and implementing the tool loop yourself… **You implement the tool loop yourself.**"

**[INFERENCE]** For vault-operator this is a real architectural constraint, not a formatting difference. Any existing code shaped as "build `tools[]` → call API → switch on `tool_use` → return `tool_result`" cannot be adapted; each tool must be re-expressed as an MCP handler, and orchestration control (retries, ordering, early termination, injecting synthetic results) moves from the app into the CLI. Two escape hatches exist but are partial:

- `canUseTool` / `permissionPromptToolName` intercepts every call before it runs. **[FACT-DOC]** (S5) `PermissionResult` is `{behavior:'allow', updatedInput?}` or `{behavior:'deny', message}`. So a caller can rewrite arguments, or block a call and hand the model an arbitrary string. **[FACT-OBS]** *(probed in [§6.2](#62-probe-1b--the-deny-message-is-a-synthetic-result-channel-confirmed), #311 — supersedes the earlier `[INFERENCE]` here)* the deny `message` **is** surfaced to the model as the tool result, verbatim, on both the SDK and the CLI — but stamped `is_error: true`, fired before the tool runs, and silently shadowed by bare `allowedTools` entries and by settings-file allow rules. A usable narrow escape hatch; not a general loop.
- `--input-format stream-json` accepts caller-written messages. **[FACT-DOC]** (S5) `SDKUserMessage.message` is an Anthropic `MessageParam` whose "content is a string or an array of content blocks (text, image, document, **tool_result**, …)". **[FACT-OBS]** *(probed in [§6.1](#61-probe-1--caller-injected-tool_result-is-silently-stripped), #311 — this **disproves** the earlier `[INFERENCE]` that a caller could inject a `tool_result` directly)* caller-authored `tool_result` blocks are **silently stripped** from stream-json input. Across six variants they never answered the pending `tool_use`, never reached the model, and never produced a diagnostic; a sibling `text` block in the same message *did* get through, proving the filter is block-level and deliberate. The `MessageParam` type is a reused Anthropic SDK type, not a supported input path. **The inversion is final.**

### 1.5 Can it be a plain completion endpoint?

**No — but you can get closer than expected.** There is no documented "completion mode" flag. The nearest approximation is stripping the harness:

**[FACT-OBS]** Measured `cache_creation_input_tokens` (the harness context billed on a cold call) across configurations:

| Invocation | Harness tokens |
|---|---|
| `claude -p --tools ""` (this machine's config) | **62,484** |
| `+ --strict-mcp-config --disable-slash-commands --system-prompt "…"` | **16,232** |
| Agent SDK with `settingSources: []`, `tools: []`, `strictMcpConfig: true` | **0** (`input_tokens` 835) |

**[FACT-OBS]** The SDK path with `settingSources: []` was dramatically leaner than any CLI invocation I found — 835 input tokens, no cache-creation block at all.

> **Superseded by [§6.3](#63-probe-2--the-harness-context-floor---setting-sources--closes-the-gap-entirely) (#311).** The gap was a missing flag, not an architectural difference. `--setting-sources ""` on the CLI reproduces the SDK floor **exactly** — both land on **636** tokens in a like-for-like re-measurement. The minimal recipe is `claude -p --tools "" --setting-sources "" --system-prompt "…"`, and it keeps subscription auth (`apiKeySource: "none"`). The `[INFERENCE]` immediately below was directionally right about the *cause* and wrong about the *magnitude* — the residual was setting-source discovery, and suppressing it removes ~14.7k of the ~15.3k, not some of it.

**[INFERENCE]** *(now confirmed as to cause, see §6.3)* The CLI's residual ~16k is the default system prompt plus auto-discovered `CLAUDE.md` / memory, which `--system-prompt` replaces but `--setting-sources`/`--add-dir` discovery still reintroduces. The SDK's `settingSources: []` is the documented lever for suppressing that discovery, and it evidently works far better than the CLI flag combination I tried. I did not exhaustively search for a CLI flag set that matches the SDK's 835 — **it may exist**; `--setting-sources` with an empty value is the obvious next probe and I did not run it.

**[FACT-DOC]** (S2) structured output is available without tools: `--output-format json --json-schema '{…}'` returns the value in a `structured_output` field. **[INFERENCE]** for an app that just wants typed JSON back from a prompt, this is the closest thing to a completion call on offer.

**Verdict — [INFERENCE].** ~~You can drive it as a very expensive single-turn completion endpoint.~~ *(Revised per §6.3: it is not expensive — the floor is 636 tokens on both the CLI and the SDK.)* You can drive it as a single-turn completion endpoint. You cannot make it *be* one: you always pay a harness system prompt, you always get session persistence and agent-loop semantics, and the flag combination required is undocumented as a supported use case, so it is a configuration you are maintaining against an agent product's release cadence.

### 1.6 `--bare` mode: the trap

This is the most important operational gotcha found.

**[FACT-DOC]** (S6, `claude --help`) `--bare` is described as: "Minimal mode: skip hooks, LSP, plugin sync, attribution, auto-memory, background prefetches, keychain reads, and CLAUDE.md auto-discovery. Sets `CLAUDE_CODE_SIMPLE=1`. **Anthropic auth is strictly `ANTHROPIC_API_KEY` or `apiKeyHelper` via `--settings` (OAuth and keychain are never read).**"

**[FACT-DOC]** (S2) repeats it: "Set `ANTHROPIC_API_KEY` before running it, because bare mode doesn't use your subscription login" and "**In bare mode, Claude Code never reads OAuth credentials or the system keychain.**"

**[FACT-DOC]** (S1) "Bare mode does not read `CLAUDE_CODE_OAUTH_TOKEN`. If your script passes `--bare`, authenticate with `ANTHROPIC_API_KEY` or an `apiKeyHelper` instead."

**[FACT-OBS]** Verified directly: `claude --bare -p --model sonnet 'say OK'` on this subscription-authenticated machine printed `Not logged in · Please run /login`.

**[FACT-DOC]** (S2) "`--bare` is the recommended mode for scripted and SDK calls, **and will become the default for `-p` in a future release.**"

**[INFERENCE]** This is a direct collision with the subscription path, and it is on Anthropic's roadmap. The lean, low-latency, deterministic mode that Anthropic recommends for exactly the scripted/embedded use case a third-party app has is the one mode that structurally refuses subscription credentials. If `--bare` becomes the `-p` default, any subscription-driven integration must start passing an explicit opt-out flag — or break. **This should be treated as a standing risk on the map, not a footnote.**

---

## 2. `@anthropic-ai/claude-agent-sdk`

### 2.1 Does it authenticate off local Claude Code credentials?

**Yes — verified. [FACT-OBS]**

Probe: `@anthropic-ai/claude-agent-sdk@0.3.241`, run with `env -u ANTHROPIC_API_KEY -u ANTHROPIC_AUTH_TOKEN -u CLAUDE_CODE_OAUTH_TOKEN node probe.mjs`:

```
ANTHROPIC_API_KEY set? false
init.apiKeySource = "none"
init.tokenSource  = undefined
init.model        = claude-sonnet-5
result.subtype = success
result.result  = "SDKPONG"
```

With all three credential environment variables explicitly unset, the SDK completed a model request using this machine's `/login` subscription credentials.

**[FACT-DOC]** (S5, `sdk.d.ts`) documents the `apiKeySource` value precisely: "Where the credential used for API requests came from: `'ANTHROPIC_API_KEY'` (environment variable), `'apiKeyHelper'` (the configured helper command), `'/login managed key'` …, or **`'none'` (no API key in use — e.g. claude.ai OAuth login**, a bearer token, or a third-party cloud provider)."

**[FACT-DOC]** (S1) explains why: "`apiKeyHelper`, `ANTHROPIC_API_KEY`, and `ANTHROPIC_AUTH_TOKEN` apply to the CLI **and the surfaces that wrap it, including the VS Code extension, the Agent SDK, and GitHub Actions.**"

**[FACT-DOC]** (S5) The SDK exposes `pathToClaudeCodeExecutable`, `executable: 'bun'|'deno'|'node'`, `executableArgs`, and `spawnClaudeCodeProcess?: (options: SpawnOptions) => SpawnedProcess` in its `Options` type. **[FACT-OBS]** the published package declares **no runtime dependencies** and ships no CLI binary of its own.

**[INFERENCE]** The SDK is a typed wrapper that spawns the separately-installed Claude Code CLI as a subprocess and speaks the same stream-json protocol over its stdio. Auth is therefore not the SDK's concern at all — it inherits whatever the CLI resolves. Practical consequence for an Electron app: **the SDK is not self-contained.** Shipping it means either bundling/installing the Claude Code CLI or depending on the user having installed it, and the SDK version must stay compatible with the CLI version. This is a packaging problem, not just a dependency line.

### 2.2 What the SDK exposes that the CLI does not

**[FACT-DOC]** (S5, `Options` type) — capabilities with no clean CLI equivalent:

| Capability | Why it matters |
|---|---|
| `canUseTool` callback | Synchronous in-process interception of every tool call, with `updatedInput` rewriting. Over the CLI this requires the control protocol or an external permission-prompt MCP tool. |
| `hooks` as in-process callbacks | `Partial<Record<HookEvent, HookCallbackMatcher[]>>` — 31 hook events as function references, not shell scripts. |
| `mcpServers` with live instances | `McpSdkServerConfigWithInstance` carries a real `McpServer` object. **[FACT-DOC]** (S4) "runs in-process inside your application, not as a separate process" — no subprocess, no stdio serialisation. |
| `settingSources: []` | Suppresses user/project/local config discovery. **[FACT-OBS]** this is what produced the 835-token floor in §1.5. |
| `onElicitation`, `onUserDialog`, `supportedDialogKinds` | Structured interaction requests routed to caller-supplied UI — the natural fit for an Electron front end. |
| `sessionStore` / `InMemorySessionStore` | Caller-owned session persistence instead of `~/.claude/projects`. |
| Session management functions | `listSessions`, `getSessionInfo`, `getSessionMessages`, `forkSession`, `deleteSession`, `getSubagentMessages`, `importSessionToStore`. |
| `stderr: (data: string) => void` | Captures subprocess stderr rather than losing it. |

**[FACT-DOC]** (S3) "The SDK is available as a library for Python and TypeScript only. To drive the same agent loop from another language, run the CLI as a subprocess with the `-p` flag and `--output-format json`." — Anthropic frames the CLI as the fallback for non-TS/Python callers, confirming the SDK is the intended path for a Node/Electron app.

### 2.3 The `/bridge` export — noted and dismissed

**[FACT-DOC]** (S5, `bridge.d.ts`) The package ships a `@anthropic-ai/claude-agent-sdk/bridge` export whose types (`BridgeSessionHandle`) describe a session transport to a "CCR `/worker` endpoint", carrying `sendControlRequest`/`sendControlResponse` for permission prompts and a JWT-based `reconnectTransport({ingressToken, apiBaseUrl})`. Comments reference forwarding permission requests "to claude.ai".

**[FACT-DOC]** (S5) Every type in this file is annotated **`@alpha`**.

**[INFERENCE]** This is the Claude Code Remote plumbing that backs claude.ai-hosted and Remote Control sessions — Anthropic-internal infrastructure exposed for their own first-party surfaces. It is not a third-party auth mechanism: the JWT is minted by Anthropic's backend per dispatch, not obtainable by an external app. Flagging it only so a future reader who finds it in the type definitions does not mistake it for an opening. **`@alpha` + undocumented + internally-minted credentials = do not build on this.**

---

## 3. Where subscription credentials live

**[FACT-DOC]** (S1), verbatim:

> - On macOS, credentials are stored in the encrypted macOS Keychain.
> - On Linux, credentials are stored in `~/.claude/.credentials.json` with file mode `0600`.
> - On Windows, credentials are stored in `%USERPROFILE%\.claude\.credentials.json` and inherit the access controls of your user profile directory…
> - If you've set the `CLAUDE_CONFIG_DIR` environment variable on Linux or Windows, the `.credentials.json` file lives under that directory instead.
> - **Claude Code manages `.credentials.json` through `/login` and `/logout`.**

**[FACT-OBS]** Confirmed on this machine: `~/.claude/.credentials.json` exists, mode `0600`. Its structure (inspected as a key/type map; **no token values were read or recorded**) is:

```
claudeAiOauth.accessToken            (string)
claudeAiOauth.refreshToken           (string)
claudeAiOauth.expiresAt              (int, epoch ms)
claudeAiOauth.refreshTokenExpiresAt  (int, epoch ms)
claudeAiOauth.scopes                 (array)
claudeAiOauth.subscriptionType       (string)
claudeAiOauth.rateLimitTier          (string)
mcpOAuth.<server>|<hash>.{serverName, serverUrl, accessToken, clientId, redirectUri, discoveryState}
```

Note the file holds two unrelated things: the user's own subscription OAuth grant (`claudeAiOauth`), and per-MCP-server OAuth tokens where *Claude is the client* to some third-party service (`mcpOAuth`). They are easy to confuse when searching; only the former is the subscription credential.

**[FACT-OBS]** `claude auth status` emits machine-readable JSON — a supported read path that exposes auth state without touching the credential file:

```json
{"loggedIn":true,"authMethod":"claude.ai","apiProvider":"firstParty",
 "email":"…","orgId":"…","orgName":"…","subscriptionType":"max"}
```

### Is reading/reusing the file supported?

**No. [FACT-DOC]/[INFERENCE]**

- **[FACT-DOC]** (S1) The documentation describes the file only under "Credential management" as an implementation location, and states it is managed *through `/login` and `/logout`*. No documented read/parse/reuse contract, no schema, no stability guarantee is published for its contents.
- **[FACT-DOC]** (S1) Where Anthropic *does* offer supported credential injection, they name specific mechanisms: the `apiKeyHelper` setting ("a shell script that returns an API key"), `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, and `CLAUDE_CODE_OAUTH_TOKEN`. The credential file is not among them.
- **[FACT-DOC]** (S1) The macOS storage is the encrypted Keychain, so **the file does not exist at all on macOS** — any cross-platform app parsing `.credentials.json` is broken on one of the three desktop platforms before it ships.
- **[INFERENCE]** Reading it is an implementation detail that will break. The schema is unversioned and undocumented; tokens are refreshed on Claude Code's own schedule, so an external reader races the refresh and can cache a stale `accessToken`; and any migration (to a keyring, an OS credential store, or a different filename) would be invisible until it broke.

### The one supported subscription-credential export

**[FACT-DOC]** (S6) `claude setup-token` — "Set up a long-lived authentication token (requires Claude subscription)".

**[FACT-DOC]** (S1), verbatim:

> For CI pipelines, scripts, or other environments where interactive browser login isn't available, generate a **one-year OAuth token** with `claude setup-token`… The command opens the same browser authorization flow as `/login`, and the token prints to the terminal after you approve access in the browser. **It does not save the token anywhere;** copy it and set it as the `CLAUDE_CODE_OAUTH_TOKEN` environment variable…
>
> This token authenticates with your Claude subscription and requires a Pro, Max, Team, or Enterprise plan. **It can only make model requests,** so it can't establish Remote Control sessions or fetch claude.ai connectors. MCP servers you configure locally still work.

**[FACT-DOC]** (S1) Precedence: `CLAUDE_CODE_OAUTH_TOKEN` sits at position 5 in the credential order, above `/login` subscription credentials at position 7 but below `ANTHROPIC_API_KEY` (3) and `apiKeyHelper` (4).

**[INFERENCE]** This is the *only* documented way to hand subscription auth to something that isn't an interactive Claude Code session, and it is by some distance the cleanest mechanism found. Its shape matters for form factor: it is a **manual, user-performed, out-of-band step** — the user runs a terminal command, completes a browser flow, copies a string, and pastes it into your app. There is no programmatic way for an app to trigger it and receive the token. **[INFERENCE]** an app can, however, present this as a first-class onboarding step ("paste your Claude Code token") and set the variable for its own CLI subprocess, which is a legitimate, documented configuration — and notably the same UX shape as a user pasting an API key.

**[FACT-DOC]** (S1) Caveat for org-managed users: `setup-token` "enforce[s] only `forceLoginMethod`, so [it] can mint a token in a different organization."

---

## 4. Third-party OAuth: the negative finding

**This is the ticket's dealbreaker question, and the answer is no.** Three independent lines of evidence.

### 4.1 Anthropic says so directly

**[FACT-DOC]** (S3, Agent SDK overview) — verbatim, from a `<Note>` callout on Anthropic's own documentation page:

> **Unless previously approved, Anthropic does not allow third party developers to offer claude.ai login or rate limits for their products, including agents built on the Claude Agent SDK. Use the API key authentication methods described in the Quickstart instead.**

This is a primary source. Note "unless previously approved" — a bespoke partner arrangement is evidently possible, but there is no self-serve path and no published process for requesting one.

*(This statement is cited here as evidence about the availability of a mechanism. Whether it constitutes a binding terms-of-service constraint is [#305](https://github.com/deanjstone/argus/issues/305)'s question, not this document's.)*

### 4.2 No OAuth server metadata is published

**[FACT-OBS]** RFC 8414 / OIDC discovery probes, run 2026-08-25:

| Endpoint | Result |
|---|---|
| `https://claude.ai/.well-known/oauth-authorization-server` | **HTTP 404** |
| `https://console.anthropic.com/.well-known/oauth-authorization-server` | 301 → `platform.claude.com/...` → **HTTP 404** |
| `https://api.anthropic.com/.well-known/oauth-authorization-server` | **HTTP 404** |

**[INFERENCE]** No discoverable authorization server means no client registration, no published `authorization_endpoint`/`token_endpoint`, no advertised PKCE support, and no scope vocabulary. Claude Code's own OAuth flow is a private contract between Anthropic's client and Anthropic's backend.

### 4.3 The documented login paths are all first-party

**[FACT-DOC]** (S1) Anthropic enumerates every login path: "the terminal `/login` flow, the VS Code extension, the Agent SDK, `claude setup-token`, `/install-github-app`, and gateway sign-in." Every one is an Anthropic-authored surface. There is no "your application" entry, no client-registration step, and no redirect-URI configuration anywhere in the authentication documentation.

**[FACT-DOC]** (S1) Where Anthropic *does* document OAuth for third parties, it runs the other direction — Claude as an OAuth **client** to your MCP server. **[FACT-OBS]** the `mcpOAuth` block in `.credentials.json` (§3) is exactly this. **[INFERENCE]** This is a live trap for anyone researching the question: searching "Anthropic OAuth PKCE" surfaces substantial genuine documentation for MCP-connector authorization, which looks superficially like what you want and is the opposite thing. Do not mistake it for a subscription-auth path.

### 4.4 Contrast with the OpenAI/Codex precedent

**[INFERENCE]** The ticket asks for the equivalent of `ChatGptOAuthService.ts`. No equivalent exists. The structural difference: OpenAI exposes a ChatGPT-subscription OAuth flow that a third-party client can implement against; Anthropic's equivalent flow exists but is a closed contract between Anthropic's own clients and backend, with the only sanctioned export being a manually-generated `CLAUDE_CODE_OAUTH_TOKEN` the user copies by hand. **A direct port of the Codex OAuth pattern is not possible.** I did not re-verify OpenAI's current offering as part of this ticket — that half is carried over from the ticket's framing.

---

## 5. What this means for the map

**[INFERENCE] — all of this section.**

**There is a mechanism, and it is viable.** The dealbreaker premise ("wasted effort if there is no legitimate subscription path") does not hold: `claude setup-token` → `CLAUDE_CODE_OAUTH_TOKEN` → Agent SDK is a fully documented chain from a user's subscription to a running model request in a third-party Node process. The blocking question moves to #305.

**But it is not a drop-in replacement for `src/api/providers/anthropic.ts`.** The existing provider is SDK + API key + `tools[]` + a caller-driven tool loop. Every one of those four changes:

1. **No API key** → `CLAUDE_CODE_OAUTH_TOKEN`, sourced by a manual user-performed browser flow, pasted into the app.
2. **No `@anthropic-ai/sdk`** → `@anthropic-ai/claude-agent-sdk`, which is a *subprocess wrapper*, so the Claude Code CLI becomes a runtime dependency the Electron app must bundle or require.
3. **No `tools[]`** → every tool re-expressed as an `createSdkMcpServer` handler.
4. **No caller-driven loop** → the CLI owns orchestration; the app's control surface narrows to `canUseTool` interception and hook callbacks.

**Three risks worth carrying onto the map explicitly:**

- **The `--bare` collision (§1.6).** Anthropic recommends `--bare` for scripted/SDK use and intends to make it the `-p` default, and `--bare` structurally cannot use subscription auth. The recommended path and the subscription path are diverging, by design, on Anthropic's roadmap.
- **Version coupling.** CLI `2.1.241` and SDK `0.3.241` share a version suffix; the SDK spawns the CLI and speaks a protocol that carries a `capabilities` array for feature detection. This is a fast-moving product, and the app is pinned to two of its versions at once.
- **Undocumented surface in the hot path.** `rate_limit_event` (the subscription quota signal, §1.2) and redacted-thinking behaviour (§1.3) are both unmentioned in S2. Useful, and unversioned.

**Two probes I did not run**, worth closing before the map commits — **both now closed in [§6](#6-probes-closed-caller-injected-tool_result-and-the-harness-context-floor) (#311):**

1. ~~Whether `--setting-sources` with an empty value reproduces the SDK's 835-token floor on the CLI (§1.5)~~ — **it does, exactly**: both floor at **636** tokens (§6.3). The token argument for bundling the SDK over shelling out is gone.
2. ~~Whether a caller-injected `tool_result` block over `--input-format stream-json` is actually honoured mid-turn (§1.4)~~ — **it is not.** The block is silently stripped (§6.1). The inversion is final and there is no caller-driven tool loop at any altitude.

Also settled while there: the `canUseTool` deny `message` **is** surfaced to the model as the tool result, verbatim, with `is_error: true` (§6.2).

---

## 6. Probes closed: caller-injected `tool_result`, and the harness-context floor

**Ticket:** [argus#311](https://github.com/deanjstone/argus/issues/311) (wayfinder research, child of [#303](https://github.com/deanjstone/argus/issues/303)), closing the two probes §1.4 and §1.5 left open.
**Date:** 2026-08-25.
**Environment for every `[FACT-OBS]` in this section:** Claude Code CLI `2.1.241` (`/home/deanj/.local/share/claude/versions/2.1.241`), `@anthropic-ai/claude-agent-sdk` `0.3.241`, Linux (WSL2), `claude-haiku-4-5-20251001`, `apiKeySource: "none"` (subscription auth; `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN` and `CLAUDE_CODE_OAUTH_TOKEN` all unset — verified `env | grep -cE '^(ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN|CLAUDE_CODE_OAUTH_TOKEN)=' → 0`), cwd = a git worktree of this repo (so `CLAUDE.md` auto-discovery is live and the baseline is comparable to §1.5).

**Headline: one negative, one positive, one confirmation.**

| Probe | Question | Answer |
|---|---|---|
| 1 | Can a caller inject a `tool_result` over `--input-format stream-json` and have it answer a `tool_use` the CLI issued? | **No.** The block is silently stripped. |
| 1b | Is the `canUseTool` / permission-prompt-tool `deny` `message` surfaced to the model as the tool result? | **Yes**, verbatim, with `is_error: true`. |
| 2 | Does `--setting-sources` with an empty value close the CLI/SDK harness-context gap? | **Yes — completely.** Both land on **636** tokens. |

### 6.1 Probe 1 — caller-injected `tool_result` is silently stripped

**[FACT-OBS] Result: the escape hatch does not exist.** A `tool_result` block written by the caller into a `--input-format stream-json` user message is **removed before the message reaches the model**. It never answers the pending `tool_use`, never appears in the transcript, and produces no error, warning, or stderr output on any of the six runs below.

#### The rig

A ~30-line dependency-free MCP stdio server (`mcp-server.mjs`) exposing one tool, `secret_number`, in two modes — `respond` (returns `4271`) and `hang` (answers `initialize`/`tools/list`, then deliberately never answers `tools/call`). The `hang` mode is what makes this decisive: with the MCP server refusing to reply, the *only* way the turn can advance is if the CLI honours the caller's injected result.

A driver (`driver.mjs`) spawns the CLI, sends the prompt as a stream-json user message, watches stdout for an assistant `tool_use` block, and 300 ms later writes a caller-authored `tool_result` for that exact `tool_use_id` to the CLI's stdin.

```bash
claude -p \
  --input-format stream-json --output-format stream-json --verbose \
  --model haiku \
  --tools "" --setting-sources "" --strict-mcp-config --mcp-config <probe>.json \
  --allowed-tools mcp__probe__secret_number \
  --permission-mode acceptEdits --disable-slash-commands \
  --system-prompt "You are a terse assistant with one tool. Use it when asked."
```

Injected message (verbatim, as written to the CLI's stdin):

```json
{"type":"user",
 "message":{"role":"user","content":[
   {"type":"tool_result","tool_use_id":"toolu_01MRf9Wd1bemnxPtbpGMvYNM",
    "content":[{"type":"text","text":"INJECTED-9999"}]}]},
 "parent_tool_use_id":null,
 "session_id":"00000000-0000-4000-b000-000000000023"}
```

#### Run C0 — control: MCP responds, nothing injected

**[FACT-OBS]** The rig is sound. `init.tools = ["mcp__probe__secret_number"]`, the MCP server logged `initialize / notifications/initialized / tools/list / tools/call`, and the run returned `"The secret number is: **4271**"` (`num_turns: 2`, `is_error: false`). Confirms #304's §1.4 result, now over a *stream-json stdin* channel rather than a positional prompt.

#### Run C1 — the decisive one: MCP hangs, caller injects

**[FACT-OBS]** The CLI **ignored the injection entirely and kept waiting on the MCP server**, emitting keepalives until the driver killed it at 90 s:

```
assistant: [{"type":"tool_use","id":"toolu_01MRf9Wd1bemnxPtbpGMvYNM", ...}]
### INJECTING  {"type":"user","message":{"role":"user","content":[{"type":"tool_result", ...
### INJECTED_AT 1787634999659
tool_progress {"tool_use_id":"toolu_01MRf9Wd1bemnxPtbpGMvYNM-heartbeat-0", ...}
tool_progress {"tool_use_id":"toolu_01MRf9Wd1bemnxPtbpGMvYNM-heartbeat-1", ...}
### TIMEOUT_KILL {"ms":90000}
### EXIT {"code":null,"signal":"SIGKILL"}
```

MCP server log for the same run — the call was still open when the process died:

```
REQ initialize / REQ notifications/initialized / REQ tools/list / REQ tools/call
CALL {"name":"secret_number", ..., "_meta":{"claudecode/toolUseId":"toolu_01MRf9Wd1bemnxPtbpGMvYNM", ...}}
HANGING - deliberately not responding
```

No `result` message, no error, no stderr. The tool_use stayed unresolved.

#### Run C2 — `parent_tool_use_id` set to the tool-use id

**[FACT-OBS]** Identical outcome to C1: hung to the 45 s timeout, `SIGKILL`, no `result`. Setting `parent_tool_use_id` to the pending `tool_use.id` changes nothing.

#### Run C3 — a plain *text* user message mid-turn

**[FACT-OBS]** Also hung to timeout and was `SIGKILL`ed. A caller-authored message with no `priority` field does **not** interrupt an in-flight tool call at all — it is queued, not delivered.

#### Run C4 — `priority: "now"`: an interrupt, not a result channel

**[FACT-OBS]** This is the one variant that unblocked the turn, and it did so by **cancelling** the tool call and fabricating the CLI's *own* placeholder result — not by using the caller's:

```
### INJECTING {... "content":[{"type":"tool_result", ... "text":"INJECTED-9999"}]} ... "priority":"now"}
USER-EVT: {"type":"user","message":{"role":"user","content":[
  {"tool_use_id":"toolu_01D9NJuZ7favqVaerKBCAQbD","type":"tool_result",
   "content":"(mcp__probe__secret_number completed with no output)"}]}, ...}
RESULT: success "" turns=2
system/init                       ← a SECOND turn begins
assistant: [{"type":"text","text":"The tool was called, but it returned no output.
             I was unable to retrieve a secret number."}]
```

MCP server log confirms the cancellation propagated: a `REQ notifications/cancelled` line appears after `HANGING`.

`INJECTED-9999` occurs exactly **once** in the entire 45 s capture — in the driver's own `### INJECTING` bookkeeping line — and zero times in anything the CLI emitted.

**[FACT-OBS]** So `priority: "now"` is a **turn interrupt**: it cancels the in-flight MCP call, closes the `tool_use` with a CLI-authored `"(<tool> completed with no output)"` string, ends the turn, and starts a fresh one. The caller's `tool_result` payload is discarded in the process.

#### Run C5 — precedence: MCP responds *and* the caller injects

**[FACT-OBS]** The real MCP result wins outright and the injected block vanishes:

```
A_TOOL_USE: toolu_01EChgqdPpk98RaY7ymRayuw
### INJECTING  ... "text":"INJECTED-9999" ...
USER-EVT: [{"tool_use_id":"toolu_01EChgqdPpk98RaY7ymRayuw","type":"tool_result",
            "content":[{"type":"text","text":"4271"}]}]
A_TEXT: 4271
RESULT: success "4271"
A_TEXT: I'm ready for your next question or task.
```

`grep -c 'INJECTED-9999'` over the transcript with the driver's own log line excluded → **0**.

Note the second turn: the injected message *did* trigger an assistant turn, but the model had nothing to respond to — the message arrived empty.

#### Run C6 — `--replay-user-messages`: the CLI does not even echo it

**[FACT-OBS]** With `--replay-user-messages`, the initial prompt came back with `"isReplay": true`. The injected `tool_result` message was **never replayed**. The only user event on the wire was the genuine MCP result (annotated with the CLI's own `tool_use_result` field):

```
USER-EVT: {"type":"user","message":{"role":"user","content":"What is the secret number? ..."},
           ..., "isReplay":true}
A_TOOL_USE: toolu_01SFn2AtVP3PVSr4cBpafRJK
### INJECTING ... "text":"INJECTED-9999" ...
USER-EVT: {"type":"user","message":{"role":"user","content":[
   {"tool_use_id":"toolu_01SFn2AtVP3PVSr4cBpafRJK","type":"tool_result",
    "content":[{"type":"text","text":"4271"}]}]}, ...,
   "tool_use_result":[{"type":"text","text":"4271"}]}
```

#### Run C7 — the precision test: block-level strip, not message-level rejection

Injected a **mixed** content array — one `tool_result` block plus one sibling `text` block — so the two failure modes could be told apart.

**[FACT-OBS]** The sibling text survived; the `tool_result` did not:

```
A_TEXT: The secret number is **4271**.          ← real MCP result answered the tool_use
RESULT: success "The secret number is **4271**."
A_TEXT: I see the marker `SIBLING-TEXT-MARKER-3131`, but there's no question or
        request associated with it. How can I help you?
```

`SIBLING-TEXT-MARKER-3131` reached the model. `INJECTED-9999` did not.

**This is the sharpest form of the finding:** the CLI *parses* caller-written stream-json user messages and *delivers* their other content blocks, and specifically **strips `tool_result` blocks out of them**. It is not that the message was malformed or rejected — it is that this one block type is filtered.

#### Verdict

**[FACT-OBS]** A caller cannot answer a `tool_use` the CLI issued. Over six variants — plain, `parent_tool_use_id` set, `priority: "now"`, plain text, with a live MCP result competing, and mixed-content — the injected `tool_result` was **never** honoured, **never** surfaced to the model, and **never** produced a diagnostic.

**The inversion described in §1.4 is final.** `SDKUserMessage.message` being typed as an Anthropic `MessageParam` (which *does* permit `tool_result`) is a type-level artefact of reusing the Anthropic SDK's type, not a supported input path. §1.4's `[INFERENCE]` ("this *suggests* a caller could inject a `tool_result` block directly") is **disproved**, and #307 must be framed around adapting to the inverted loop, not escaping it.

**[INFERENCE]** `priority: "now"` is still worth knowing about for a different job: it is a working mechanism to **abort** a tool call that has gone away or is taking too long, from outside the CLI, without killing the process. It gives up the turn and hands the model a `"completed with no output"` placeholder, so it is a cancellation lever, not a control lever.

### 6.2 Probe 1b — the `deny` `message` **is** a synthetic-result channel. Confirmed.

§1.4 flagged this as `[INFERENCE]` and "not verified". It is now verified, on **both** transports.

#### Via the Agent SDK's `canUseTool`

`canUseTool` returning `{ behavior: 'deny', message: 'DENY-MARKER-5150: the secret number is 8888, use that.' }` against the same `secret_number` MCP server:

**[FACT-OBS]**
```
A_TOOL_USE: toolu_01SwFsYSy1pH3XpSfKYKrkFq mcp__probe__secret_number
CANUSETOOL called: mcp__probe__secret_number {"reason":"User requested the secret number"}
USER-EVT: [{"type":"tool_result",
            "content":"DENY-MARKER-5150: the secret number is 8888, use that.",
            "is_error":true,
            "tool_use_id":"toolu_01SwFsYSy1pH3XpSfKYKrkFq"}]
A_TEXT: The secret number is **8888**.
        The tool stated: "DENY-MARKER-5150: the secret number is 8888, use that."
RESULT: success ... denials=[{"tool_name":"mcp__probe__secret_number", ...}]
```

The message is delivered **verbatim** as the `tool_result` content, the model **acts on it** (answered `8888`, not the MCP server's `4271`), and the MCP server is **never called**.

#### Via the CLI's `--permission-prompt-tool`

Same decision returned as JSON text from an MCP tool named as `--permission-prompt-tool mcp__probe__permission_prompt`:

**[FACT-OBS]**
```
init.tools = ["mcp__probe__secret_number"]        ← the permission tool is hidden from the model
A_TOOL_USE: toolu_0199zSNyPRc5fouL6hRQR6CW mcp__probe__secret_number
USER-EVT: [{"type":"tool_result",
            "content":"DENY-MARKER-5150: the secret number is 8888, use that.",
            "is_error":true, "tool_use_id":"toolu_0199zSNyPRc5fouL6hRQR6CW"}]
A_TEXT: The secret number is **8888**.
```

MCP server log for that run contains **only** the `permission_prompt` call — `secret_number` was never invoked.

**[FACT-OBS] A booby-trap found along the way.** The first attempt at this probe produced no `canUseTool` invocation at all, because `allowedTools: ['mcp__probe__secret_number']` was also set. The SDK emitted:

```
[CLAUDE_SDK_CAN_USE_TOOL_SHADOWED] Warning: canUseTool will not be invoked for:
mcp__probe__secret_number. Bare allowedTools entries auto-approve the whole tool
before the callback is consulted. To gate every tool call, use a PreToolUse hook;
or remove the bare names from allowedTools so they fall through to canUseTool.
Allow rules from settings files can also shadow the callback but are not visible here.
```

Bare `allowedTools` names — **and allow rules in settings files, which the SDK explicitly says it cannot see** — silently shadow the callback. Any design that treats `canUseTool` as a guaranteed chokepoint must not set bare allow entries.

#### Verdict

**[FACT-OBS]** Confirmed: `deny` + `message` is a working channel for handing the model an arbitrary string in a `tool_result` slot, on both the SDK and the CLI.

**[INFERENCE]** It is a poor primitive to build on, for three reasons, and none of them is fixable from the caller side:

1. The result is stamped `is_error: true`. The model here read past it and used the content, but the channel is semantically an error, and prompt-level behaviour around errors is not a contract.
2. It is fired *before* the tool runs, so it can only substitute a result, never post-process one.
3. It is shadowed by `allowedTools` and by settings-file allow rules, one of which the SDK cannot even observe.

It is a viable escape hatch for a narrow case — intercepting a specific tool and answering it in-process — but it is not a general caller-driven tool loop.

### 6.3 Probe 2 — the harness-context floor: `--setting-sources ""` closes the gap entirely

**[FACT-OBS] The CLI and the SDK have the same floor: 636 tokens.** #304's 16,232-vs-835 gap was a missing flag, not an architectural difference.

#### Method

Each row is one cold `claude -p --output-format stream-json --verbose --model haiku` run in the argus worktree, prompt `Reply with exactly: OK` on stdin. `total` is `input_tokens + cache_creation_input_tokens + cache_read_input_tokens` from the `result` message — the full context billed for the call. (#304 quoted `cache_creation_input_tokens` alone, which under-reports whenever a prefix is already cached; `total` is the honest metric and the two agree on a fully cold call.) `tools` and `slash` are the lengths of `init.tools` and `init.slash_commands`.

| # | Flags added to `-p --model haiku` | total | in | cache_create | cache_read | tools | slash |
|---|---|---|---|---|---|---|---|
| A | *(none)* | 43,678 | 9 | 25,362 | 18,307 | 146 | 135 |
| A1 | `--tools ""` | 50,788 | 9 | 50,779 | 0 | 113 | 135 |
| A2 | `--tools "" --strict-mcp-config` | 21,890 | 9 | 21,881 | 0 | 0 | 135 |
| B | A2 `+ --disable-slash-commands --system-prompt "…"` | **15,303** | 9 | 15,294 | 0 | 0 | 0 |
| C | B `+ --setting-sources ""` | **636** | 636 | 0 | 0 | 0 | 0 |
| D | `--setting-sources ""` only | 25,894 | 9 | 3,090 | 22,795 | 30 | 48 |
| E | `--setting-sources "" --tools "" --strict-mcp-config` | 7,224 | 9 | 603 | 6,612 | 0 | 48 |
| F | C minus `--disable-slash-commands` | **636** | 636 | 0 | 0 | 0 | 48 |
| G | C minus `--strict-mcp-config` | **636** | 636 | 0 | 0 | 0 | 0 |
| H | `--setting-sources "" --system-prompt "…"` | 19,109 | 9 | 19,100 | 0 | 30 | 48 |
| I | C but `--setting-sources user` | 11,547 | 9 | 11,538 | 0 | 0 | 0 |
| J | **`--tools "" --setting-sources "" --system-prompt "…"`** | **636** | 636 | 0 | 0 | 0 | 0 |
| K | `--tools "" --setting-sources ""` (no `--system-prompt`) | 7,224 | 9 | 603 | 6,612 | 0 | 48 |

Row B reproduces #304's 16,232 within noise (15,303 — the system prompt string differs). Row C is the answer to the probe. Row C was re-run and returned **636** again, byte-identical usage.

#### The like-for-like SDK comparison

**[FACT-OBS]** The same request through `@anthropic-ai/claude-agent-sdk@0.3.241` with `{ model:'haiku', settingSources: [], tools: [], strictMcpConfig: true, systemPrompt: 'You are a terse assistant.', cwd: <same worktree> }`:

```
INIT tools= 0 mcp= 0 apiKeySource= none
SDK total= 636 in= 636 cc= 0 cr= 0 result= "OK"
```

**636 — identical to CLI row C/J.** The SDK's `settingSources: []` and the CLI's `--setting-sources ""` are the same lever, and neither transport carries harness overhead the other avoids.

#### What each flag is actually worth

**[FACT-OBS]**, read off the rows:

- **`--setting-sources ""` is the dominant lever.** B → C removes **14,667** tokens. Everything #304 attributed to residual harness context was setting-source discovery (user/project/local settings, `CLAUDE.md` files, memory, agent definitions, MCP config).
- **`--system-prompt` is the second lever and is not optional.** K vs J: with settings suppressed but the built-in agent prompt still in place, the floor is **7,224**, not 636. The built-in Claude Code system prompt is worth ≈6,600 tokens on its own.
- **`--tools ""` is the third and is also not optional.** H (settings suppressed, custom prompt, but built-in tools left on) is **19,109** with `init.tools` = 30. Built-in tool schemas are ~12k tokens.
- **`--strict-mcp-config` becomes redundant** once `--setting-sources ""` is set — G drops it and still gets 636 with `tools: []`, because the empty setting-source list already suppresses discovery of this machine's MCP config. It remains necessary when setting sources are *not* empty (A1 → A2 is worth 28,898 tokens).
- **`--disable-slash-commands` costs nothing either way.** F leaves it off; `init.slash_commands` reports 48 entries but the total is still 636 — advertised slash commands are not billed into the prompt when `--system-prompt` replaces the built-in one.
- **`--setting-sources user`** (row I, 11,547) shows this machine's user-scope settings alone are worth ~10,900 tokens; project+local add the remaining ~3,750 to reach row B.

**[FACT-OBS] `--setting-sources ""` does not break subscription auth.** Row C's `init` reported `apiKeySource: "none"` with no Anthropic key or token in the environment, and the call succeeded. This is the opposite of `--bare` (§1.6), which strips context *and* refuses subscription credentials. `--setting-sources ""` strips the context and keeps them.

**[FACT-OBS]** `rate_limit_event` (§1.2) is still emitted in the stripped configuration — the subscription quota signal survives.

#### Verdict

**[FACT-OBS]** The minimal recipe is three flags:

```bash
claude -p --tools "" --setting-sources "" --system-prompt "<your prompt>"
```

→ **636 tokens**, zero tools, subscription auth intact.

**[INFERENCE]** For the packaging decision this is the useful outcome: **shelling out to the CLI is not materially worse than bundling the SDK** on context cost — they are the same number, because the SDK *is* the CLI. The choice between them now rests entirely on the other axes (process management, `canUseTool` ergonomics, in-process vs stdio MCP, and the version-coupling risk in §5), not on token overhead. §5's caveat "relevant if bundling the SDK proves worse than shelling out" is resolved: on this axis it is a wash.

**[INFERENCE]** Two caveats worth carrying. First, 636 tokens is still a system prompt the caller did not write in full — it is a floor, not zero, and this is still an agent harness with session persistence and agent-loop semantics (§1.5's verdict is unchanged on that point; only its *magnitude* was wrong). Second, `--setting-sources ""` deliberately suppresses user settings, which means anything the app *wants* from settings — permissions, hooks, model defaults — must be passed explicitly on the command line or via `--settings`.

### 6.4 Net effect on the map

**[INFERENCE]**

1. **#307 gets no easier.** The last escape hatch is closed: there is no caller-driven tool loop, at any altitude. Tools must be MCP handlers, and the CLI owns orchestration. The only interception points are `canUseTool`/`--permission-prompt-tool` (pre-call, error-flagged, shadowable) and `priority: "now"` (cancel-only).
2. **The CLI-vs-SDK packaging question loses its token argument.** Both floor at 636. Decide it on process management and dependency shape.
3. **One risk is *reduced*.** The "~16k tokens on every call, forever" cost that §1.5 and §5 carried as a structural property of the harness was a flag omission. The real floor is 636 — cheap enough that the harness overhead is no longer an argument against the approach.
4. **The `--bare` collision (§1.6) is unaffected and remains the top risk.** `--setting-sources ""` gets you `--bare`-like leanness *while keeping subscription auth*, which is genuinely useful — but it does nothing about `--bare` becoming the `-p` default.
