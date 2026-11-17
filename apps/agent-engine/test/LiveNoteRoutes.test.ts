import { describe, it, expect, vi } from 'vitest';
import type { Hono } from 'hono';
import { createLiveNotesRoutes, liveNotesConfigFromEnv } from '../src/server/liveNotes.js';
import type { LiveNoteRefreshExecutor } from '../src/core/LiveNotes.js';

function buildApp(executor: Partial<Record<'tick' | 'refresh', ReturnType<typeof vi.fn>>> | null) {
  return createLiveNotesRoutes(() => (executor ? { executor: executor as unknown as LiveNoteRefreshExecutor } : null));
}

function post(app: Hono, path: string) {
  return app.fetch(new Request(`http://localhost${path}`, { method: 'POST' }));
}

describe('liveNotesConfigFromEnv', () => {
  it('needs the Supabase URL and the service role key', () => {
    expect(liveNotesConfigFromEnv({ SUPABASE_URL: 'https://x.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'k' })).toEqual({
      supabaseUrl: 'https://x.supabase.co',
      supabaseKey: 'k',
    });
    expect(liveNotesConfigFromEnv({ SUPABASE_URL: 'https://x.supabase.co' })).toBeNull();
    expect(liveNotesConfigFromEnv({ SUPABASE_SERVICE_ROLE_KEY: 'k' })).toBeNull();
    expect(liveNotesConfigFromEnv({ SUPABASE_URL: '  ', SUPABASE_SERVICE_ROLE_KEY: 'k' })).toBeNull();
  });
});

describe('POST /task/live-notes/tick', () => {
  it('returns the tick result', async () => {
    const tick = vi.fn(async () => ({ due: 1, results: [{ noteId: 'n1', outcome: 'refreshed' }] }));
    const res = await post(buildApp({ tick }), '/task/live-notes/tick');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ due: 1, results: [{ noteId: 'n1', outcome: 'refreshed' }] });
  });

  it('503s while Supabase is not configured', async () => {
    const res = await post(buildApp(null), '/task/live-notes/tick');
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: string }).error).toMatch(/SUPABASE_SERVICE_ROLE_KEY/);
  });

  it('500s with the message when the tick itself throws', async () => {
    const tick = vi.fn(async () => {
      throw new Error('relation "knowledge_live_notes" does not exist');
    });
    const res = await post(buildApp({ tick }), '/task/live-notes/tick');
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'relation "knowledge_live_notes" does not exist' });
  });
});

describe('POST /task/live-notes/:id/run', () => {
  const ID = '00000000-0000-4000-8000-000000000004';

  it('returns the outcome of a refreshed note', async () => {
    const refresh = vi.fn(async (id: string) => ({ noteId: id, outcome: 'refreshed' }));
    const res = await post(buildApp({ refresh }), `/task/live-notes/${ID}/run`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ noteId: ID, outcome: 'refreshed' });
    expect(refresh).toHaveBeenCalledWith(ID);
  });

  it('answers 200 with the error for a run that failed, since the failure is recorded on the note', async () => {
    const refresh = vi.fn(async (id: string) => ({ noteId: id, outcome: 'failed', error: 'timeout', autoPaused: false }));
    const res = await post(buildApp({ refresh }), `/task/live-notes/${ID}/run`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ noteId: ID, outcome: 'failed', error: 'timeout', autoPaused: false });
  });

  it('404s for an unknown note', async () => {
    const refresh = vi.fn(async (id: string) => ({ noteId: id, outcome: 'not_found' }));
    const res = await post(buildApp({ refresh }), `/task/live-notes/${ID}/run`);
    expect(res.status).toBe(404);
  });

  it('409s when the note is already running', async () => {
    const refresh = vi.fn(async (id: string) => ({ noteId: id, outcome: 'skipped' }));
    const res = await post(buildApp({ refresh }), `/task/live-notes/${ID}/run`);
    expect(res.status).toBe(409);
  });

  it('400s for an id that is not a UUID, without querying', async () => {
    const refresh = vi.fn();
    const res = await post(buildApp({ refresh }), '/task/live-notes/not-a-uuid/run');
    expect(res.status).toBe(400);
    expect(refresh).not.toHaveBeenCalled();
  });

  it('503s while Supabase is not configured', async () => {
    const res = await post(buildApp(null), `/task/live-notes/${ID}/run`);
    expect(res.status).toBe(503);
  });

  it('500s with the message when the store throws', async () => {
    const refresh = vi.fn(async () => {
      throw new Error('db down');
    });
    const res = await post(buildApp({ refresh }), `/task/live-notes/${ID}/run`);
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'db down' });
  });
});
