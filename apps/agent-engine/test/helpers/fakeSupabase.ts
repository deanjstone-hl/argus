import type { SupabaseClient } from '@supabase/supabase-js';

type Row = Record<string, unknown>;

export interface FakeCall {
  table: string;
  op: 'select' | 'update';
  columns?: string;
  patch?: Row;
  filters: Array<{ kind: 'eq' | 'in' | 'or' | 'order' | 'limit'; args: unknown[] }>;
}

export interface FakeRpcCall {
  fn: string;
  args: Record<string, unknown>;
}

interface Result {
  data: unknown;
  error: { message: string } | null;
}

// A chainable stand-in for the supabase-js query builder. It applies `eq` and
// `in` filters to in-memory tables, honours `limit`, records every call, and
// leaves `or` and `order` to the test (they are asserted, not evaluated).
// `rpc` answers from the named handlers; a function with no handler fails as
// PostgREST does for a function the database does not have.
export function fakeSupabase(
  tables: Record<string, Row[]>,
  options: {
    failTables?: Record<string, string>;
    rpc?: Record<string, (args: Record<string, unknown>) => Row[] | { error: string }>;
  } = {}
): { client: SupabaseClient; calls: FakeCall[]; rpcCalls: FakeRpcCall[]; tables: Record<string, Row[]> } {
  const calls: FakeCall[] = [];
  const rpcCalls: FakeRpcCall[] = [];

  const rpc = (fn: string, args: Record<string, unknown> = {}): Promise<Result> => {
    rpcCalls.push({ fn, args });
    const handler = options.rpc?.[fn];
    if (!handler) {
      return Promise.resolve({ data: null, error: { message: `Could not find the function public.${fn} in the schema cache` } });
    }
    const answer = handler(args);
    if ('error' in answer) return Promise.resolve({ data: null, error: { message: answer.error } });
    return Promise.resolve({ data: answer, error: null });
  };

  const from = (table: string) => {
    const call: FakeCall = { table, op: 'select', filters: [] };
    let single = false;

    const run = (): Result => {
      calls.push(call);
      const failure = options.failTables?.[table];
      if (failure) return { data: null, error: { message: failure } };

      const rows = tables[table] ?? [];
      const matching = rows.filter(row =>
        call.filters.every(filter => {
          if (filter.kind === 'eq') return row[filter.args[0] as string] === filter.args[1];
          if (filter.kind === 'in') return (filter.args[1] as unknown[]).includes(row[filter.args[0] as string]);
          return true;
        })
      );

      if (call.op === 'update') {
        for (const row of matching) Object.assign(row, call.patch);
        return { data: null, error: null };
      }

      const limit = call.filters.find(filter => filter.kind === 'limit');
      const limited = limit ? matching.slice(0, limit.args[0] as number) : matching;
      return { data: single ? (limited[0] ?? null) : limited, error: null };
    };

    const builder: Record<string, unknown> = {
      select(columns: string) {
        call.columns = columns;
        return builder;
      },
      update(patch: Row) {
        call.op = 'update';
        call.patch = patch;
        return builder;
      },
      eq: (...args: unknown[]) => (call.filters.push({ kind: 'eq', args }), builder),
      in: (...args: unknown[]) => (call.filters.push({ kind: 'in', args }), builder),
      or: (...args: unknown[]) => (call.filters.push({ kind: 'or', args }), builder),
      order: (...args: unknown[]) => (call.filters.push({ kind: 'order', args }), builder),
      limit: (...args: unknown[]) => (call.filters.push({ kind: 'limit', args }), builder),
      maybeSingle() {
        single = true;
        return Promise.resolve(run());
      },
      then(resolve: (value: Result) => unknown, reject?: (reason: unknown) => unknown) {
        return Promise.resolve(run()).then(resolve, reject);
      },
    };
    return builder;
  };

  return { client: { from, rpc } as unknown as SupabaseClient, calls, rpcCalls, tables };
}
