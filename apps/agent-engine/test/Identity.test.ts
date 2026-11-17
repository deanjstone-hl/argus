import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Hono } from 'hono';
import { createIdentityRoutes, loadIdentity, type IdentityState } from '../src/server/identity.js';

// The world these tests describe: an argus-config checkout with per-env
// directories, and a home dir whose ~/.claude/CLAUDE.md links into one of them,
// as install-wsl2.sh and install-homelab.sh leave it.
let root: string;
let home: string;

function writeIdentity(env: string, body: unknown): string {
  const dir = join(root, 'argus-config', 'envs', env);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'identity.json');
  writeFileSync(path, typeof body === 'string' ? body : JSON.stringify(body));
  return path;
}

function linkClaudeMd(env: string): void {
  const dir = join(root, 'argus-config', 'envs', env);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'CLAUDE.md'), '# composed\n');
  mkdirSync(join(home, '.claude'), { recursive: true });
  symlinkSync(join(dir, 'CLAUDE.md'), join(home, '.claude', 'CLAUDE.md'));
}

const AQUILA = { schema_version: 1, name: 'Aquila', persona: 'personas/aquila.md', environment: 'wsl2' };

function get(app: Hono, path: string) {
  return app.fetch(new Request(`http://localhost${path}`));
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'identity-test-'));
  home = join(root, 'home');
  mkdirSync(home);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('loadIdentity', () => {
  it('finds the identity beside the env whose CLAUDE.md ~/.claude/CLAUDE.md links to', () => {
    const path = writeIdentity('wsl2', AQUILA);
    linkClaudeMd('wsl2');

    const state = loadIdentity({ env: {}, homeDir: home });

    expect(state.identity).toEqual({ schemaVersion: 1, name: 'Aquila', environment: 'wsl2' });
    expect(state.source).toBe(path);
    expect(state.error).toBeNull();
  });

  it('reports no identity, without error, for an env that has none (homelab)', () => {
    writeIdentity('wsl2', AQUILA);
    linkClaudeMd('homelab');

    const state = loadIdentity({ env: {}, homeDir: home });

    expect(state.identity).toBeNull();
    expect(state.error).toBeNull();
  });

  it('reports no identity when ~/.claude/CLAUDE.md does not exist', () => {
    const state = loadIdentity({ env: {}, homeDir: home });
    expect(state.identity).toBeNull();
    expect(state.error).toBeNull();
  });

  it('ARGUS_IDENTITY_PATH names the file explicitly', () => {
    const path = writeIdentity('wsl2', { ...AQUILA, name: 'Lyra' });
    linkClaudeMd('homelab');

    const state = loadIdentity({ env: { ARGUS_IDENTITY_PATH: path }, homeDir: home });

    expect(state.identity?.name).toBe('Lyra');
    expect(state.source).toBe(path);
  });

  it('an explicit ARGUS_IDENTITY_PATH that does not exist is an error, not silence', () => {
    const state = loadIdentity({ env: { ARGUS_IDENTITY_PATH: join(root, 'nope.json') }, homeDir: home });
    expect(state.identity).toBeNull();
    expect(state.error).toMatch(/nope\.json/);
  });

  it('invalid JSON is an error naming the file', () => {
    const path = writeIdentity('wsl2', '{ not json');
    linkClaudeMd('wsl2');

    const state = loadIdentity({ env: {}, homeDir: home });

    expect(state.identity).toBeNull();
    expect(state.error).toContain(path);
  });

  it.each([
    ['a missing name', { schema_version: 1, persona: 'p.md', environment: 'wsl2' }],
    ['an unknown environment', { ...AQUILA, environment: 'mars' }],
    ['an unsupported schema_version', { ...AQUILA, schema_version: 2 }],
  ])('rejects %s', (_label, body) => {
    writeIdentity('wsl2', body);
    linkClaudeMd('wsl2');

    const state = loadIdentity({ env: {}, homeDir: home });

    expect(state.identity).toBeNull();
    expect(state.error).not.toBeNull();
  });
});

describe('identity routes', () => {
  const aquila: IdentityState = {
    identity: { schemaVersion: 1, name: 'Aquila', environment: 'wsl2' },
    source: '/x/identity.json',
    error: null,
  };
  const none: IdentityState = { identity: null, source: null, error: null };
  const broken: IdentityState = { identity: null, source: '/x/identity.json', error: 'invalid JSON' };

  it('GET /identity reports the name and environment', async () => {
    const res = await get(createIdentityRoutes(aquila), '/identity');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ name: 'Aquila', environment: 'wsl2', schema_version: 1 });
  });

  it('GET /identity is 404 when this deployment has no identity', async () => {
    const res = await get(createIdentityRoutes(none), '/identity');
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'no identity configured for this deployment' });
  });

  it('GET /identity is 500 with the reason when identity.json is broken', async () => {
    const res = await get(createIdentityRoutes(broken), '/identity');
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'invalid JSON' });
  });

  it('GET /deployments/:name addresses the deployment by name', async () => {
    const res = await get(createIdentityRoutes(aquila), '/deployments/Aquila');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ name: 'Aquila', environment: 'wsl2', schema_version: 1 });
  });

  it('GET /deployments/:name is 404 for any other name', async () => {
    const res = await get(createIdentityRoutes(aquila), '/deployments/Lyra');
    expect(res.status).toBe(404);
  });

  it('GET /deployments/:name never matches on environment', async () => {
    const res = await get(createIdentityRoutes(aquila), '/deployments/wsl2');
    expect(res.status).toBe(404);
  });

  it('GET /deployments lists deployments, filterable by environment', async () => {
    const app = createIdentityRoutes(aquila);
    expect(await (await get(app, '/deployments')).json()).toEqual({
      deployments: [{ name: 'Aquila', environment: 'wsl2', schema_version: 1 }],
    });
    expect(await (await get(app, '/deployments?environment=wsl2')).json()).toEqual({
      deployments: [{ name: 'Aquila', environment: 'wsl2', schema_version: 1 }],
    });
    expect(await (await get(app, '/deployments?environment=homelab')).json()).toEqual({ deployments: [] });
  });

  it('GET /deployments is empty when this deployment has no identity', async () => {
    const res = await get(createIdentityRoutes(none), '/deployments');
    expect(await res.json()).toEqual({ deployments: [] });
  });
});
