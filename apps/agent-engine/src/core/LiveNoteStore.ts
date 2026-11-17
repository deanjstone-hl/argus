import type { SupabaseClient } from '@supabase/supabase-js';
import type {
  GraphChat,
  GraphContext,
  GraphLink,
  GraphReader,
  LiveNote,
  LiveNotePatch,
  LiveNoteStore,
} from './LiveNotes.js';

// Table and column names come from myargus: the live-notes migration
// (supabase/migrations/20261022000000_knowledge_live_notes.sql) and the
// knowledge graph tables (packages/db/migrations/003_knowledge.sql and
// 004_knowledge_sync.sql). Keep these in step with them. The client holds the
// service role, which bypasses RLS, so every graph query filters on the
// note's `user_id` itself.
const NOTES_TABLE = 'knowledge_live_notes';
const CHATS_TABLE = 'knowledge_chats';
const EDGES_TABLE = 'knowledge_graph_edges';
// From myargus supabase/migrations/20261023000000_knowledge_match_for_user.sql.
const MATCH_FUNCTION = 'match_knowledge_chats_for_user';
const NOTE_COLUMNS =
  'id, user_id, title, objective, body, interval_minutes, last_run_at, is_active, consecutive_failures, last_error, last_error_at, pause_reason';
const CHAT_COLUMNS = 'id, title, date, source, summary, tags';
const EDGE_COLUMNS = 'from_id, to_id, edge_type, weight';

const MAX_KEYWORDS = 8;
const MIN_KEYWORD_LENGTH = 3;
const CANDIDATE_LIMIT = 100;
const MAX_MATCHED_CHATS = 25;
const MAX_LINKED_CHATS = 10;
const MAX_LINKS = 60;
const EDGE_LIMIT = 200;
// The knowledge app's default similarity threshold for search.
const SEMANTIC_THRESHOLD = 0.5;
const TITLE_HIT = 2;
const SUMMARY_HIT = 1;

const STOP_WORDS = new Set([
  'the', 'and', 'for', 'are', 'but', 'not', 'you', 'all', 'any', 'can', 'had', 'her', 'was', 'one', 'our', 'out',
  'about', 'after', 'again', 'also', 'been', 'before', 'being', 'between', 'both', 'could', 'does', 'each', 'from',
  'have', 'having', 'into', 'just', 'keep', 'like', 'make', 'more', 'most', 'much', 'must', 'only', 'other', 'over',
  'same', 'should', 'some', 'such', 'than', 'that', 'their', 'them', 'then', 'there', 'these', 'they', 'this',
  'those', 'through', 'under', 'very', 'want', 'were', 'what', 'when', 'where', 'which', 'while', 'who', 'whom',
  'will', 'with', 'would', 'your', 'mine', 'myself', 'note', 'notes',
]);

interface QueryError {
  message: string;
}

function check<T>(result: { data: T; error: QueryError | null }): T {
  if (result.error) throw new Error(result.error.message);
  return result.data;
}

export function createSupabaseLiveNoteStore(client: SupabaseClient): LiveNoteStore {
  return {
    async listActive() {
      const rows = check(await client.from(NOTES_TABLE).select(NOTE_COLUMNS).eq('is_active', true));
      return (rows ?? []) as unknown as LiveNote[];
    },

    async get(id) {
      const row = check(await client.from(NOTES_TABLE).select(NOTE_COLUMNS).eq('id', id).maybeSingle());
      return (row ?? null) as unknown as LiveNote | null;
    },

    async update(id, patch: LiveNotePatch) {
      check(await client.from(NOTES_TABLE).update(patch).eq('id', id));
    },
  };
}

// Distinctive lowercase words from the objective. Only letters and digits
// survive, so a keyword is safe to place inside a PostgREST `or` filter.
export function extractKeywords(objective: string): string[] {
  const seen = new Set<string>();
  for (const word of objective.toLowerCase().split(/[^a-z0-9]+/)) {
    if (word.length < MIN_KEYWORD_LENGTH || STOP_WORDS.has(word)) continue;
    seen.add(word);
    if (seen.size === MAX_KEYWORDS) break;
  }
  return [...seen];
}

interface ChatRow {
  id: string;
  title: string;
  date: string | null;
  source: string | null;
  summary: string | null;
  tags: string[] | null;
}

interface EdgeRow {
  from_id: string;
  to_id: string;
  edge_type: string;
  weight: number | null;
}

function toChat(row: ChatRow, linked: boolean): GraphChat {
  return {
    id: row.id,
    title: row.title,
    date: row.date,
    source: row.source,
    summary: row.summary,
    tags: row.tags,
    linked,
  };
}

function score(row: ChatRow, keywords: string[]): number {
  const title = row.title.toLowerCase();
  const summary = (row.summary ?? '').toLowerCase();
  return keywords.reduce(
    (total, keyword) => total + (title.includes(keyword) ? TITLE_HIT : 0) + (summary.includes(keyword) ? SUMMARY_HIT : 0),
    0
  );
}

