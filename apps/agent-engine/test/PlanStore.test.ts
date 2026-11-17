import { describe, it, expect } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createPlanStore, parsePlanInput, slugify, type PlanInput } from '../src/core/PlanStore.js';

type Row = Record<string, unknown>;
type Filter = { column: string; op: 'eq' | 'gte' | 'is'; value: unknown };
type Op = 'select' | 'upsert' | 'update' | 'delete';

const OWNER = '00000000-0000-4000-8000-000000000001';

// In-memory stand-in for the slice of the supabase-js query builder PlanStore
// uses: schema().from(), select/eq/gte/is/order/maybeSingle/single, upsert with
// onConflict, update and delete. Rows live in `tables`, keyed `<schema>.<table>`,
// so tests assert on the resulting database state rather than the call sequence.
function createFakeSupabase(failOn?: { table: string; op: Op }) {
  const tables: Record<string, Row[]> = { 'plans.plans': [], 'plans.plan_steps': [] };
  let nextId = 1;

  function from(schema: string, table: string) {
    const key = `${schema}.${table}`;
    const filters: Filter[] = [];
    let op: Op = 'select';
    let payload: Row[] = [];
    let patch: Row = {};
    let conflictKeys: string[] = [];
    let orderBy: string | null = null;
    let mode: 'many' | 'single' | 'maybeSingle' = 'many';

    const matches = (row: Row) =>
      filters.every((f) => {
        if (f.op === 'eq') return row[f.column] === f.value;
        if (f.op === 'is') return (row[f.column] ?? null) === f.value;
        return (row[f.column] as number) >= (f.value as number);
      });

    function execute(): { data: unknown; error: { message: string } | null } {
      if (failOn && failOn.table === table && failOn.op === op) {
        return { data: null, error: { message: `${op} on ${table} failed` } };
      }
      const rows = tables[key];
      if (!rows) return { data: null, error: { message: `relation "${key}" does not exist` } };
      let result: Row[];
      if (op === 'upsert') {
        result = payload.map((incoming) => {
          const existing = rows.find((row) => conflictKeys.every((k) => row[k] === incoming[k]));
          if (existing) return Object.assign(existing, incoming);
          const created: Row = { id: `id-${nextId++}`, ...incoming };
          if (table === 'plan_steps') created['completed_at'] ??= null;
          rows.push(created);
          return created;
        });
      } else if (op === 'update') {
        result = rows.filter(matches).map((row) => Object.assign(row, patch));
      } else if (op === 'delete') {
        result = rows.filter(matches);
        tables[key] = rows.filter((row) => !matches(row));
      } else {
        result = rows.filter(matches);
      }
      const copies = result.map((row) => ({ ...row }));
      if (orderBy) {
        const column = orderBy;
        copies.sort((a, b) => (a[column] as number) - (b[column] as number));
      }
      if (mode === 'many') return { data: copies, error: null };
      if (copies.length === 0 && mode === 'single') return { data: null, error: { message: 'no rows' } };
      return { data: copies[0] ?? null, error: null };
    }

    const builder = {
      select: () => builder,
      eq: (column: string, value: unknown) => {
        filters.push({ column, op: 'eq', value });
        return builder;
      },
      gte: (column: string, value: unknown) => {
        filters.push({ column, op: 'gte', value });
        return builder;
      },
      is: (column: string, value: unknown) => {
        filters.push({ column, op: 'is', value });
        return builder;
      },
      order: (column: string) => {
        orderBy = column;
        return builder;
      },
      upsert: (rows: Row | Row[], options: { onConflict: string }) => {
        op = 'upsert';
        payload = Array.isArray(rows) ? rows : [rows];
        conflictKeys = options.onConflict.split(',');
        return builder;
      },
      update: (values: Row) => {
        op = 'update';
        patch = values;
        return builder;
      },
      delete: () => {
        op = 'delete';
        return builder;
      },
      single: () => {
        mode = 'single';
        return builder;
      },
      maybeSingle: () => {
        mode = 'maybeSingle';
        return builder;
      },
      then: (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) =>
        Promise.resolve().then(execute).then(resolve, reject),
    };
    return builder;
  }

  const client = {
    schema: (schema: string) => ({ from: (table: string) => from(schema, table) }),
    from: (table: string) => from('public', table),
  };
  return { client: client as unknown as SupabaseClient, tables };
}

