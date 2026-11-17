import { describe, it, expect } from 'vitest';
import { fakeSupabase } from './helpers/fakeSupabase.js';
import {
  createSupabaseGraphReader,
  createSupabaseLiveNoteStore,
  extractKeywords,
} from '../src/core/LiveNoteStore.js';
import type { LiveNote } from '../src/core/LiveNotes.js';

function noteRow(overrides: Partial<LiveNote> = {}): LiveNote {
  return {
    id: 'note-1',
    user_id: 'user-1',
    title: 'Auth',
    objective: 'Track passkey authentication decisions',
    body: '',
    interval_minutes: 60,
    last_run_at: null,
    is_active: true,
    consecutive_failures: 0,
    last_error: null,
    last_error_at: null,
    pause_reason: null,
    ...overrides,
  };
}

describe('createSupabaseLiveNoteStore', () => {
  it('lists only active notes', async () => {
    const { client, calls } = fakeSupabase({
      knowledge_live_notes: [noteRow({ id: 'a' }), noteRow({ id: 'b', is_active: false, pause_reason: 'user' })],
    });
    const rows = await createSupabaseLiveNoteStore(client).listActive();
    expect(rows.map(row => row.id)).toEqual(['a']);
    expect(calls[0]!.table).toBe('knowledge_live_notes');
    expect(calls[0]!.columns).toContain('objective');
  });

  it('gets one note by id, or null', async () => {
    const { client } = fakeSupabase({ knowledge_live_notes: [noteRow({ id: 'a' })] });
    const store = createSupabaseLiveNoteStore(client);
    expect((await store.get('a'))?.id).toBe('a');
    expect(await store.get('zzz')).toBeNull();
  });

  it('updates the named row with the patch', async () => {
    const { client, tables } = fakeSupabase({ knowledge_live_notes: [noteRow({ id: 'a' }), noteRow({ id: 'b' })] });
    await createSupabaseLiveNoteStore(client).update('a', { body: 'new', consecutive_failures: 0 });
    expect(tables['knowledge_live_notes']![0]).toMatchObject({ body: 'new' });
    expect(tables['knowledge_live_notes']![1]).toMatchObject({ body: '' });
  });

  it('throws the database error message', async () => {
    const { client } = fakeSupabase({}, { failTables: { knowledge_live_notes: 'relation does not exist' } });
    const store = createSupabaseLiveNoteStore(client);
    await expect(store.listActive()).rejects.toThrow('relation does not exist');
    await expect(store.get('a')).rejects.toThrow('relation does not exist');
    await expect(store.update('a', { body: 'x' })).rejects.toThrow('relation does not exist');
  });
});

describe('extractKeywords', () => {
  it('keeps distinctive lowercase words and drops stop words and short words', () => {
    expect(extractKeywords('Track what I have decided about passkey authentication')).toEqual([
      'track',
      'decided',
      'passkey',
      'authentication',
    ]);
  });

  it('strips everything that is not a letter or digit, so a keyword cannot carry filter syntax', () => {
    const keywords = extractKeywords('foo,bar) or (id.eq.1 "quoted" 100%');
    for (const keyword of keywords) expect(keyword).toMatch(/^[a-z0-9]+$/);
    expect(keywords).toContain('quoted');
  });

  it('deduplicates and caps the list', () => {
    const many = Array.from({ length: 30 }, (_, i) => `keyword${i}`).join(' ');
    expect(extractKeywords(many).length).toBeLessThanOrEqual(8);
    expect(extractKeywords('passkey Passkey PASSKEY')).toEqual(['passkey']);
  });

  it('returns nothing for an objective with no usable words', () => {
    expect(extractKeywords('a an to of')).toEqual([]);
  });
});

