---
title: ARGUS Agent Engine — apps/agent-engine
status: draft
date: 2026-06-14
summary: "Draft 2026-06 architecture of agent-engine: model routing across Claude, Gemini and Ollama"
read_when:
  - "working on agent-engine's architecture or model routing"
---

## Context

ARGUS is a general-purpose Hermes-architecture agent engine that exposes itself as an **A2A/ACP server**, accessible from any compatible client — Obsidian, Zed, IntelliJ, custom scripts, or direct HTTP. It is not an Obsidian-specific bridge.

Internally it routes tasks across three model backends:
- **Claude Code CLI** (primary, Pro subscription) — deep engineering work
- **Gemini CLI** (free tier, native ACP mode) — bulk ingestion, high-context tasks
- **Ollama + nomic-embed-text** (local) — vector embeddings, private data

The engine lives at `apps/agent-engine/` in the argus monorepo.

Environment:
- Ollama installed, `nomic-embed-text:latest` pulled
- Claude CLI and Gemini CLI both on PATH (fnm bin)
- Node 22.22.2

---

## Architecture

```
┌─────────────────────────────────────────────────────┐
│                   ARGUS CLIENTS                      │
│  Obsidian plugin │ Zed │ IntelliJ │ custom scripts   │
└──────────┬───────────────────────┬──────────────────┘
           │ JSON-RPC stdio (ACP)  │ HTTP/REST
           ▼                       ▼
┌──────────────────────────────────────────────────────┐
│              ARGUS TRANSPORT LAYER                    │
│   src/server/stdio.ts      src/server/http.ts        │
└──────────────────────┬───────────────────────────────┘
                       │
                       ▼
┌──────────────────────────────────────────────────────┐
│                  ARGUS CORE ENGINE                    │
│                                                      │
│  ArgusEngine (orchestration loop + model router)     │
│       │                                              │
│       ├──► ArgusPlanner (DAG executor)               │
│       ├──► ArgusRegistry (Zod tool schemas)          │
│       └──► ArgusContext (vault file manager)         │
└──────────────────────┬───────────────────────────────┘
                       │
           ┌───────────┼───────────┐
           ▼           ▼           ▼
   ClaudeAdapter  GeminiAdapter  OllamaAdapter
   (spawn CLI     (spawn gemini  (REST API →
    --print)       --acp mode,    localhost:11434)
                   JSON-RPC)
                       │
                       ▼
               VectorEngine
               (SQLite + cosine)
```

---

## Package Structure

```
apps/agent-engine/
├── package.json           # ESM, vitest, zod, better-sqlite3, axios
├── tsconfig.json          # NodeNext, strict, outDir: dist/
├── src/
│   ├── types.ts           # All shared interfaces
│   ├── core/
│   │   ├── ArgusContext.ts    # Vault file manager (CORTEX read/write)
│   │   ├── ArgusRegistry.ts   # Zod tool registry
│   │   ├── ArgusPlanner.ts    # DAG topological executor
│   │   └── ArgusEngine.ts     # Orchestration loop + model router
│   ├── models/
│   │   ├── ClaudeAdapter.ts   # spawn claude --print; capture stdout
│   │   ├── GeminiAdapter.ts   # spawn gemini --acp; JSON-RPC over stdio
│   │   └── OllamaAdapter.ts   # axios POST to Ollama REST API
│   ├── search/
│   │   └── VectorEngine.ts    # Ollama embeddings → SQLite → cosine search
│   └── server/
│       ├── stdio.ts           # ACP server over stdin/stdout (readline JSON-RPC)
│       ├── http.ts            # HTTP/REST server (Hono — already in monorepo)
│       └── protocol.ts        # Shared JSON-RPC message types + send helpers
└── tests/
    ├── ArgusRegistry.test.ts
    ├── ArgusPlanner.test.ts
    ├── VectorEngine.test.ts
    └── GeminiAdapter.test.ts
```

---

## Implementation Phases

### Phase 1 — Types

