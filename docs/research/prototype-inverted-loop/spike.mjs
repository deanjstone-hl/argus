/**
 * Spike for argus#307 — can vault-operator's agent loop be adapted to the
 * inverted Claude tool loop, or does the inversion force Argus-native?
 *
 * Takes three REAL vault-operator tool definitions (schemas copied verbatim
 * from src/core/tools/vault/*.ts) and re-expresses them as in-process SDK MCP
 * handlers, then drives one multi-turn task over the real CORTEX vault.
 *
 * READ-ONLY. No tool here writes to the vault.
 */
import { query, createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

const VAULT = process.env.VAULT_PATH || '/home/deanj/CORTEX';
const calls = [];           // observation log: every handler invocation
const denials = [];

function rel(p) { return path.resolve(VAULT, p); }
function guard(p) {
  const abs = rel(p);
  if (!abs.startsWith(path.resolve(VAULT))) throw new Error('path escapes vault');
  return abs;
}

// --- vault-operator's real tool surface, re-expressed as MCP handlers ---

const readFile = tool(
  'read_file',
  'Read the complete content of a file from the vault. Use this to view notes, check existing content before editing, or gather information. Very large files are chunk-sized to the model context window; if the result is truncated it names the offset to continue with.',
  { path: z.string().describe('Path to the file relative to vault root (e.g., "folder/note.md")'),
    offset: z.number().int().optional().describe('Character offset to start reading from (default 0).') },
  async (args) => {
    const t0 = Date.now();
    try {
      const buf = await fs.readFile(guard(args.path), 'utf8');
      const off = args.offset ?? 0;
      const chunk = buf.slice(off, off + 4000);
      calls.push({ tool: 'read_file', args, ok: true, ms: Date.now() - t0, bytes: chunk.length });
      return { content: [{ type: 'text', text: chunk || '(empty)' }] };
    } catch (e) {
      calls.push({ tool: 'read_file', args, ok: false, ms: Date.now() - t0, err: e.message });
      // vault-operator returns tool errors as results, not throws
      return { content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true };
    }
  },
);

const listFiles = tool(
  'list_files',
  'List files and folders in a vault directory.',
  { path: z.string().describe('Directory path relative to vault root. Use "" or "/" for the vault root.') },
  async (args) => {
    const t0 = Date.now();
    try {
      const dir = guard(args.path || '.');
      const ents = await fs.readdir(dir, { withFileTypes: true });
      const out = ents.filter(e => !e.name.startsWith('.'))
        .map(e => (e.isDirectory() ? `${e.name}/` : e.name)).join('\n');
      calls.push({ tool: 'list_files', args, ok: true, ms: Date.now() - t0, n: ents.length });
      return { content: [{ type: 'text', text: out || '(empty)' }] };
    } catch (e) {
      calls.push({ tool: 'list_files', args, ok: false, ms: Date.now() - t0, err: e.message });
      return { content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true };
    }
  },
);

const searchFiles = tool(
  'search_files',
  'Search the vault for files whose name matches a substring. Returns matching paths.',
  { query: z.string().describe('Substring to match against file names.') },
  async (args) => {
    const t0 = Date.now();
    const hits = [];
    async function walk(d, depth) {
      if (depth > 3) return;
      let ents = [];
      try { ents = await fs.readdir(d, { withFileTypes: true }); } catch { return; }
      for (const e of ents) {
        if (e.name.startsWith('.') || e.name === 'node_modules') continue;
        const full = path.join(d, e.name);
        if (e.isDirectory()) await walk(full, depth + 1);
        else if (e.name.toLowerCase().includes(args.query.toLowerCase()))
          hits.push(path.relative(VAULT, full));
        if (hits.length > 40) return;
      }
    }
    await walk(path.resolve(VAULT), 0);
    calls.push({ tool: 'search_files', args, ok: true, ms: Date.now() - t0, hits: hits.length });
    return { content: [{ type: 'text', text: hits.length ? hits.join('\n') : '(no matches)' }] };
  },
);

const server = createSdkMcpServer({ name: 'vault', version: '0.0.1', tools: [readFile, listFiles, searchFiles] });

// --- the run ---

const t0 = Date.now();
let init = null, result = null;
const toolUseIds = new Set();
const turns = [];

for await (const m of query({
  prompt: 'Using only the vault tools: list the vault root, then find a file whose name contains "HOME", then read it and tell me in one sentence what it is for. Finally, try to read "does/not/exist.md" and report what happened.',
  options: {
    model: 'haiku',
    settingSources: [],
    tools: [],
    mcpServers: { vault: server },
    systemPrompt: 'You operate on an Obsidian vault through the provided tools. Be terse.',
    maxTurns: 12,
    canUseTool: async (toolName, input, { toolUseID }) => {
      // stand-in for AgentLoopEngine.qualityGateFor(): a pre-call gate
      if (toolName === 'mcp__vault__read_file' && String(input.path).includes('SECRET')) {
        denials.push({ toolName, input });
        return { behavior: 'deny', message: 'Quality gate: refused to read a SECRET-marked path.' };
      }
      return { behavior: 'allow', updatedInput: input };
    },
  },
})) {
  if (m.type === 'system' && m.apiKeySource !== undefined) init = m;
  if (m.type === 'assistant') {
    for (const b of m.message?.content ?? []) {
      if (b.type === 'tool_use') { toolUseIds.add(b.id); turns.push({ kind: 'tool_use', id: b.id, name: b.name }); }
      if (b.type === 'text' && b.text.trim()) turns.push({ kind: 'text', chars: b.text.length });
      if (b.type === 'thinking') turns.push({ kind: 'thinking', chars: (b.thinking || '').length });
    }
  }
  if (m.type === 'result') result = m;
}
const elapsed = Date.now() - t0;

console.log(JSON.stringify({
  elapsed_ms: elapsed,
  init: init && { apiKeySource: init.apiKeySource, model: init.model, tools: init.tools, mcp_servers: init.mcp_servers },
  handler_calls: calls,
  distinct_tool_use_ids: toolUseIds.size,
  turn_shape: turns,
  denials,
  result: result && { subtype: result.subtype, is_error: result.is_error, num_turns: result.num_turns,
                      usage: result.usage && { input: result.usage.input_tokens, output: result.usage.output_tokens,
                                               cache_read: result.usage.cache_read_input_tokens,
                                               cache_creation: result.usage.cache_creation_input_tokens },
                      text: result.result },
}, null, 2));