describe('slugify', () => {
  it('lowercases and hyphenates words', () => {
    expect(slugify('Add /plans Endpoint to agent-engine')).toBe('add-plans-endpoint-to-agent-engine');
  });

  it('strips diacritics and collapses punctuation', () => {
    expect(slugify('  Café — déjà vu!!  ')).toBe('cafe-deja-vu');
  });

  it('caps the slug at 80 characters without a trailing hyphen', () => {
    const slug = slugify(`${'a'.repeat(79)} b`);
    expect(slug.length).toBeLessThanOrEqual(80);
    expect(slug.endsWith('-')).toBe(false);
  });

  it('returns an empty string when nothing slug-safe remains', () => {
    expect(slugify('!!! ???')).toBe('');
  });
});

describe('parsePlanInput', () => {
  it('derives the slug from the title and treats string steps as user steps', () => {
    const result = parsePlanInput({ title: 'Ship Plans', steps: ['Write migration'] });
    expect(result).toEqual({
      ok: true,
      value: {
        slug: 'ship-plans',
        title: 'Ship Plans',
        subtitle: null,
        sessionId: null,
        steps: [{ kind: 'user', title: 'Write migration', badge: null, checkLabel: null, content: null, doneNote: null }],
      },
    });
  });

  it('accepts the impl-plan skill step objects as-is', () => {
    const result = parsePlanInput({
      title: 'Ship Plans',
      slug: 'plans-v1',
      subtitle: 'ADR-010',
      sessionId: 'session-abc',
      steps: [
        { type: 'predone', title: 'Write ADR', doneNote: 'Completed 04 Jul 2026' },
        { type: 'user', title: 'Add endpoint', badge: 'wsl', checkLabel: 'Tests pass', content: '<p>Do it</p>' },
      ],
    });
    expect(result).toEqual({
      ok: true,
      value: {
        slug: 'plans-v1',
        title: 'Ship Plans',
        subtitle: 'ADR-010',
        sessionId: 'session-abc',
        steps: [
          { kind: 'predone', title: 'Write ADR', badge: null, checkLabel: null, content: null, doneNote: 'Completed 04 Jul 2026' },
          { kind: 'user', title: 'Add endpoint', badge: 'wsl', checkLabel: 'Tests pass', content: '<p>Do it</p>', doneNote: null },
        ],
      },
    });
  });

  it.each([
    ['a non-object body', 'plan'],
    ['a missing title', { steps: ['a'] }],
    ['a blank title', { title: '   ', steps: ['a'] }],
    ['a title with no slug-safe characters', { title: '???', steps: ['a'] }],
    ['an invalid explicit slug', { title: 'Plan', slug: 'Not A Slug', steps: ['a'] }],
    ['a non-string subtitle', { title: 'Plan', subtitle: 3, steps: ['a'] }],
    ['a non-string sessionId', { title: 'Plan', sessionId: 3, steps: ['a'] }],
    ['missing steps', { title: 'Plan' }],
    ['an empty steps array', { title: 'Plan', steps: [] }],
    ['a blank step title', { title: 'Plan', steps: [{ title: '' }] }],
    ['a step that is neither string nor object', { title: 'Plan', steps: [42] }],
    ['an unknown step type', { title: 'Plan', steps: [{ type: 'later', title: 'a' }] }],
    ['an unknown badge', { title: 'Plan', steps: [{ title: 'a', badge: 'mac' }] }],
    ['a non-string step content', { title: 'Plan', steps: [{ title: 'a', content: 1 }] }],
    ['too many steps', { title: 'Plan', steps: Array.from({ length: 501 }, (_, i) => `step ${i}`) }],
  ])('rejects %s', (_label, body) => {
    const result = parsePlanInput(body);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/\S/);
  });
});

