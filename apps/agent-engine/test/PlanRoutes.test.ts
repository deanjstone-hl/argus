import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { existsSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Hono } from 'hono';
import type { PlanInput, PlanStore, PublishResult } from '../src/core/PlanStore.js';
import { createPlansRoutes, plansConfigFromEnv } from '../src/server/plans.js';

const TOKEN = 'test-token-not-a-secret';

function publishedFrom(input: PlanInput, created: boolean): PublishResult {
  return {
    created,
    plan: {
      id: 'plan-1',
      slug: input.slug,
      title: input.title,
      subtitle: input.subtitle,
      session_id: input.sessionId,
      steps: input.steps.map((step, position) => ({
        id: `step-${position}`,
        position,
        kind: step.kind,
        title: step.title,
        badge: step.badge,
        check_label: step.checkLabel,
        content: step.content,
        done_note: step.doneNote,
        completed_at: null,
      })),
    },
  };
}

function buildApp(created = true) {
  const publish = vi.fn(async (input: PlanInput) => publishedFrom(input, created));
  const store: PlanStore = { publish };
  const app = createPlansRoutes(() => ({ store, token: TOKEN, origin: undefined }));
  return { app, publish };
}

function post(app: Hono, body: unknown, headers: Record<string, string> = { authorization: `Bearer ${TOKEN}` }) {
  return app.fetch(
    new Request('http://localhost/plans', {
      method: 'POST',
      body: typeof body === 'string' ? body : JSON.stringify(body),
      headers: { 'content-type': 'application/json', ...headers },
    })
  );
}

const validPlan = { title: 'Ship Plans', steps: ['Write migration', 'Add endpoint'] };

describe('POST /plans auth', () => {
  it('401s without an Authorization header', async () => {
    const { app, publish } = buildApp();
    const res = await post(app, validPlan, {});
    expect(res.status).toBe(401);
    expect(publish).not.toHaveBeenCalled();
  });

  it('401s on a wrong bearer token', async () => {
    const { app, publish } = buildApp();
    const res = await post(app, validPlan, { authorization: 'Bearer wrong' });
    expect(res.status).toBe(401);
    expect(publish).not.toHaveBeenCalled();
  });

  it('401s on a non-bearer scheme', async () => {
    const { app } = buildApp();
    const res = await post(app, validPlan, { authorization: `Basic ${TOKEN}` });
    expect(res.status).toBe(401);
  });
});

describe('POST /plans validation', () => {
  it('400s on malformed JSON', async () => {
    const { app, publish } = buildApp();
    const res = await post(app, '{not json');
    expect(res.status).toBe(400);
    expect(publish).not.toHaveBeenCalled();
  });

  it('400s on an invalid plan with the validation message', async () => {
    const { app } = buildApp();
    const res = await post(app, { title: 'Plan', steps: [] });
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toMatch(/steps/);
  });
});

describe('POST /plans publish', () => {
  it('201s on a new plan and returns the plan and its myargus.cc URL', async () => {
    const { app, publish } = buildApp(true);
    const res = await post(app, validPlan);
    expect(res.status).toBe(201);
    const body = await res.json() as { created: boolean; url: string; plan: { slug: string; steps: unknown[] } };
    expect(body.created).toBe(true);
    expect(body.url).toBe('https://myargus.cc/plans/ship-plans');
    expect(body.plan.slug).toBe('ship-plans');
    expect(body.plan.steps).toHaveLength(2);
    expect(publish).toHaveBeenCalledWith({
      slug: 'ship-plans',
      title: 'Ship Plans',
      subtitle: null,
      sessionId: null,
      steps: [
        { kind: 'user', title: 'Write migration', badge: null, checkLabel: null, content: null, doneNote: null },
        { kind: 'user', title: 'Add endpoint', badge: null, checkLabel: null, content: null, doneNote: null },
      ],
    });
  });

  it('200s when the slug already existed', async () => {
    const { app } = buildApp(false);
    const res = await post(app, validPlan);
    expect(res.status).toBe(200);
    const body = await res.json() as { created: boolean };
    expect(body.created).toBe(false);
  });

  it('500s with the store error message when the write fails', async () => {
    const store: PlanStore = { publish: vi.fn(async () => { throw new Error('upsert failed for plan "ship-plans"'); }) };
    const app = createPlansRoutes(() => ({ store, token: TOKEN, origin: undefined }));
    const res = await post(app, validPlan);
    expect(res.status).toBe(500);
    const body = await res.json() as { error: string };
    expect(body.error).toMatch(/ship-plans/);
  });
});

