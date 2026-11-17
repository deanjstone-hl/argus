import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Hono } from 'hono';
import { createClient } from '@supabase/supabase-js';
import { engine } from '../core/ArgusEngine.js';
import { claudeAdapter } from '../models/ClaudeAdapter.js';
import { argusContext } from '../core/ArgusContext.js';
import { VectorEngine } from '../search/VectorEngine.js';
import { createPlanStore, type PlanStore } from '../core/PlanStore.js';
import { createPlansRoutes, plansConfigFromEnv } from './plans.js';
import { createLiveNotesRoutes, liveNotesConfigFromEnv } from './liveNotes.js';
import { LiveNoteRefreshExecutor } from '../core/LiveNotes.js';
import { createSupabaseGraphReader, createSupabaseLiveNoteStore } from '../core/LiveNoteStore.js';
import { createTransformersEmbedder } from '../models/TransformersEmbedder.js';
import { browserAccessConfigFromEnv, createBrowserAccess } from './browserAccess.js';
import { createIdentityRoutes, loadIdentity } from './identity.js';
import type {
  DAGPlan,
  FeedbackLoopTask,
  TaskType,
} from '../types.js';

const app = new Hono();

// Browser access (#543): read per request, like the plans config, so env
// changes need no restart-order coordination. Registered before the routes,
// because Hono runs middleware in registration order.
const browserAccess = createBrowserAccess(() => browserAccessConfigFromEnv(process.env));
app.use('/health', browserAccess.cors);
app.use('/task/run-plan', browserAccess.cors, browserAccess.requireOwner);
app.use('/task/live-notes/*', browserAccess.cors, browserAccess.requireOwner);
const PORT = parseInt(process.env['ARGUS_PORT'] ?? '3747', 10);
const VAULT_ROOT = resolve(process.env['ARGUS_VAULT_ROOT'] ?? '/mnt/c/Users/deanj/Obsidian/CORTEX');

function resolveVaultPath(fileName: string): string {
  const resolved = resolve(VAULT_ROOT, fileName);
  if (!resolved.startsWith(VAULT_ROOT + '/') && resolved !== VAULT_ROOT) {
    throw new Error('Path traversal denied');
  }
  return resolved;
}

// The deployment identity (argus#706), read once at startup: restart the
// engine after editing identity.json.
const identity = loadIdentity({ env: process.env });
if (identity.error) console.error(`agent-engine identity: ${identity.error}`);
app.route('/', createIdentityRoutes(identity));

const vectorEngine = new VectorEngine(process.env['ARGUS_VECTOR_DB_PATH'] ?? './argus-vectors.db');
// The CLI requires a UUID for --session-id; checking it here also keeps a
// caller-supplied value from being read as a flag.
const SESSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Built on first use and rebuilt only if the Supabase config changes, so the
// route reads its config per request without a client per request.
let planStore: { cacheKey: string; store: PlanStore } | null = null;

app.route('/', createPlansRoutes(() => {
  const config = plansConfigFromEnv(process.env);
  if (!config) return null;
  const cacheKey = [config.supabaseUrl, config.supabaseKey, config.ownerUserId].join('\n');
  if (planStore?.cacheKey !== cacheKey) {
    const client = createClient(config.supabaseUrl, config.supabaseKey, { auth: { persistSession: false } });
    planStore = { cacheKey, store: createPlanStore(client, { ownerUserId: config.ownerUserId }) };
  }
  return { store: planStore.store, token: config.token, baseUrl: config.baseUrl };
}));

// Live notes (myargus map #121): built on first use and rebuilt only if the
// Supabase config changes, like the plan store above. One executor per config,
// so its in-flight guard covers the tick and every run on demand.
let liveNotes: { cacheKey: string; executor: LiveNoteRefreshExecutor } | null = null;
// One embedder for the process: it loads the model on the first refresh and
// keeps it, whatever happens to the Supabase config.
const liveNotesEmbedder = createTransformersEmbedder();

app.route('/', createLiveNotesRoutes(() => {
  const config = liveNotesConfigFromEnv(process.env);
  if (!config) return null;
  const cacheKey = [config.supabaseUrl, config.supabaseKey].join('\n');
  if (liveNotes?.cacheKey !== cacheKey) {
    const client = createClient(config.supabaseUrl, config.supabaseKey, { auth: { persistSession: false } });
    liveNotes = {
      cacheKey,
      executor: new LiveNoteRefreshExecutor({
        store: createSupabaseLiveNoteStore(client),
        graph: createSupabaseGraphReader(client, { embedder: liveNotesEmbedder }),
        ask: (prompt) => engine.runDirect('live_note_refresh', prompt),
      }),
    };
  }
  return { executor: liveNotes.executor };
}));