describe('PlanStore.publish', () => {
  const step = (title: string, kind: 'user' | 'predone' = 'user') =>
    ({ kind, title, badge: null, checkLabel: null, content: null, doneNote: null });
  const input: PlanInput = {
    slug: 'ship-plans',
    title: 'Ship Plans',
    subtitle: null,
    sessionId: 'session-abc',
    steps: [step('Write ADR', 'predone'), step('Add endpoint'), step('Add routes')],
  };

  it('creates the plan in the plans schema, owned by the configured user, with ordered steps', async () => {
    const { client, tables } = createFakeSupabase();
    const result = await createPlanStore(client, { ownerUserId: OWNER }).publish(input);

    expect(result.created).toBe(true);
    expect(tables['plans.plans']).toHaveLength(1);
    expect(tables['plans.plans']?.[0]).toMatchObject({ user_id: OWNER, slug: 'ship-plans', session_id: 'session-abc' });
    expect(result.plan.steps.map((s) => [s.position, s.kind, s.title])).toEqual([
      [0, 'predone', 'Write ADR'],
      [1, 'user', 'Add endpoint'],
      [2, 'user', 'Add routes'],
    ]);
    expect(tables['plans.plan_steps']?.every((row) => row['plan_id'] === result.plan.id)).toBe(true);
  });

  it('marks predone steps completed and leaves user steps open', async () => {
    const { client } = createFakeSupabase();
    const result = await createPlanStore(client, { ownerUserId: OWNER }).publish(input);

    expect(result.plan.steps[0]?.completed_at).toEqual(expect.any(String));
    expect(result.plan.steps[1]?.completed_at).toBeNull();
    expect(result.plan.steps[2]?.completed_at).toBeNull();
  });

  it('is idempotent on slug: republishing updates in place and keeps step progress', async () => {
    const { client, tables } = createFakeSupabase();
    const store = createPlanStore(client, { ownerUserId: OWNER });
    const first = await store.publish(input);
    const predoneAt = first.plan.steps[0]?.completed_at;

    const ticked = tables['plans.plan_steps']?.find((row) => row['position'] === 1);
    if (ticked) ticked['completed_at'] = '2026-10-08T00:00:00.000Z';

    const second = await store.publish({ ...input, title: 'Ship Plans v2' });

    expect(second.created).toBe(false);
    expect(second.plan.id).toBe(first.plan.id);
    expect(second.plan.title).toBe('Ship Plans v2');
    expect(tables['plans.plans']).toHaveLength(1);
    expect(tables['plans.plan_steps']).toHaveLength(3);
    expect(second.plan.steps[0]?.completed_at).toBe(predoneAt);
    expect(second.plan.steps[1]?.completed_at).toBe('2026-10-08T00:00:00.000Z');
  });

  it('never writes completed_at in the step upsert, so a republish cannot un-tick a step', async () => {
    const { client, tables } = createFakeSupabase();
    const store = createPlanStore(client, { ownerUserId: OWNER });
    await store.publish(input);
    for (const row of tables['plans.plan_steps'] ?? []) row['completed_at'] = 'ticked';
    const result = await store.publish(input);
    expect(result.plan.steps.every((s) => s.completed_at === 'ticked')).toBe(true);
  });

  it('drops steps beyond the new length when a republish has fewer steps', async () => {
    const { client, tables } = createFakeSupabase();
    const store = createPlanStore(client, { ownerUserId: OWNER });
    await store.publish(input);
    const result = await store.publish({ ...input, steps: input.steps.slice(0, 1) });

    expect(result.plan.steps).toHaveLength(1);
    expect(tables['plans.plan_steps']).toHaveLength(1);
  });

  it.each([
    ['select', 'plans'],
    ['upsert', 'plans'],
    ['upsert', 'plan_steps'],
    ['update', 'plan_steps'],
    ['delete', 'plan_steps'],
    ['select', 'plan_steps'],
  ] as const)('surfaces a %s failure on %s as an error naming the plan', async (op, table) => {
    const { client } = createFakeSupabase({ table, op });
    await expect(createPlanStore(client, { ownerUserId: OWNER }).publish(input)).rejects.toThrow(/ship-plans/);
  });
});