**`src/types.ts`**:
- `Message` (role: user/assistant/system/tool, content, name?)
- `AgentStep` (thought, toolCall?, output?)
- `ArgusState` (messages, steps, isComplete, finalAnswer?)
- `DAGTask` (id, toolName, arguments, dependencies, status: pending|running|completed|failed, output?)
- `DAGPlan` (thought, tasks: DAGTask[])
- `TaskNode` (id, taskType: engineering|bulk_ingestion|local_utility, allocatedModel: CLAUDE|GEMINI|OLLAMA, prompt, dependencies)
- `ArgusTool<T extends ZodObject>` (name, description, schema, execute)
- `FileMetadata` (path, lastModified, tags, links)

### Phase 2 — ArgusContext

**`src/core/ArgusContext.ts`**: Vault file manager.
- Constructor: `vaultPath` defaults to `/mnt/c/Users/deanj/Obsidian/CORTEX`
- `initialize()`: recursive scan of `.md` files → `metaRegistry: Map<string, FileMetadata>`
- `getFileContent(fileName)`: `memoryCache` first, then `fs.readFile`
- `updateFile(fileName, content)`: write → update cache + registry → trigger VectorEngine index
- WSL2: no `fs.watch` on `/mnt/c/` — batch-diff scan only

### Phase 3 — ArgusRegistry

**`src/core/ArgusRegistry.ts`**:
- `register<T>(tool: ArgusTool<T>)`: store in `Map<string, ArgusTool>`
- `validate(toolName, rawArgs)`: `schema.safeParse()` → returns formatted error string on failure (not a throw; error fed back into LLM loop)
- `getDefinitions()`: `zodToJsonSchema(schema)` per tool — passed in LLM system prompts
- Pre-registered: `TaskSchema`, `ContextPayloadSchema`

### Phase 4 — ArgusPlanner (DAG)

**`src/core/ArgusPlanner.ts`**:
- `executePlan(nodes: DAGNode[])`: recursive `executeNode()` with `visited` + `completed` sets
- Concurrency: `Promise.all(deps.map(executeNode))` for independent nodes
- Cycle guard: node in `visited` on re-entry → throw
- `resolveArguments(args, allTasks)`: replace `$task_id` markers with completed task outputs

### Phase 5 — Model Adapters

**`src/models/ClaudeAdapter.ts`**:
- `ask(prompt: string, options?: { timeout?: number }): Promise<string>`
- `spawn('claude', ['--print', prompt])` — capture stdout, reject on non-zero exit
- Default timeout: 120s; strip ANSI codes from output

**`src/models/GeminiAdapter.ts`**:
- Uses Gemini CLI's **native ACP mode** (JSON-RPC over stdio) rather than stdout scraping
- `spawn('gemini', ['--acp'])` → bidirectional JSON-RPC channel
- `ask(prompt: string): Promise<string>`: send `chat/message` JSON-RPC request, await response
- Manages a persistent child process (not re-spawned per request)
- Default timeout: 60s

**`src/models/OllamaAdapter.ts`**:
- `generate(prompt: string, model?: string): Promise<string>` — for local utility tasks
- `embed(text: string): Promise<number[]>` — `POST /api/embeddings` with `nomic-embed-text`
- Uses `axios`

**`src/core/ArgusEngine.ts`**:
- `routeTask(taskType): CLAUDE | GEMINI | OLLAMA`
  - `engineering` → CLAUDE
  - `bulk_ingestion` → GEMINI
  - `local_utility` → OLLAMA
- `run(userPrompt, onDelta?: (text: string) => void): Promise<string>`
  - Builds `ArgusState`
  - Calls LLM (Claude) to generate `DAGPlan`
  - Passes plan to `ArgusPlanner.executePlan()`
  - Each DAG node dispatched to the routed adapter
  - `onDelta` callback for streaming updates (used by server transports)

### Phase 6 — VectorEngine

**`src/search/VectorEngine.ts`**:
- `better-sqlite3`: `embeddings(id TEXT, fileName TEXT, chunk TEXT, vector BLOB)`
- `indexFile(fileName, content)`: paragraph-chunk (500 char), embed via `OllamaAdapter.embed()`, upsert
- `search(query, topK = 5)`: embed query → cosine against all rows → top K `SearchResult[]`
- `indexVault(context: ArgusContext)`: bulk scan + index all CORTEX files