app.post('/chat', async (c) => {
  try {
    const body = await c.req.json() as Record<string, unknown>;
    const message = body['message'];

    const sessionId = body['sessionId'];

    if (typeof message !== 'string') {
      return c.json({ error: 'message must be a string' }, 400);
    }

    if (sessionId === undefined) {
      const result = await engine.run(message);
      return c.json({ text: result });
    }

    if (typeof sessionId !== 'string' || !SESSION_ID_PATTERN.test(sessionId)) {
      return c.json({ error: 'sessionId must be a UUID' }, 400);
    }

    const text = await claudeAdapter.askInSession(message, sessionId);
    return c.json({ text, sessionId });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return c.json({ error: message }, 500);
  }
});

app.post('/task/feedback', async (c) => {
  try {
    const body = await c.req.json() as Record<string, unknown>;
    const prompt = body['prompt'];
    const validatorTool = body['validatorTool'];
    const maxRounds = typeof body['maxRounds'] === 'number' ? body['maxRounds'] : 5;
    const successThreshold = typeof body['successThreshold'] === 'number' ? body['successThreshold'] : 1.0;
    const taskType: TaskType = (body['taskType'] as TaskType) ?? 'engineering';

    if (typeof prompt !== 'string') {
      return c.json({ error: 'prompt must be a string' }, 400);
    }

    if (typeof validatorTool !== 'string') {
      return c.json({ error: 'validatorTool must be a string' }, 400);
    }

    const task: FeedbackLoopTask = {
      id: 'feedback_' + Date.now(),
      toolName: 'feedback_loop',
      taskType,
      arguments: {},
      dependencies: [],
      status: 'pending',
      validator: { toolName: validatorTool, successThreshold },
      maxRounds,
      initialPrompt: prompt,
    };

    const result = await engine.runWithFeedback(task);
    return c.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return c.json({ error: message }, 500);
  }
});

app.post('/task/run-plan', async (c) => {
  try {
    const body = await c.req.json() as Record<string, unknown>;
    const plan = body['plan'] as DAGPlan | undefined;

    if (!plan || !Array.isArray(plan.tasks)) {
      return c.json({ error: 'plan.tasks must be an array' }, 400);
    }

    const result = await engine.runPlan(plan);
    return c.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return c.json({ error: message }, 500);
  }
});

app.get('/vector/search', async (c) => {
  const q = c.req.query('q') ?? '';
  const k = parseInt(c.req.query('k') ?? '5', 10);

  if (!q) {
    return c.json({ error: 'q parameter required' }, 400);
  }

  try {
    const results = await vectorEngine.search(q, k);
    return c.json({ results });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return c.json({ error: message }, 500);
  }
});

app.post('/context/read', async (c) => {
  try {
    const body = await c.req.json() as Record<string, unknown>;
    const fileName = body['fileName'];

    if (typeof fileName !== 'string') {
      return c.json({ error: 'fileName must be a string' }, 400);
    }

    resolveVaultPath(fileName);  // path-traversal guard only
    const content = await argusContext.getFileContent(fileName);
    return c.json({ content });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return c.json({ error: message }, 500);
  }
});

app.post('/context/write', async (c) => {
  try {
    const body = await c.req.json() as Record<string, unknown>;
    const fileName = body['fileName'];
    const content = body['content'];

    if (typeof fileName !== 'string') {
      return c.json({ error: 'fileName must be a string' }, 400);
    }

    if (typeof content !== 'string') {
      return c.json({ error: 'content must be a string' }, 400);
    }

    resolveVaultPath(fileName);  // path-traversal guard only
    await argusContext.updateFile(fileName, content);
    return c.json({ ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return c.json({ error: message }, 500);
  }
});

app.get('/health', (c) => c.json({ ok: true, agent: 'ARGUS-v2', deployment: identity.identity?.name ?? null }));

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost:${PORT}`);
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (typeof v === 'string') headers[k] = v;
  }

  let body: string | undefined;
  if (req.method !== 'GET') {
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(chunk as Buffer);
    }
    body = Buffer.concat(chunks).toString();
  }

  const honoReq = new Request(url.toString(), {
    method: req.method ?? 'GET',
    headers,
    body: body ?? null,
  });

  const honoRes = await app.fetch(honoReq);
  res.writeHead(honoRes.status, Object.fromEntries(honoRes.headers.entries()));
  const responseText = await honoRes.text();
  res.end(responseText);
});

const isMainModule = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMainModule) {
  server.listen(PORT, () => {
    console.log(`ARGUS HTTP server listening on port ${PORT}`);
  });
}

export { app };