describe('createSupabaseGraphReader', () => {
  const chat = (id: string, title: string, summary: string | null, extra: Record<string, unknown> = {}) => ({
    id,
    user_id: 'user-1',
    title,
    date: '2026-10-01',
    source: 'claude',
    summary,
    tags: [],
    ...extra,
  });

  it('scopes every query to the note owner', async () => {
    const { client, calls } = fakeSupabase({
      knowledge_chats: [chat('c1', 'Passkey plan', 'x')],
      knowledge_graph_edges: [],
    });
    await createSupabaseGraphReader(client).read(noteRow());
    for (const call of calls) {
      expect(call.filters).toContainEqual({ kind: 'eq', args: ['user_id', 'user-1'] });
    }
  });

  it('matches on the objective keywords, with only safe characters in the filter', async () => {
    const { client, calls } = fakeSupabase({ knowledge_chats: [], knowledge_graph_edges: [] });
    await createSupabaseGraphReader(client).read(noteRow({ objective: 'passkey, authentication) or (x' }));
    const orFilter = calls[0]!.filters.find(filter => filter.kind === 'or')!;
    expect(orFilter.args[0]).toBe(
      'title.ilike.%passkey%,summary.ilike.%passkey%,title.ilike.%authentication%,summary.ilike.%authentication%'
    );
  });

  it('ranks chats by keyword hits, title weighing more than summary', async () => {
    const { client } = fakeSupabase({
      knowledge_chats: [
        chat('weak', 'Misc', 'mentions passkey once'),
        chat('strong', 'Passkey authentication', 'both words: passkey authentication'),
        chat('title-only', 'Authentication notes', null),
      ],
      knowledge_graph_edges: [],
    });
    const context = await createSupabaseGraphReader(client).read(noteRow());
    expect(context.chats.map(c => c.id)).toEqual(['strong', 'title-only', 'weak']);
    expect(context.chats.every(c => !c.linked)).toBe(true);
  });

  it('caps the matched chats', async () => {
    const rows = Array.from({ length: 80 }, (_, i) => chat(`c${i}`, `Passkey ${i}`, null));
    const { client } = fakeSupabase({ knowledge_chats: rows, knowledge_graph_edges: [] });
    const context = await createSupabaseGraphReader(client).read(noteRow());
    expect(context.chats.length).toBeLessThanOrEqual(25);
  });

  it('pulls in one hop of linked chats and the edges that touch the matches', async () => {
    const { client } = fakeSupabase({
      knowledge_chats: [
        chat('c1', 'Passkey plan', 'x'),
        chat('c2', 'Session cookies', 'linked chat that does not match any keyword'),
        chat('c3', 'Unrelated', 'nothing'),
      ],
      knowledge_graph_edges: [
        { user_id: 'user-1', from_id: 'c1', to_id: 'c2', edge_type: 'continues', weight: 0.9 },
        { user_id: 'user-1', from_id: 'c3', to_id: 'c4', edge_type: 'similar', weight: 0.5 },
      ],
    });
    // c2 is not matched by keyword; only the edge brings it in.
    const reader = createSupabaseGraphReader(client);
    const context = await reader.read(noteRow({ objective: 'passkey' }));

    expect(context.chats.map(c => [c.id, c.linked])).toEqual([
      ['c1', false],
      ['c2', true],
    ]);
    expect(context.links).toEqual([{ fromId: 'c1', toId: 'c2', edgeType: 'continues', weight: 0.9 }]);
  });

  it('falls back to the most recent chats when the objective has no usable keywords', async () => {
    const { client, calls } = fakeSupabase({
      knowledge_chats: [chat('c1', 'Recent', 'x')],
      knowledge_graph_edges: [],
    });
    const context = await createSupabaseGraphReader(client).read(noteRow({ objective: 'a to of' }));
    expect(context.chats.map(c => c.id)).toEqual(['c1']);
    expect(calls[0]!.filters.some(filter => filter.kind === 'or')).toBe(false);
  });

  it('throws the database error so the run is recorded as a failure', async () => {
    const { client } = fakeSupabase({}, { failTables: { knowledge_chats: 'permission denied' } });
    await expect(createSupabaseGraphReader(client).read(noteRow())).rejects.toThrow('permission denied');
  });
});