describe('the published plan URL', () => {
  it('follows an origin override and keeps the registry path', async () => {
    const store: PlanStore = { publish: vi.fn(async (input: PlanInput) => publishedFrom(input, true)) };
    const app = createPlansRoutes(() => ({ store, token: TOKEN, origin: 'http://localhost:5173' }));
    const body = await (await post(app, validPlan)).json() as { url: string };
    expect(body.url).toBe('http://localhost:5173/plans/ship-plans');
  });
});

describe('plansConfigFromEnv', () => {
  const full = {
    SUPABASE_URL: 'https://example.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: 'service-role',
    ARGUS_PLANS_TOKEN: TOKEN,
    ARGUS_PLANS_OWNER_USER_ID: '00000000-0000-4000-8000-000000000001',
  };

  it('returns the config, with no origin override, when all four are set', () => {
    expect(plansConfigFromEnv(full)).toEqual({
      supabaseUrl: 'https://example.supabase.co',
      supabaseKey: 'service-role',
      token: TOKEN,
      ownerUserId: '00000000-0000-4000-8000-000000000001',
    });
  });

  it('returns null when ARGUS_PLANS_OWNER_USER_ID is not a UUID', () => {
    expect(plansConfigFromEnv({ ...full, ARGUS_PLANS_OWNER_USER_ID: 'dean' })).toBeNull();
  });

  it('reads ARGUS_PLANS_BASE_URL as an origin override only: a path on it is dropped', () => {
    expect(plansConfigFromEnv({ ...full, ARGUS_PLANS_BASE_URL: 'http://localhost:5173/plans/' })?.origin)
      .toBe('http://localhost:5173');
  });

  it('returns null, not the production URL, when ARGUS_PLANS_BASE_URL is not a URL', () => {
    expect(plansConfigFromEnv({ ...full, ARGUS_PLANS_BASE_URL: 'localhost:5173' })).toBeNull();
    expect(plansConfigFromEnv({ ...full, ARGUS_PLANS_BASE_URL: 'ftp://localhost' })).toBeNull();
  });

  it.each(['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'ARGUS_PLANS_TOKEN', 'ARGUS_PLANS_OWNER_USER_ID'] as const)(
    'returns null when %s is unset or blank',
    (name) => {
      expect(plansConfigFromEnv({ ...full, [name]: undefined })).toBeNull();
      expect(plansConfigFromEnv({ ...full, [name]: '  ' })).toBeNull();
    }
  );
});

describe('POST /plans on the real server when not configured', () => {
  let app: Hono;
  let jobsDbPath: string;
  let vectorDbPath: string;
  const saved: Record<string, string | undefined> = {};

  beforeAll(async () => {
    for (const name of ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'ARGUS_PLANS_TOKEN', 'ARGUS_PLANS_OWNER_USER_ID']) {
      saved[name] = process.env[name];
      delete process.env[name];
    }
    jobsDbPath = join(tmpdir(), `plan-routes-jobs-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
    vectorDbPath = join(tmpdir(), `plan-routes-vectors-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
    process.env['ARGUS_JOBS_DB_PATH'] = jobsDbPath;
    process.env['ARGUS_VECTOR_DB_PATH'] = vectorDbPath;
    const mod = await import('../src/server/http.js');
    app = mod.app;
  });

  afterAll(() => {
    for (const [name, value] of Object.entries(saved)) {
      if (value !== undefined) process.env[name] = value;
    }
    for (const p of [jobsDbPath, vectorDbPath]) {
      if (existsSync(p)) unlinkSync(p);
    }
  });

  it('503s with a not-configured error before checking auth or the body', async () => {
    const res = await post(app, { nonsense: true }, {});
    expect(res.status).toBe(503);
    const body = await res.json() as { error: string };
    expect(body.error).toMatch(/not configured/);
  });
});
