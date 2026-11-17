import { describe, it, expect } from 'vitest';
import { fakeSupabase } from './helpers/fakeSupabase.js';
import { createLiveNotesRoutes } from '../src/server/liveNotes.js';
import { LiveNoteRefreshExecutor } from '../src/core/LiveNotes.js';
import { createSupabaseGraphReader, createSupabaseLiveNoteStore } from '../src/core/LiveNoteStore.js';

const NOTE_ID = '00000000-0000-4000-8000-000000000004';
const USER = 'user-1';

function database() {
  return fakeSupabase({
    knowledge_live_notes: [
      {
        id: NOTE_ID,
        user_id: USER,
        title: 'Auth',
        objective: 'Track passkey decisions',
        body: '',
        interval_minutes: 60,
        last_run_at: null,
        is_active: true,
        consecutive_failures: 0,
        last_error: null,
        last_error_at: null,
        pause_reason: null,
      },
    ],
    knowledge_chats: [
      { id: 'c1', user_id: USER, title: 'Passkey rollout', date: '2026-10-01', source: 'claude', summary: 'Chose WebAuthn.', tags: [] },
      { id: 'other', user_id: 'someone-else', title: 'Passkey secrets', date: '2026-10-02', source: 'claude', summary: 'Not yours.', tags: [] },
    ],
    knowledge_graph_edges: [],
  });
}

function build(db: ReturnType<typeof database>, ask: (prompt: string) => Promise<string>, clock: { now: Date }) {
  const executor = new LiveNoteRefreshExecutor({
    store: createSupabaseLiveNoteStore(db.client),
    graph: createSupabaseGraphReader(db.client),
    ask,
    now: () => clock.now,
  });
  return createLiveNotesRoutes(() => ({ executor }));
}

const post = (app: ReturnType<typeof build>, path: string) =>
  app.fetch(new Request(`http://localhost${path}`, { method: 'POST' }));

describe('live notes end to end', () => {
  it('a tick refreshes a due note from the owner\'s graph only, then leaves it alone until the interval passes', async () => {
    const db = database();
    const clock = { now: new Date('2026-10-22T10:00:00.000Z') };
    const prompts: string[] = [];
    const app = build(db, async prompt => (prompts.push(prompt), '## Passkeys\n- WebAuthn chosen'), clock);

    const first = await post(app, '/task/live-notes/tick');
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ due: 1, results: [{ noteId: NOTE_ID, outcome: 'refreshed' }] });

    const row = db.tables['knowledge_live_notes']![0]!;
    expect(row).toMatchObject({
      body: '## Passkeys\n- WebAuthn chosen',
      last_run_at: '2026-10-22T10:00:00.000Z',
      consecutive_failures: 0,
      last_error: null,
    });
    expect(prompts[0]).toContain('Passkey rollout');
    expect(prompts[0]).not.toContain('Not yours.');

    clock.now = new Date('2026-10-22T10:30:00.000Z');
    expect(await (await post(app, '/task/live-notes/tick')).json()).toEqual({ due: 0, results: [] });

    clock.now = new Date('2026-10-22T11:00:00.000Z');
    expect(((await (await post(app, '/task/live-notes/tick')).json()) as { due: number }).due).toBe(1);
  });

  it('auto-pauses after three failed ticks on cadence, then stops running it', async () => {
    const db = database();
    const clock = { now: new Date('2026-10-22T10:00:00.000Z') };
    const ask = async () => {
      throw new Error('ClaudeAdapter timeout');
    };
    const app = build(db, ask, clock);
    const row = db.tables['knowledge_live_notes']![0]!;

    await post(app, '/task/live-notes/tick');
    expect(row).toMatchObject({ consecutive_failures: 1, is_active: true, last_error: 'ClaudeAdapter timeout' });

    clock.now = new Date('2026-10-22T10:10:00.000Z');
    expect(((await (await post(app, '/task/live-notes/tick')).json()) as { due: number }).due).toBe(0);

    clock.now = new Date('2026-10-22T11:00:00.000Z');
    await post(app, '/task/live-notes/tick');
    expect(row).toMatchObject({ consecutive_failures: 2, is_active: true });

    clock.now = new Date('2026-10-22T12:00:00.000Z');
    await post(app, '/task/live-notes/tick');
    expect(row).toMatchObject({ consecutive_failures: 3, is_active: false, pause_reason: 'auto-failure' });

    clock.now = new Date('2026-10-23T12:00:00.000Z');
    expect(await (await post(app, '/task/live-notes/tick')).json()).toEqual({ due: 0, results: [] });
  });

  it('runs one note on demand by id, due or not, and reports a failure on the note', async () => {
    const db = database();
    const clock = { now: new Date('2026-10-22T10:00:00.000Z') };
    let fail = false;
    const app = build(db, async () => {
      if (fail) throw new Error('rate limited');
      return 'on demand body';
    }, clock);
    const row = db.tables['knowledge_live_notes']![0]!;

    row['last_run_at'] = '2026-10-22T09:59:00.000Z';
    const ok = await post(app, `/task/live-notes/${NOTE_ID}/run`);
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ noteId: NOTE_ID, outcome: 'refreshed' });
    expect(row['body']).toBe('on demand body');

    fail = true;
    const failed = await post(app, `/task/live-notes/${NOTE_ID}/run`);
    expect(failed.status).toBe(200);
    expect(await failed.json()).toEqual({ noteId: NOTE_ID, outcome: 'failed', error: 'rate limited', autoPaused: false });
    expect(row).toMatchObject({ consecutive_failures: 1, last_error: 'rate limited', body: 'on demand body' });

    expect((await post(app, '/task/live-notes/00000000-0000-4000-8000-000000000007/run')).status).toBe(404);
  });
});
