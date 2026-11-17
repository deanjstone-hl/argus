---
title: ARGUS Agent Engine — Sub-Agent Implementation Plan
status: draft
date: 2026-06-14
approved: false
tags: [plan, agent-engine, sub-agents, haiku]
summary: Draft 2026-06 plan for building agent-engine with Haiku sub-agents in waves
read_when:
  - tracing how agent-engine was first built
---

## Context

`agent-engine-plan.md` defines the architecture. This plan defines **how to implement
it** using Haiku sub-agents to conserve Sonnet quota. Haiku handles all file writes
(Read/Write/Edit only); the main Argus session handles Bash (mkdir, npm, tsc).

Implementation is split into dependency-ordered waves. Waves with no inter-dependencies
run in parallel.

---

## Constraint

Haiku sub-agents stall on Bash permissions — use Write tool only, never Bash. The
main session must create directories and run all shell commands before and after the
agent waves.

---

## Dependency Graph

```
[main] scaffold dirs, package.json, tsconfig.json
        │
        ▼
[Wave 1] types.ts  ←── all others depend on this
        │
        ├──────────────────────────────────────────┐
        ▼                                          ▼
[Wave 2 — parallel]                          protocol.ts (no deps)
  ArgusRegistry.ts
  HaikuAdapter.ts
  ClaudeAdapter.ts
  GeminiAdapter.ts
  OllamaAdapter.ts
        │
        ▼
[Wave 3] ArgusPlanner.ts  ←── needs HaikuAdapter
        │
        ▼
[Wave 4] ArgusEngine.ts  ←── needs all adapters + planner + registry
        │
        ├──────────────────┐
        ▼                  ▼
[Wave 5 — parallel]
  stdio.ts            http.ts
        │
        ▼
[Wave 6 — parallel]
  ArgusRegistry.test.ts
  ArgusPlanner.test.ts
  HaikuAdapter.test.ts
        │
        ▼
[main] npm install → typecheck → test → fix
```

---

## Branch

Branch `feature/agent-engine` off `main`. All work committed there; PR to `main`
when all waves pass typecheck and tests.

Switch before starting:
```bash
git -C ~/argus checkout feature/agent-engine
```

## Pre-flight (main session — Bash)

```bash
mkdir -p packages/agent-engine/src/{core,models,server}
mkdir -p packages/agent-engine/tests
```

Then dispatch Wave 0 Haiku agents (foreground, sequential — both needed before Wave 1):

**Agent 0a — package.json**
Write `packages/agent-engine/package.json` per the spec in `agent-engine-plan.md §
package.json`. Use Write tool.

**Agent 0b — tsconfig.json**
Mirror `packages/mcp-memory/tsconfig.json` exactly. Write to
`packages/agent-engine/tsconfig.json`. Use Write tool.

---

## Wave 1 — types.ts (foreground, 1 agent)

Must complete before Wave 2 starts.

**Agent:** Haiku  
**File:** `packages/agent-engine/src/types.ts`  
**Spec section:** `agent-engine-plan.md § Phase 1 — Types`  
**Prompt includes:**
- Full list of interfaces and type aliases from Phase 1
- Note: NodeNext ESM — no `.js` extensions needed in type files (types only, no imports)
- Write tool only

---

## Wave 2 — Adapters + Registry (background, 6 parallel agents)

All agents start simultaneously after Wave 1 completes. All import from `../types.js`
(NodeNext ESM `.js` extension required in imports).

| Agent | File | Spec section |
|-------|------|--------------|
| 2a | `src/core/ArgusRegistry.ts` | Phase 3 — ArgusRegistry |
| 2b | `src/models/HaikuAdapter.ts` | Phase 2 — HaikuAdapter (incl. code snippet) |
| 2c | `src/models/ClaudeAdapter.ts` | Phase 5 — ClaudeAdapter |
| 2d | `src/models/GeminiAdapter.ts` | Phase 5 — GeminiAdapter |
| 2e | `src/models/OllamaAdapter.ts` | Phase 4 — OllamaAdapter (embed-only) |
| 2f | `src/server/protocol.ts` | Phase 7 — protocol.ts |

