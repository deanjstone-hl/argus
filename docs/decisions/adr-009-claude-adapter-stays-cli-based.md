---
title: ADR-009 — Claude Adapters Stay CLI-Based; Reject Vercel AI SDK and Direct API Migration
status: accepted
date: 2026-07-10
summary: "ADR-009: agent-engine's Claude adapters stay CLI-based; no Vercel AI SDK or direct API"
read_when:
  - changing how agent-engine calls Claude or other models
---

# ADR-009: Claude Adapters Stay CLI-Based; Reject Vercel AI SDK and Direct API Migration

## Context

`packages/agent-engine` was evaluated for adopting the Vercel AI SDK
(github.com/vercel/ai) as a unifying LLM abstraction. The evaluation found:

- agent-engine already has its own multi-provider adapter layer
  (`ClaudeAdapter`, `GeminiAdapter`, `OllamaAdapter`, dispatched via
  `ArgusEngine.dispatchToModel()`).
- `ClaudeAdapter` and `HaikuAdapter` do not call the Anthropic API directly —
  they spawn the `claude` CLI binary (`child_process.spawn('claude',
  ['--print', prompt])`) and scrape stdout. `GeminiAdapter` similarly speaks
  JSON-RPC to `gemini --acp` rather than calling Google's API directly.
  `@anthropic-ai/sdk` is a declared but unused dependency.
- This CLI-spawn approach has a real consequence: it runs under the `claude`
  CLI's own logged-in session, billed against the Director's Claude Pro/Max
  subscription. Anthropic API keys are billed on a **separate, independent
  metered system** with no shared quota — switching `ClaudeAdapter` to
  `@anthropic-ai/sdk` with an API key would turn every agent-engine request
  into new recurring API spend on top of the existing subscription. An
  OAuth profile (`ant auth login`) was also considered as an alternative
  credential, but there is no guarantee it receives Claude Code's
  subscription billing treatment when the raw Messages API is called
  directly rather than through the `claude` CLI itself — the same risk,
  not a safe substitute.
- Director confirmed: no separate API-billing relationship is wanted, to
  manage or budget.

A follow-up task (`task-001`) was drafted to swap `ClaudeAdapter`/
`HaikuAdapter` to `@anthropic-ai/sdk` for real token streaming, typed errors,
and a path to native tool-calling. That task is superseded by this decision.

## Decision

1. **Reject Vercel AI SDK adoption.** agent-engine's existing adapter/dispatch
   layer already covers the multi-provider abstraction need; introducing a
   second unifying abstraction on top of one that already exists is
   net-negative, especially since two of three providers are deliberately
   CLI/protocol-based rather than API-based.
2. **Reject migrating `ClaudeAdapter`/`HaikuAdapter` to `@anthropic-ai/sdk`
   with an API key (or any other credential) for Claude Code's model
   access.** The CLI-spawn approach stays, specifically to keep billing
   under the existing Claude Pro/Max subscription with no separate metered
   API relationship.
3. Where streaming and error-handling improvements are still wanted,
   pursue them **within** the CLI-based approach — e.g. `claude --print
   --output-format stream-json` for real incremental output, and parsing
   the CLI's structured output for errors instead of exit-code-only
   handling. See `task-001-claude-cli-streaming.md`.
4. Native tool-calling (replacing the JSON-DAG-plan emulation in
   `ArgusPlanner`) is not pursued under this decision — the `claude` CLI's
   built-in toolset has no hook for agent-engine's own custom tool
   definitions, so this limitation is accepted rather than worked around.

## Consequences

- `@anthropic-ai/sdk` remains an unused dependency in `agent-engine`'s
  `package.json` for the foreseeable future. It should not be removed
  casually (may still be useful if this decision is revisited), but no new
  code should import it for the Claude-path adapters.
- No new environment variables, secrets, or credentials are introduced for
  Claude/Haiku model access.
- Streaming and error-handling work on `ClaudeAdapter`/`HaikuAdapter`
  continues under `task-001`, scoped to CLI output parsing only.
- If Director's cost tolerance changes in the future (i.e., a separate API
  budget becomes acceptable), this ADR should be revisited rather than
  silently overridden — reopen a new ADR rather than reintroducing the SDK
  migration without one.