describe('createSupabaseGraphReader with an embedder', () => {
  const chat = (id: string, title: string, summary: string | null) => ({
    id,
    user_id: 'user-1',
    title,
    date: '2026-10-01',
    source: 'claude',
    summary,
    tags: ['t'],
  });
  const vector = [0.1, 0.2, 0.3];
  const embedder = { embed: async (_text: string) => vector };

  it('searches by meaning for the note owner, with the objective embedded', async () => {
    const embedded: string[] = [];
    const { client, rpcCalls } = fakeSupabase(
      { knowledge_chats: [], knowledge_graph_edges: [] },
      { rpc: { match_knowledge_chats_for_user: () => [] } }
    );
    await createSupabaseGraphReader(client, {
      embedder: { embed: async text => (embedded.push(text), vector) },
    }).read(noteRow());
    expect(embedded).toEqual(['Track passkey authentication decisions']);
    expect(rpcCalls).toEqual([
      {
        fn: 'match_knowledge_chats_for_user',
        args: { p_user_id: 'user-1', query_embedding: vector, match_threshold: 0.5, match_count: 25 },
      },
    ]);
  });

  it('finds chats that share no word with the objective', async () => {
    const { client } = fakeSupabase(
      { knowledge_chats: [chat('c1', 'WebAuthn rollout', 'Chose platform authenticators.')], knowledge_graph_edges: [] },
      {
        rpc: {
          match_knowledge_chats_for_user: () => [{ ...chat('c1', 'WebAuthn rollout', 'Chose platform authenticators.'), similarity: 0.8 }],
        },
      }
    );
    const context = await createSupabaseGraphReader(client, { embedder }).read(noteRow({ objective: 'Track login security' }));
    expect(context.chats).toEqual([
      {
        id: 'c1',
        title: 'WebAuthn rollout',
        date: '2026-10-01',
        source: 'claude',
        summary: 'Chose platform authenticators.',
        tags: ['t'],
        linked: false,
      },
    ]);
  });

  it('puts semantic matches first, then keyword matches, without duplicates', async () => {
    const { client } = fakeSupabase(
      {
        knowledge_chats: [chat('kw', 'Passkey notes', null), chat('both', 'Passkey plan', null)],
        knowledge_graph_edges: [],
      },
      {
        rpc: {
          match_knowledge_chats_for_user: () => [
            { ...chat('sem', 'Login security', null), similarity: 0.9 },
            { ...chat('both', 'Passkey plan', null), similarity: 0.7 },
          ],
        },
      }
    );
    const context = await createSupabaseGraphReader(client, { embedder }).read(noteRow({ objective: 'passkey' }));
    expect(context.chats.map(c => c.id)).toEqual(['sem', 'both', 'kw']);
  });

  it('pulls in linked chats around semantic matches', async () => {
    const { client } = fakeSupabase(
      {
        knowledge_chats: [chat('sem', 'Login security', null), chat('next', 'Follow-up', null)],
        knowledge_graph_edges: [{ user_id: 'user-1', from_id: 'sem', to_id: 'next', edge_type: 'continues', weight: 0.9 }],
      },
      { rpc: { match_knowledge_chats_for_user: () => [{ ...chat('sem', 'Login security', null), similarity: 0.9 }] } }
    );
    const context = await createSupabaseGraphReader(client, { embedder }).read(noteRow({ objective: 'zzz qqq' }));
    expect(context.chats.map(c => [c.id, c.linked])).toEqual([
      ['sem', false],
      ['next', true],
    ]);
  });

  it('falls back to keywords and reports why when the search function is missing', async () => {
    const errors: string[] = [];
    const { client } = fakeSupabase({ knowledge_chats: [chat('kw', 'Passkey notes', null)], knowledge_graph_edges: [] });
    const context = await createSupabaseGraphReader(client, {
      embedder,
      onSemanticError: error => errors.push(error.message),
    }).read(noteRow({ objective: 'passkey' }));
    expect(context.chats.map(c => c.id)).toEqual(['kw']);
    expect(errors).toEqual(['Could not find the function public.match_knowledge_chats_for_user in the schema cache']);
  });

  it('falls back to keywords when the embedder fails', async () => {
    const errors: string[] = [];
    const { client, rpcCalls } = fakeSupabase({ knowledge_chats: [chat('kw', 'Passkey notes', null)], knowledge_graph_edges: [] });
    const context = await createSupabaseGraphReader(client, {
      embedder: { embed: async () => Promise.reject(new Error('model download failed')) },
      onSemanticError: error => errors.push(error.message),
    }).read(noteRow({ objective: 'passkey' }));
    expect(context.chats.map(c => c.id)).toEqual(['kw']);
    expect(rpcCalls).toEqual([]);
    expect(errors).toEqual(['model download failed']);
  });

  it('makes no semantic call without an embedder', async () => {
    const { client, rpcCalls } = fakeSupabase({ knowledge_chats: [], knowledge_graph_edges: [] });
    await createSupabaseGraphReader(client).read(noteRow());
    expect(rpcCalls).toEqual([]);
  });
});