// Edges that touch a matched chat, in either direction, deduplicated.
async function readEdges(client: SupabaseClient, userId: string, ids: string[]): Promise<EdgeRow[]> {
  const outgoing = check(
    await client.from(EDGES_TABLE).select(EDGE_COLUMNS).eq('user_id', userId).in('from_id', ids).limit(EDGE_LIMIT)
  ) as unknown as EdgeRow[] | null;
  const incoming = check(
    await client.from(EDGES_TABLE).select(EDGE_COLUMNS).eq('user_id', userId).in('to_id', ids).limit(EDGE_LIMIT)
  ) as unknown as EdgeRow[] | null;

  const unique = new Map<string, EdgeRow>();
  for (const edge of [...(outgoing ?? []), ...(incoming ?? [])]) {
    unique.set(`${edge.from_id}\n${edge.to_id}\n${edge.edge_type}`, edge);
  }
  return [...unique.values()];
}

export interface Embedder {
  embed(text: string): Promise<number[]>;
}

export interface GraphReaderOptions {
  // Turns on semantic search. It must embed as the knowledge app does, or the
  // query vector would be compared with unlike stored vectors.
  embedder?: Embedder;
  // Semantic search is best effort: on failure the read carries on by keyword
  // and the error goes here.
  onSemanticError?: (error: Error) => void;
}

function rankByKeywords(candidates: ChatRow[], keywords: string[]): ChatRow[] {
  return candidates
    .map(row => ({ row, score: score(row, keywords) }))
    .filter(entry => entry.score > 0)
    .sort((a, b) => b.score - a.score)
    .map(entry => entry.row);
}

async function readSemanticMatches(
  client: SupabaseClient,
  note: LiveNote,
  options: GraphReaderOptions
): Promise<ChatRow[]> {
  if (!options.embedder) return [];
  try {
    const embedding = await options.embedder.embed(note.objective);
    const rows = check(
      await client.rpc(MATCH_FUNCTION, {
        p_user_id: note.user_id,
        query_embedding: embedding,
        match_threshold: SEMANTIC_THRESHOLD,
        match_count: MAX_MATCHED_CHATS,
      })
    );
    return (rows ?? []) as unknown as ChatRow[];
  } catch (error) {
    const report =
      options.onSemanticError ??
      ((reason: Error) => console.warn(`[live-notes] semantic search failed, using keywords: ${reason.message}`));
    report(error instanceof Error ? error : new Error(String(error)));
    return [];
  }
}

// The graph as a live note sees it: the owner's chats closest in meaning to
// the objective, then those that mention its keywords, plus one hop of chats
// the graph links to them. Semantic search needs an embedder that matches the
// knowledge app's model; without one, or when it fails, matching is by
// keyword alone. With neither semantic matches nor usable keywords, the most
// recent chats stand in.
export function createSupabaseGraphReader(client: SupabaseClient, options: GraphReaderOptions = {}): GraphReader {
  return {
    async read(note): Promise<GraphContext> {
      const semantic = await readSemanticMatches(client, note, options);
      const keywords = extractKeywords(note.objective);

      let byKeyword: ChatRow[] = [];
      if (keywords.length > 0 || semantic.length === 0) {
        let query = client.from(CHATS_TABLE).select(CHAT_COLUMNS).eq('user_id', note.user_id);
        if (keywords.length > 0) {
          query = query.or(keywords.flatMap(keyword => [`title.ilike.%${keyword}%`, `summary.ilike.%${keyword}%`]).join(','));
        }
        const candidates = (check(await query.order('date', { ascending: false, nullsFirst: false }).limit(CANDIDATE_LIMIT)) ??
          []) as unknown as ChatRow[];
        byKeyword = keywords.length > 0 ? rankByKeywords(candidates, keywords) : candidates;
      }

      const unique = new Map<string, ChatRow>();
      for (const row of [...semantic, ...byKeyword]) if (!unique.has(row.id)) unique.set(row.id, row);
      const matched = [...unique.values()].slice(0, MAX_MATCHED_CHATS);
      if (matched.length === 0) return { chats: [], links: [] };

      const matchedIds = matched.map(row => row.id);
      const edges = await readEdges(client, note.user_id, matchedIds);

      const matchedSet = new Set(matchedIds);
      const neighbourIds = [
        ...new Set(
          edges
            .sort((a, b) => (b.weight ?? 0) - (a.weight ?? 0))
            .flatMap(edge => [edge.from_id, edge.to_id])
            .filter(id => !matchedSet.has(id))
        ),
      ].slice(0, MAX_LINKED_CHATS);

      const neighbours =
        neighbourIds.length === 0
          ? []
          : ((check(
              await client.from(CHATS_TABLE).select(CHAT_COLUMNS).eq('user_id', note.user_id).in('id', neighbourIds)
            ) ?? []) as unknown as ChatRow[]);

      const chats = [...matched.map(row => toChat(row, false)), ...neighbours.map(row => toChat(row, true))];
      const present = new Set(chats.map(chat => chat.id));
      const links: GraphLink[] = edges
        .filter(edge => present.has(edge.from_id) && present.has(edge.to_id))
        .slice(0, MAX_LINKS)
        .map(edge => ({ fromId: edge.from_id, toId: edge.to_id, edgeType: edge.edge_type, weight: edge.weight }));

      return { chats, links };
    },
  };
}
