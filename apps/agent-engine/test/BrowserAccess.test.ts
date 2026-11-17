import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';
import { existsSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SignJWT, exportJWK, generateKeyPair, type CryptoKey } from 'jose';
import type { Hono } from 'hono';

const runPlan = vi.fn();

vi.mock('../src/core/ArgusEngine.js', () => ({ engine: { runPlan } }));

const SUPABASE_URL = 'https://test-project.supabase.co';
const JWKS_URL = `${SUPABASE_URL}/auth/v1/.well-known/jwks.json`;
const OWNER_ID = '00000000-0000-4000-8000-000000000004';
const OTHER_ID = '00000000-0000-4000-8000-000000000005';
const ALLOWED_ORIGIN = 'https://myargus.cc';
const KEY_ID = 'test-key';

let app: Hono;
let jobsDbPath: string;
let vectorDbPath: string;
let privateKey: CryptoKey;
let strangerKey: CryptoKey;
const savedEnv: Record<string, string | undefined> = {};

function setEnv(name: string, value: string | undefined): void {
  if (!(name in savedEnv)) savedEnv[name] = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

beforeAll(async () => {
  jobsDbPath = join(tmpdir(), `browser-access-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  vectorDbPath = join(tmpdir(), `browser-access-vectors-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  setEnv('ARGUS_JOBS_DB_PATH', jobsDbPath);
  setEnv('ARGUS_VECTOR_DB_PATH', vectorDbPath);

  const signing = await generateKeyPair('ES256');
  privateKey = signing.privateKey;
  strangerKey = (await generateKeyPair('ES256')).privateKey;
  const publicJwk = { ...(await exportJWK(signing.publicKey)), kid: KEY_ID, alg: 'ES256', use: 'sig' };

  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url === JWKS_URL) {
      return new Response(JSON.stringify({ keys: [publicJwk] }), { headers: { 'content-type': 'application/json' } });
    }
    return new Response('not found', { status: 404 });
  }));

  const mod = await import('../src/server/http.js');
  app = mod.app;
});

