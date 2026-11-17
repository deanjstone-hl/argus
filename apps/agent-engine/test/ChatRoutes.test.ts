import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';
import { existsSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Hono } from 'hono';

const engineRun = vi.fn();
const askInSession = vi.fn();

vi.mock('../src/core/ArgusEngine.js', () => ({ engine: { run: engineRun } }));
vi.mock('../src/models/ClaudeAdapter.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/models/ClaudeAdapter.js')>();
  return { ...actual, claudeAdapter: { askInSession } };
});

const SESSION_ID = '00000000-0000-4000-8000-000000000006';

let app: Hono;
let jobsDbPath: string;
let vectorDbPath: string;

beforeAll(async () => {
  jobsDbPath = join(tmpdir(), `chat-routes-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  vectorDbPath = join(tmpdir(), `chat-routes-vectors-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  process.env['ARGUS_JOBS_DB_PATH'] = jobsDbPath;
  process.env['ARGUS_VECTOR_DB_PATH'] = vectorDbPath;

  const mod = await import('../src/server/http.js');
  app = mod.app;
});

afterAll(() => {
  for (const p of [jobsDbPath, vectorDbPath]) {
    if (existsSync(p)) unlinkSync(p);
  }
});

beforeEach(() => {
  vi.clearAllMocks();
});

function postChat(body: unknown) {
  return app.request('/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /chat', () => {
  it('without a sessionId, runs the engine exactly as before and returns only text', async () => {
    engineRun.mockResolvedValueOnce('one-shot answer');
    const res = await postChat({ message: 'hello' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ text: 'one-shot answer' });
    expect(engineRun).toHaveBeenCalledWith('hello');
    expect(askInSession).not.toHaveBeenCalled();
  });

  it('with a sessionId, threads the turn through the Claude session and echoes the id', async () => {
    askInSession.mockResolvedValueOnce('session answer');
    const res = await postChat({ message: 'what did I say?', sessionId: SESSION_ID });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ text: 'session answer', sessionId: SESSION_ID });
    expect(askInSession).toHaveBeenCalledWith('what did I say?', SESSION_ID);
    expect(engineRun).not.toHaveBeenCalled();
  });

  it('rejects a sessionId that is not a UUID', async () => {
    const res = await postChat({ message: 'hi', sessionId: '--dangerously-skip-permissions' });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'sessionId must be a UUID' });
    expect(askInSession).not.toHaveBeenCalled();
  });

  it('rejects a non-string sessionId', async () => {
    const res = await postChat({ message: 'hi', sessionId: 42 });
    expect(res.status).toBe(400);
    expect(askInSession).not.toHaveBeenCalled();
  });

  it('still rejects a missing message', async () => {
    const res = await postChat({ sessionId: SESSION_ID });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'message must be a string' });
  });

  it('returns 500 with the adapter error when a session turn fails', async () => {
    askInSession.mockRejectedValueOnce(new Error('ClaudeAdapter timeout'));
    const res = await postChat({ message: 'hi', sessionId: SESSION_ID });
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'ClaudeAdapter timeout' });
  });
});
