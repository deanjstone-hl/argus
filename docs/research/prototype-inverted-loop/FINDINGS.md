# Prototype: does vault-operator's agent loop survive the inverted Claude tool loop?

Spike for [argus#307](https://github.com/deanjstone/argus/issues/307), part of map [#303](https://github.com/deanjstone/argus/issues/303), blocking [#308](https://github.com/deanjstone/argus/issues/308).

Claim tags: `[FACT-OBS]` observed by running the spike here; `[FACT-DOC]` read from source; `[INFERENCE]` reasoned.

Code: `spike.mjs` (three real vault-operator tools over the live CORTEX vault, read-only) and `spike2.mjs` (quality-gate and thinking probes). SDK `0.3.246`, model `haiku`, run under WSL2 — [#314](https://github.com/deanjstone/argus/issues/314) already proved the Windows spawn separately, and the architectural question is platform-neutral.

## Verdict

**Shape 1 (adapt in place) is mechanically viable. Shape 3 (inversion is fatal) is wrong. But the ticket's framing was too coarse — the honest answer is a fourth shape it did not list.**

Re-expressing the tools works, and works well. What does *not* survive is `AgentLoopEngine` itself — and that is not a casualty of the port, it is a **duplication**. Nearly everything the engine owns, the CLI already does.

**Adopt the tools, the knowledge layer and the UI. Do not adopt the loop.**

## What the spike did

`[FACT-OBS]` Three vault-operator tool definitions — `read_file`, `list_files`, `search_files` — with descriptions and schemas copied verbatim from `src/core/tools/vault/*.ts`, re-expressed as in-process SDK MCP handlers via `createSdkMcpServer` / `tool()`, then driven over the real vault with a task requiring sequential calls plus a deliberate failure.

`[FACT-OBS]` Result — 4 tool calls, 5 turns, correct sequencing, correct error handling:

```
turn shape: thinking(227) → tool_use list_files → tool_use search_files
          → thinking(85)  → tool_use read_file  → tool_use read_file
          → thinking(446) → text(519)

distinct_tool_use_ids: 4      (all stable, all mapped to handler invocations)
handler latencies:    8ms, 0ms, 3ms, 8ms
result: subtype=success, is_error=false, num_turns=5
usage: input 6833, output 611, cache_creation 4702, cache_read 0
```

`[FACT-OBS]` The deliberate failure (`does/not/exist.md`) returned as `{ isError: true }` from the handler, and the model reported it accurately rather than looping or hallucinating a read.

## The four adaptation seams, and how each fared

| vault-operator concept | Maps to | Verdict |
|---|---|---|
| `ToolDefinition.input_schema` (84 tools) | `tool()` + zod shape | `[INFERENCE]` mechanical. Both are JSON Schema object shapes; a codegen pass or a thin adapter covers all 84. |
| `ToolCallbacks.pushToolResult` | MCP `CallToolResult.content` | `[FACT-OBS]` direct. Multimodal `ToolResultContentBlock[]` maps to MCP content blocks. |
| Tool errors as results, not throws | `{ isError: true }` | `[FACT-OBS]` direct, and the model handles it correctly. |
| `AgentLoopEngine.qualityGateFor(toolName)` | `canUseTool` | `[FACT-OBS]` works — see below. |

### The quality gate works, and is auditable

`[FACT-OBS]` `canUseTool` fired for **every** call with the `toolUseID`. Returning `{behavior:'deny', message:'QUALITY-GATE-4242: refused, path is SECRET-marked. Use notes/ok.md instead.'}` delivered that string to the model verbatim, and the model **acted on the redirection** — it read the suggested alternative and reported both outcomes correctly.

`[FACT-OBS]` `result.permission_denials` carries an authoritative record:

```json
{ "tool_name": "mcp__vault__read_file",
  "tool_use_id": "toolu_01WKbahquSJq87wsWGVfKd78",
  "tool_input": { "path": "SECRET/keys.md" } }
```

`[INFERENCE]` This is a usable substitute for a pre-call quality gate. Its limits from [#311](https://github.com/deanjstone/argus/issues/311) still stand: pre-call only, stamped `is_error`, and silently shadowed by bare `allowedTools` entries.

## Correction to [#304](https://github.com/deanjstone/argus/issues/304): thinking is NOT redacted through the SDK

`[FACT-OBS]` #304 recorded "thinking content is delivered redacted — signatures arrive in full, the reasoning text is empty (784-char signature, 0 characters of text)". Through the **SDK message stream** that is not what happens:

```
thinking[0]: chars=230, signature=684,
  "The user wants me to read two files from the vault:\n1. SECRET/keys.md\n2. notes/ok.md..."
thinking[1]: chars=286, signature=760,
  "The results are:\n\n1. **SECRET/keys.md**: The system refused to read this file..."
```

Real reasoning text, with signatures alongside. `[INFERENCE]` #304 probed the CLI's raw stream-json output; the SDK's typed message stream surfaces thinking differently. The redaction finding should be scoped to the CLI stream-json surface, not treated as a property of the platform — and it removes one objection to adapting `prepareThinkingForPassback`.

## What actually dies: `AgentLoopEngine`

`[FACT-DOC]` Reading `src/core/agent/AgentLoopEngine.ts` (550 lines) and its host interface, the engine owns:

| Responsibility | Under the SDK |
|---|---|
| `executeTool(toolUse)` dispatch | **CLI owns it** — handlers are called back into |
| `estimateTokens(history)` | **CLI owns it** |
| `getContextWindow()` | **CLI owns it** |
| `microcompact(history)` | **CLI owns it** |
| `condense(history, maxTailTokens)` | **CLI owns it** |
| `rollingSummary(...)` | **CLI owns it** |
| Tool-result char budgeting (ADR-157 "defence line 1") | **CLI owns it** |
| Cache-aware deferral | **CLI owns it** |
| Pre-compaction memory flush | **CLI owns it** (hooks available) |
| Abort checks | `AbortSignal`; `priority:"now"` cancels in-flight |
| `qualityGateFor` | `canUseTool` |
| Steering drain / mode switching | genuinely app-level, survives |

`[INFERENCE]` This is the crux. The engine is not mostly a tool dispatcher — it is mostly a **context-window manager**, and the CLI is already a context-window manager. Porting it means either running two compaction strategies against each other or deleting the engine. `AgentTask.ts` (2,597 lines) sits on top of the same assumptions.

So the inversion is not fatal to *adoption*; it is fatal to adopting **this specific component**, which is a much narrower claim than shape 3 made.

## The fourth shape

Neither "adapt in place" nor "inversion is fatal". Concretely:

- **Adopt:** the 84 tool implementations, the knowledge layer / semantic index, the memory system (subject to [#309](https://github.com/deanjstone/argus/issues/309)), the Obsidian UI (`src/ui/`), skills/modes/workflows.
- **Discard:** `AgentLoopEngine`, the context-management half of `AgentTask`, the provider abstraction in `src/api/` (12 providers collapse to one SDK call).
- **Rewrite thin:** an SDK-driven session that registers the tools as MCP handlers and wires `canUseTool` to the existing gates.

`[INFERENCE]` That materially changes [#308](https://github.com/deanjstone/argus/issues/308)'s question. "Fork the whole thing" now means forking a codebase whose agent core you intend to delete, while the scope cuts in [#310](https://github.com/deanjstone/argus/issues/310) grow to include `src/api/` and the loop — a much larger deletion than the Bedrock/Office/i18n list it currently carries.

## Cost note

`[FACT-OBS]` 6,833 input + 4,702 cache-creation tokens for a 4-tool-call task with 3 tools registered — against [#311](https://github.com/deanjstone/argus/issues/311)'s 636-token floor for a bare call. `[INFERENCE]` the delta is tool schemas plus conversation, and 84 registered tools would push the per-turn floor substantially higher. Worth measuring before committing to registering the full surface.