afterAll(() => {
  vi.unstubAllGlobals();
  for (const [name, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  for (const p of [jobsDbPath, vectorDbPath]) {
    if (existsSync(p)) unlinkSync(p);
  }
});

beforeEach(() => {
  vi.clearAllMocks();
  setEnv('ARGUS_CORS_ORIGINS', `${ALLOWED_ORIGIN}, http://localhost:5173`);
  setEnv('SUPABASE_URL', SUPABASE_URL);
  setEnv('ARGUS_PLANS_OWNER_USER_ID', OWNER_ID);
  runPlan.mockResolvedValue({ text: 'done', tasks: { a: { status: 'completed', output: 'done' } } });
});

async function token(options: { sub?: string; expiresAt?: number; key?: CryptoKey; audience?: string } = {}): Promise<string> {
  return new SignJWT({ role: 'authenticated' })
    .setProtectedHeader({ alg: 'ES256', kid: KEY_ID })
    .setSubject(options.sub ?? OWNER_ID)
    .setIssuer(`${SUPABASE_URL}/auth/v1`)
    .setAudience(options.audience ?? 'authenticated')
    .setIssuedAt()
    .setExpirationTime(options.expiresAt ?? Math.floor(Date.now() / 1000) + 600)
    .sign(options.key ?? privateKey);
}

const PLAN = { plan: { thought: 't', tasks: [{ id: 'a', toolName: 'x', arguments: { prompt: 'hi' }, dependencies: [] }] } };

function postRunPlan(headers: Record<string, string> = {}) {
  return app.request('/task/run-plan', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(PLAN),
  });
}

function preflight(origin: string, path = '/task/run-plan') {
  return app.request(path, {
    method: 'OPTIONS',
    headers: {
      Origin: origin,
      'Access-Control-Request-Method': 'POST',
      'Access-Control-Request-Headers': 'content-type, authorization',
    },
  });
}

describe('live-notes routes share the browser gate', () => {
  const LIVE_NOTE_PATHS = [
    '/task/live-notes/tick',
    '/task/live-notes/00000000-0000-4000-8000-000000000004/run',
  ];

  function postLiveNotes(path: string, headers: Record<string, string> = {}) {
    return app.request(path, { method: 'POST', headers });
  }

  it.each(LIVE_NOTE_PATHS)('401s a browser request with no token on %s', async (path) => {
    const res = await postLiveNotes(path, { Origin: ALLOWED_ORIGIN });
    expect(res.status).toBe(401);
  });

  it.each(LIVE_NOTE_PATHS)('403s a browser request from another origin on %s', async (path) => {
    const res = await postLiveNotes(path, { Origin: 'https://evil.example', Authorization: `Bearer ${await token()}` });
    expect(res.status).toBe(403);
  });

  it.each(LIVE_NOTE_PATHS)('403s a token that is not the owner on %s', async (path) => {
    const res = await postLiveNotes(path, { Origin: ALLOWED_ORIGIN, Authorization: `Bearer ${await token({ sub: OTHER_ID })}` });
    expect(res.status).toBe(403);
  });

  it.each(LIVE_NOTE_PATHS)('lets the owner through to the handler on %s (503 here: no service role key)', async (path) => {
    setEnv('SUPABASE_SERVICE_ROLE_KEY', undefined);
    const res = await postLiveNotes(path, { Origin: ALLOWED_ORIGIN, Authorization: `Bearer ${await token()}` });
    expect(res.status).toBe(503);
    expect(res.headers.get('access-control-allow-origin')).toBe(ALLOWED_ORIGIN);
  });

  it.each(LIVE_NOTE_PATHS)('lets a local caller with no Origin through on %s (the timer)', async (path) => {
    setEnv('SUPABASE_SERVICE_ROLE_KEY', undefined);
    const res = await postLiveNotes(path);
    expect(res.status).toBe(503);
  });
});

describe('CORS on /task/run-plan', () => {
  it('passes preflight for an allow-listed origin and echoes it in ACAO', async () => {
    const res = await preflight(ALLOWED_ORIGIN);
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe(ALLOWED_ORIGIN);
    expect(res.headers.get('access-control-allow-headers')?.toLowerCase()).toContain('authorization');
    expect(res.headers.get('access-control-allow-methods')).toContain('POST');
  });

  it('accepts every origin in the comma-separated allow-list', async () => {
    const res = await preflight('http://localhost:5173');
    expect(res.headers.get('access-control-allow-origin')).toBe('http://localhost:5173');
  });

  it('refuses preflight from any other origin, with no ACAO', async () => {
    const res = await preflight('https://evil.example');
    expect(res.status).toBe(403);
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('refuses a request from a non-listed origin even with a valid owner token', async () => {
    const res = await postRunPlan({ Origin: 'https://evil.example', Authorization: `Bearer ${await token()}` });
    expect(res.status).toBe(403);
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
    expect(runPlan).not.toHaveBeenCalled();
  });

  it('refuses every origin when ARGUS_CORS_ORIGINS is unset (never *)', async () => {
    setEnv('ARGUS_CORS_ORIGINS', undefined);
    const res = await preflight(ALLOWED_ORIGIN);
    expect(res.status).toBe(403);
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('ignores a * entry in the allow-list', async () => {
    setEnv('ARGUS_CORS_ORIGINS', '*');
    const res = await preflight('https://evil.example');
    expect(res.status).toBe(403);
  });
});

describe('CORS on /health', () => {
  it('lets an allow-listed origin probe reachability without a token', async () => {
    const res = await app.request('/health', { headers: { Origin: ALLOWED_ORIGIN } });
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBe(ALLOWED_ORIGIN);
  });

  it('refuses another origin', async () => {
    const res = await app.request('/health', { headers: { Origin: 'https://evil.example' } });
    expect(res.status).toBe(403);
  });
});

describe('browser auth on /task/run-plan', () => {
  it('runs the plan for the owner, with ACAO on the response', async () => {
    const res = await postRunPlan({ Origin: ALLOWED_ORIGIN, Authorization: `Bearer ${await token()}` });
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBe(ALLOWED_ORIGIN);
    expect(await res.json()).toEqual({ text: 'done', tasks: { a: { status: 'completed', output: 'done' } } });
    expect(runPlan).toHaveBeenCalledTimes(1);
  });

  it('rejects a valid token for a different user with 403', async () => {
    const res = await postRunPlan({ Origin: ALLOWED_ORIGIN, Authorization: `Bearer ${await token({ sub: OTHER_ID })}` });
    expect(res.status).toBe(403);
    expect(res.headers.get('access-control-allow-origin')).toBe(ALLOWED_ORIGIN);
    expect(runPlan).not.toHaveBeenCalled();
  });

  it('rejects a browser request with no token with 401', async () => {
    const res = await postRunPlan({ Origin: ALLOWED_ORIGIN });
    expect(res.status).toBe(401);
    expect(runPlan).not.toHaveBeenCalled();
  });

  it('rejects an expired token with 401', async () => {
    const expired = await token({ expiresAt: Math.floor(Date.now() / 1000) - 60 });
    const res = await postRunPlan({ Origin: ALLOWED_ORIGIN, Authorization: `Bearer ${expired}` });
    expect(res.status).toBe(401);
    expect(runPlan).not.toHaveBeenCalled();
  });

  it('rejects a token signed by a key the project does not publish', async () => {
    const forged = await token({ key: strangerKey });
    const res = await postRunPlan({ Origin: ALLOWED_ORIGIN, Authorization: `Bearer ${forged}` });
    expect(res.status).toBe(401);
    expect(runPlan).not.toHaveBeenCalled();
  });

  it('rejects a token with the wrong audience', async () => {
    const res = await postRunPlan({ Origin: ALLOWED_ORIGIN, Authorization: `Bearer ${await token({ audience: 'anon' })}` });
    expect(res.status).toBe(401);
  });

  it('answers 503 to a browser request when the owner config is missing', async () => {
    setEnv('ARGUS_PLANS_OWNER_USER_ID', undefined);
    const res = await postRunPlan({ Origin: ALLOWED_ORIGIN, Authorization: `Bearer ${await token()}` });
    expect(res.status).toBe(503);
    expect(runPlan).not.toHaveBeenCalled();
  });

  it('leaves a non-browser call (no Origin) exactly as before: no token needed', async () => {
    setEnv('ARGUS_CORS_ORIGINS', undefined);
    setEnv('SUPABASE_URL', undefined);
    setEnv('ARGUS_PLANS_OWNER_USER_ID', undefined);
    const res = await postRunPlan();
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
    expect(runPlan).toHaveBeenCalledTimes(1);
  });

  it('does not ask non-browser routes for a token', async () => {
    const res = await app.request('/health');
    expect(res.status).toBe(200);
  });
});