**Prompt pattern for each agent:**
```
You are implementing one file in a TypeScript ESM package (NodeNext module resolution).
Write [filename] to [absolute path] using the Write tool only — no Bash, no mkdir.

Context — types.ts contents:
<paste full types.ts content>

Spec for this file:
<paste relevant section from agent-engine-plan.md>

Rules:
- All relative imports must end in .js (NodeNext ESM)
- No commented-out code
- No docstrings
- strict TypeScript — no `any` unless the spec requires it
```

---

## Wave 3 — ArgusPlanner (foreground, 1 agent)

Depends on Wave 2 (needs HaikuAdapter). Start after all Wave 2 agents complete.

**Agent:** Haiku  
**File:** `packages/agent-engine/src/core/ArgusPlanner.ts`  
**Spec section:** `agent-engine-plan.md § Phase 4 — ArgusPlanner (DAG)`  
**Prompt includes:** types.ts + HaikuAdapter.ts contents for reference

---

## Wave 4 — ArgusEngine (foreground, 1 agent)

Depends on Wave 3.

**Agent:** Haiku  
**File:** `packages/agent-engine/src/core/ArgusEngine.ts`  
**Spec section:** `agent-engine-plan.md § Phase 5 — ArgusEngine`  
**Prompt includes:** types.ts + all adapter files + ArgusRegistry.ts + ArgusPlanner.ts contents  
**Key detail:** Include the full routing table and `run()` pseudocode from the spec

---

## Wave 5 — Transport (background, 2 parallel agents)

Depends on Wave 4. `protocol.ts` is already written (Wave 2f).

| Agent | File | Spec section |
|-------|------|--------------|
| 5a | `src/server/stdio.ts` | Phase 7 — stdio.ts |
| 5b | `src/server/http.ts` | Phase 7 — http.ts |

Both agents receive: types.ts + ArgusEngine.ts + protocol.ts contents.

---

## Wave 6 — Tests (background, 3 parallel agents)

Depends on Wave 5 (all source files exist).

| Agent | File | What to verify |
|-------|------|----------------|
| 6a | `tests/ArgusRegistry.test.ts` | malformed schema → error string; valid → typed result |
| 6b | `tests/ArgusPlanner.test.ts` | linear chain, parallel fanout, cycle detection, arg interpolation |
| 6c | `tests/HaikuAdapter.test.ts` | mock `@anthropic-ai/sdk`; classify() returns ClassifyResult; error propagation |

All agents use `vitest`. Mock `@anthropic-ai/sdk` with `vi.mock()`.

---

## Post-build (main session — Bash)

```bash
cd packages/agent-engine
npm install
npm run typecheck      # fix any errors before testing
npm run test
```

Type errors from NodeNext ESM (missing `.js`, wrong relative paths) are the most
likely failure mode — fix inline in this session rather than re-spawning agents.

---

## Token Budget Estimate

| Step | Model | Est. cost |
|------|-------|-----------|
| Wave 0–1 (3 agents) | Haiku | ~0.3× Sonnet |
| Wave 2 (6 parallel agents) | Haiku | ~0.6× Sonnet |
| Wave 3–4 (2 agents) | Haiku | ~0.2× Sonnet |
| Wave 5–6 (5 agents) | Haiku | ~0.5× Sonnet |
| Typecheck fixes | Sonnet (main) | varies |
| **Total agent work** | **Haiku** | **~1.6× Sonnet equivalent** |

vs. implementing all 14 files inline in this session: ~8–10× Sonnet.

---

## Execution Notes

- Run Wave 2 and Wave 5–6 with `run_in_background: true` — notify via SubagentStop hook
- After each foreground wave, verify the output file exists and has plausible content
  before advancing (quick Read check, not a full review)
- If a Haiku agent produces an obviously wrong file, re-run that single agent with a
  corrected prompt — don't re-run the whole wave
- Paste the relevant spec section verbatim into each agent prompt; don't summarise it