### Phase 7 — Transport Layer

**`src/server/protocol.ts`**: Shared JSON-RPC 2.0 types and `send*` helpers.

**`src/server/stdio.ts`** — ACP server (primary transport):
- `readline` on `process.stdin`, write to `process.stdout`
- Methods:
  - `initialize` → `{ status: 'initialized', agent: 'ARGUS-v2', protocol: 'A2A/ACP' }`
  - `chat/message` → `engine.run(text, delta => sendNotification('chat/delta', { text: delta }))` → `sendResponse`
  - `context/read` → `context.getFileContent`
  - `context/write` → validated write via registry
  - `vector/search` → `vectorEngine.search`
- Entry point: `node dist/server/stdio.js` (package `"main"`)

**`src/server/http.ts`** — REST server (secondary transport):
- Uses **Hono** (already used in `mcp-memory`; consistent with monorepo)
- Routes:
  - `POST /chat` → `engine.run(body.message)` → JSON response
  - `GET /vector/search?q=...&k=5` → `vectorEngine.search`
  - `POST /context/read` → `context.getFileContent`
  - `POST /context/write` → `context.updateFile`
- Port: configurable via `ARGUS_PORT` env var (default 3747)
- Entry point: `node dist/server/http.js`

---

## package.json

```json
{
  "name": "@argus/agent-engine",
  "type": "module",
  "version": "0.1.0",
  "main": "dist/server/stdio.js",
  "exports": {
    ".": "./dist/index.js",
    "./stdio": "./dist/server/stdio.js",
    "./http": "./dist/server/http.js"
  },
  "scripts": {
    "build": "tsc",
    "start": "node dist/server/stdio.js",
    "start:http": "node dist/server/http.js",
    "test": "vitest run",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "axios": "^1.x",
    "better-sqlite3": "^9.x",
    "hono": "^4.6.0",
    "zod": "^3.24.0",
    "zod-to-json-schema": "^3.x"
  },
  "devDependencies": {
    "@types/better-sqlite3": "^7.x",
    "@types/node": "^22.x",
    "typescript": "^5.x",
    "vitest": "^2.x"
  }
}
```

`tsconfig.json`: `module: NodeNext`, `moduleResolution: NodeNext`, `target: ES2022`, `strict: true`, `outDir: dist/`, `rootDir: src/` — mirrors `mcp-memory`.

---

## Tests

**`ArgusRegistry.test.ts`**: malformed schema → error string returned; valid data → typed result.

**`ArgusPlanner.test.ts`**: linear chain, parallel fanout, circular dependency detection.

**`VectorEngine.test.ts`**: cosine similarity unit tests; integration test (requires Ollama) for embed().

**`GeminiAdapter.test.ts`**: mock the child process stdin/stdout to verify JSON-RPC message formation.

---

## Verification

1. `npm run typecheck` — zero errors
2. `npm run test` — all unit tests pass
3. **stdio smoke test:**
   ```bash
   echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}' \
     | node dist/server/stdio.js
   # expect: {"jsonrpc":"2.0","result":{"status":"initialized","agent":"ARGUS-v2"},"id":1}
   ```
4. **HTTP smoke test:**
   ```bash
   node dist/server/http.js &
   curl -X POST http://localhost:3747/chat -d '{"message":"hello"}' -H 'Content-Type: application/json'
   ```
5. **ACP client test:** configure Zed or IntelliJ to point at `node dist/server/stdio.js` as an ACP agent; send a chat message.
6. **Vector search:** index a CORTEX file, query a related term, verify top result.

---

## Open Questions for v3

- Gemini ACP mode flag: verify exact CLI flag (`--acp`, `--mode acp`, or similar) against `gemini-cli` docs
- A2A vs ACP: confirm whether `claude-agent-acp` targets A2A spec or original ACP; may inform protocol framing
- HTTP auth: should the REST server require a token for non-localhost callers?
- Obsidian plugin: deferred to a separate plan/session; `stdio.ts` is the interface it will use
