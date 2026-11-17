# Task 001: Improve ClaudeAdapter/HaikuAdapter streaming (CLI-based, no API billing)

## Status
Superseded — historical record only (pre-2026-07-17 task-file era, see AGENTS.md). The streaming work landed via PR #50 / #198; paths below (`packages/agent-engine`) predate the move to `apps/agent-engine`.

## Revision note

Originally scoped as a migration from CLI-spawn to `@anthropic-ai/sdk`. That
direction is **rejected**: Director has confirmed they do not want a separate
API-billing relationship to manage or budget. Claude Pro/Max (what the
`claude` CLI uses when logged in) and Anthropic API keys are two independent
billing systems with no shared quota — switching to the SDK with an API key
would mean every agent-engine request becomes metered API spend, on top of
the existing subscription. An OAuth profile (`ant auth login`) is not a safe
substitute either — there's no guarantee it gets Claude Code's subscription
billing treatment when called via the raw Messages API rather than through
the `claude` CLI itself. This task is rescoped below to get the streaming
benefit without changing the auth/billing model at all.

## Context

`packages/agent-engine`'s `ClaudeAdapter.ts` and `HaikuAdapter.ts` call the
`claude` CLI via `child_process.spawn('claude', ['--print', prompt])` and
resolve once with the full stdout (ANSI-stripped). This means:

- No real token streaming — `ask()` resolves once at process close, so any
  `onDelta`-style consumer only ever gets one chunk.
- Error signal is just the process exit code, not a structured error.

`@anthropic-ai/sdk` is listed in `package.json` but unused. It will **stay**
unused for the Claude-path adapters — do not import it into `ClaudeAdapter`
or `HaikuAdapter` under this task.

## Scope

- `packages/agent-engine/src/models/ClaudeAdapter.ts`
- `packages/agent-engine/src/models/HaikuAdapter.ts`
- Out of scope: `GeminiAdapter.ts`, `OllamaAdapter.ts`, `ArgusEngine.ts`
  dispatch logic, `ArgusPlanner` tool-execution logic (the JSON-DAG-plan
  tool emulation stays — see Non-Goals).

## Implementation Plan (proposed)

1. Confirm the installed `claude` CLI version actually supports
   `--print --output-format stream-json` (and whatever `--verbose`/schema
   flags it needs) before writing adapter code — check `claude --help` /
   `claude --print --help` on the target host, since output-format support
   and event shape can vary by CLI version.
2. Rewrite `ClaudeAdapter.ask()` to spawn with `--output-format stream-json`,
   parse newline-delimited JSON events from stdout as they arrive, and
   invoke an optional `onDelta` callback per text delta — while still
   resolving the existing `ask(prompt, options): Promise<string>` return
   shape so `ArgusEngine`/`ArgusPlanner` call sites don't change.
3. Same rewrite for `HaikuAdapter.ask()`.
4. Improve error handling: parse the CLI's structured error output (if any)
   from the stream-json events instead of relying solely on exit code, so
   callers get a real error message rather than a generic
   `ClaudeAdapter: exit code N`.
5. `HaikuAdapter.classify()` stays prompt-and-JSON.parse (no structured
   outputs available via CLI) — but tighten the parse failure path so a
   malformed response is logged, not silently defaulted to
   `categories[0]` with zero confidence.
6. Add/update vitest coverage — existing tests likely mock
   `child_process.spawn`'s `close`/`data` events; extend mocks to emit
   multiple `data` chunks representing NDJSON lines instead of one blob.
7. No changes to `deploy.sh`, auth, or credentials — this task must not
   introduce any new environment variable, secret, or billing dependency.

## Non-Goals

- No adoption of `@anthropic-ai/sdk`, Vercel AI SDK, LangChain, or any other
  provider-abstraction/API-billed library for the Claude path.
- No API key, OAuth profile, or any new credential for agent-engine.
- No native tool-calling / replacement of the JSON-DAG-plan emulation in
  `ArgusPlanner` — not achievable via the CLI's fixed built-in toolset, and
  out of scope regardless.
- No changes to `GeminiAdapter` or `OllamaAdapter`.

## Open Questions

1. Does the deployed `claude` CLI version support `--output-format
   stream-json` in `--print` mode, and is the event schema stable enough to
   parse without fragility? Must verify on the actual host before coding.
2. Is CLI-emitted structured error detail (if any) sufficient to replace
   exit-code-only error handling, or is this a smaller win than originally
   scoped?
