import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test'
import { HEALTH_STATUSES } from '@argus/watchtower-contract'
import { exportJWK, generateKeyPair, SignJWT, type JWK, type KeyLike } from 'jose'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import worker from '../src/worker/index'

const TEST_COLLECTOR_TOKEN = 'test-collector-token'
const TEST_SUPABASE_URL = 'https://test-project.supabase.co'
const TEST_ISSUER = `${TEST_SUPABASE_URL}/auth/v1`
const TEST_JWKS_URL = `${TEST_ISSUER}/.well-known/jwks.json`
const TEST_KEY_ID = 'test-es256-key'

// The Worker verifies against the project's public JWKS, so the tests serve a
// local one over a stubbed fetch and sign tokens with the matching private key.
let signingKey: KeyLike
const realFetch = globalThis.fetch

beforeAll(async () => {
  const { publicKey, privateKey } = await generateKeyPair('ES256')
  signingKey = privateKey
  const publicJwk: JWK = { ...(await exportJWK(publicKey)), kid: TEST_KEY_ID, alg: 'ES256', use: 'sig' }

  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = input instanceof Request ? input.url : String(input)
    if (url === TEST_JWKS_URL) {
      return Response.json({ keys: [publicJwk] })
    }
    return realFetch(input, init)
  })
})

afterAll(() => {
  vi.restoreAllMocks()
})

beforeEach(async () => {
  await env.DB.exec('DELETE FROM service_checks')
  await env.DB.exec('DELETE FROM service_checks_latest')
  env.WATCHTOWER_COLLECTOR_TOKEN = TEST_COLLECTOR_TOKEN
})

interface SignOptions {
  exp?: number
  issuer?: string
  audience?: string
}

async function signTestJwt(options: SignOptions = {}): Promise<string> {
  return new SignJWT({ sub: 'test-user' })
    .setProtectedHeader({ alg: 'ES256', kid: TEST_KEY_ID })
    .setIssuedAt()
    .setIssuer(options.issuer ?? TEST_ISSUER)
    .setAudience(options.audience ?? 'authenticated')
    .setExpirationTime(options.exp ?? '1h')
    .sign(signingKey)
}

// Supabase's legacy HS256 secret: tokens signed with it must no longer verify.
async function signHs256Jwt(): Promise<string> {
  return new SignJWT({ sub: 'test-user' })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setIssuer(TEST_ISSUER)
    .setAudience('authenticated')
    .setExpirationTime('1h')
    .sign(new TextEncoder().encode('legacy-hs256-secret'))
}

async function fetchWorker(path: string, init?: RequestInit, envOverrides: Partial<Env> = {}): Promise<Response> {
  const ctx = createExecutionContext()
  // wrangler types pins SUPABASE_URL to the deployed literal; the tests point the Worker at a local JWKS instead.
  const testEnv = { ...env, SUPABASE_URL: TEST_SUPABASE_URL, ...envOverrides } as unknown as Env
  const response = await worker.fetch(new Request(`https://api.myargus.cc/watchtower${path}`, init), testEnv, ctx)
  await waitOnExecutionContext(ctx)
  return response
}

describe('POST /watchtower/checks', () => {
  it('rejects a missing bearer token', async () => {
    const res = await fetchWorker('/checks', {
      method: 'POST',
      body: JSON.stringify({ service_key: 'x', host: 'homelab', status: 'healthy' }),
    })
    expect(res.status).toBe(401)
  })

  it('rejects a wrong bearer token', async () => {
    const res = await fetchWorker('/checks', {
      method: 'POST',
      headers: { authorization: 'Bearer wrong-token' },
      body: JSON.stringify({ service_key: 'x', host: 'homelab', status: 'healthy' }),
    })
    expect(res.status).toBe(401)
  })

  // argus#574: with no WATCHTOWER_COLLECTOR_TOKEN provisioned the route used
  // to skip auth entirely. It now refuses everything, a header that happens to
  // match "Bearer undefined" or "Bearer " included.
  it.each([
    ['unset', undefined],
    ['empty', ''],
  ])('fails closed when the collector token is %s', async (_label, token) => {
    const headers: Array<Record<string, string>> = [
      {},
      { authorization: 'Bearer wrong-token' },
      { authorization: `Bearer ${TEST_COLLECTOR_TOKEN}` },
      { authorization: 'Bearer undefined' },
      { authorization: 'Bearer ' },
    ]
    for (const header of headers) {
      const res = await fetchWorker(
        '/checks',
        {
          method: 'POST',
          headers: header,
          body: JSON.stringify({ service_key: 'x', host: 'homelab', status: 'healthy' }),
        },
        { WATCHTOWER_COLLECTOR_TOKEN: token },
      )
      expect(res.status).toBe(401)
    }
    const { results } = await env.DB.prepare('SELECT 1 FROM service_checks_latest').all()
    expect(results).toEqual([])
  })

  it('rejects a malformed body', async () => {
    const res = await fetchWorker('/checks', {
      method: 'POST',
      headers: { authorization: `Bearer ${TEST_COLLECTOR_TOKEN}` },
      body: JSON.stringify({ service_key: 'x' }),
    })
    expect(res.status).toBe(400)
  })

  it.each(HEALTH_STATUSES)('accepts the shared contract status %s', async (status) => {
    const res = await fetchWorker('/checks', {
      method: 'POST',
      headers: { authorization: `Bearer ${TEST_COLLECTOR_TOKEN}` },
      body: JSON.stringify({ service_key: `status:${status}`, host: 'homelab', status }),
    })
    expect(res.status).toBe(204)
  })

  it.each([
    ['a status outside the contract', { service_key: 'x', host: 'homelab', status: 'unknown' }],
    ['an empty service_key', { service_key: '', host: 'homelab', status: 'healthy' }],
    ['an empty host', { service_key: 'x', host: '', status: 'healthy' }],
    ['a non-object detail', { service_key: 'x', host: 'homelab', status: 'healthy', detail: 'ok' }],
    ['a non-object body', ['x', 'homelab', 'healthy']],
  ])('rejects %s', async (_label, body) => {
    const res = await fetchWorker('/checks', {
      method: 'POST',
      headers: { authorization: `Bearer ${TEST_COLLECTOR_TOKEN}` },
      body: JSON.stringify(body),
    })
    expect(res.status).toBe(400)
  })

  it('accepts a valid check and server-generates id/checked_at, ignoring any client-supplied values', async () => {
    const res = await fetchWorker('/checks', {
      method: 'POST',
      headers: { authorization: `Bearer ${TEST_COLLECTOR_TOKEN}` },
      body: JSON.stringify({
        service_key: 'systemd:paperless',
        host: 'homelab',
        status: 'healthy',
        detail: { note: 'ok' },
        // Attempted client-supplied id/checked_at — must be ignored server-side.
        id: 'client-supplied-id',
        checked_at: '1970-01-01T00:00:00.000Z',
      }),
    })
    expect(res.status).toBe(204)

    const row = await env.DB.prepare('SELECT * FROM service_checks WHERE service_key = ?')
      .bind('systemd:paperless')
      .first<{ id: string; checked_at: string; detail: string }>()

    expect(row).toBeTruthy()
    expect(row?.id).not.toBe('client-supplied-id')
    expect(row?.checked_at).not.toBe('1970-01-01T00:00:00.000Z')
    expect(new Date(row!.checked_at).getTime()).toBeGreaterThan(Date.now() - 10_000)
    expect(JSON.parse(row!.detail)).toEqual({ note: 'ok' })
  })
})

describe('GET /watchtower/checks', () => {
  it('rejects a missing token', async () => {
    const res = await fetchWorker('/checks')
    expect(res.status).toBe(401)
  })

  it('rejects an invalid token', async () => {
    const res = await fetchWorker('/checks', { headers: { authorization: 'Bearer not-a-jwt' } })
    expect(res.status).toBe(401)
  })

  it('rejects an expired token', async () => {
    const token = await signTestJwt({ exp: Math.floor(Date.now() / 1000) - 60 })
    const res = await fetchWorker('/checks', { headers: { authorization: `Bearer ${token}` } })
    expect(res.status).toBe(401)
  })

  it('rejects an HS256 token, even with the right issuer', async () => {
    const token = await signHs256Jwt()
    const res = await fetchWorker('/checks', { headers: { authorization: `Bearer ${token}` } })
    expect(res.status).toBe(401)
  })

  it('rejects a token from the wrong issuer', async () => {
    const token = await signTestJwt({ issuer: 'https://other-project.supabase.co/auth/v1' })
    const res = await fetchWorker('/checks', { headers: { authorization: `Bearer ${token}` } })
    expect(res.status).toBe(401)
  })

  it('rejects a token for the wrong audience', async () => {
    const token = await signTestJwt({ audience: 'anon' })
    const res = await fetchWorker('/checks', { headers: { authorization: `Bearer ${token}` } })
    expect(res.status).toBe(401)
  })

  it('rejects an ES256 token signed by a key outside the JWKS', async () => {
    const { privateKey } = await generateKeyPair('ES256')
    const token = await new SignJWT({ sub: 'test-user' })
      .setProtectedHeader({ alg: 'ES256', kid: TEST_KEY_ID })
      .setIssuedAt()
      .setIssuer(TEST_ISSUER)
      .setAudience('authenticated')
      .setExpirationTime('1h')
      .sign(privateKey)
    const res = await fetchWorker('/checks', { headers: { authorization: `Bearer ${token}` } })
    expect(res.status).toBe(401)
  })

  it('returns only the latest row per service_key for a valid ES256 token', async () => {
    await postCheck({ service_key: 'systemd:paperless', host: 'homelab', status: 'down' })
    await postCheck({ service_key: 'homelab:disk:/', host: 'homelab', status: 'healthy' })
    await postCheck({ service_key: 'systemd:paperless', host: 'homelab', status: 'healthy', detail: { note: 'back' } })

    const token = await signTestJwt()
    const res = await fetchWorker('/checks', { headers: { authorization: `Bearer ${token}` } })
    expect(res.status).toBe(200)

    const body = (await res.json()) as Array<{ service_key: string; status: string; detail: unknown }>
    expect(body.map((c) => c.service_key)).toEqual(['homelab:disk:/', 'systemd:paperless'])
    const paperless = body.find((c) => c.service_key === 'systemd:paperless')
    expect(paperless?.status).toBe('healthy')
    expect(paperless?.detail).toEqual({ note: 'back' })
  })

  // GET /checks reads the latest-per-key table, never the history table, so
  // its cost is bounded by the number of service keys, not by row count.
  it('serves from service_checks_latest without touching the history table', async () => {
    await env.DB.prepare(
      'INSERT INTO service_checks_latest (service_key, host, status, detail, checked_at) VALUES (?, ?, ?, NULL, ?)',
    )
      .bind('systemd:only-latest', 'homelab', 'degraded', '2026-08-14T00:00:00.000Z')
      .run()

    const token = await signTestJwt()
    const res = await fetchWorker('/checks', { headers: { authorization: `Bearer ${token}` } })
    const body = (await res.json()) as Array<{ service_key: string; status: string }>
    expect(body).toEqual([
      { service_key: 'systemd:only-latest', host: 'homelab', status: 'degraded', detail: null, checked_at: '2026-08-14T00:00:00.000Z' },
    ])
  })
})

// argus#869: service_checks_latest has no TTL, so a unit the collector no
// longer checks would stay on the dashboard forever. GET /checks drops rows
// not checked in 3 days, but only while the collector is demonstrably alive
// (some row is newer than 3 days). If every row is older, the collector is
// what stopped, and the cards stay up so the client's Stale badge shows it.
describe('GET /watchtower/checks stale rows', () => {
  const DAY_MS = 24 * 60 * 60 * 1000

  async function seedLatest(serviceKey: string, ageMs: number): Promise<string> {
    const checkedAt = new Date(Date.now() - ageMs).toISOString()
    await env.DB.prepare(
      'INSERT INTO service_checks_latest (service_key, host, status, detail, checked_at) VALUES (?, ?, ?, NULL, ?)',
    )
      .bind(serviceKey, 'homelab', 'healthy', checkedAt)
      .run()
    return checkedAt
  }

  async function getKeys(): Promise<string[]> {
    const token = await signTestJwt()
    const res = await fetchWorker('/checks', { headers: { authorization: `Bearer ${token}` } })
    expect(res.status).toBe(200)
    const body = (await res.json()) as Array<{ service_key: string }>
    return body.map((c) => c.service_key)
  }

  it('drops a row last checked 4 days ago and keeps one checked 2 days ago, unchanged', async () => {
    await seedLatest('systemd:ghost.service', 4 * DAY_MS)
    const freshAt = await seedLatest('systemd:live.service', 2 * DAY_MS)

    const token = await signTestJwt()
    const res = await fetchWorker('/checks', { headers: { authorization: `Bearer ${token}` } })
    const body = await res.json()
    expect(body).toEqual([
      { service_key: 'systemd:live.service', host: 'homelab', status: 'healthy', detail: null, checked_at: freshAt },
    ])
  })

  it('leaves fresh rows alone', async () => {
    await seedLatest('a', 60 * 1000)
    await seedLatest('b', 2 * DAY_MS + 23 * 60 * 60 * 1000)
    expect(await getKeys()).toEqual(['a', 'b'])
  })

  it('keeps every row when all are older than 3 days, so a stopped collector stays visible', async () => {
    await seedLatest('a', 4 * DAY_MS)
    await seedLatest('b', 10 * DAY_MS)
    expect(await getKeys()).toEqual(['a', 'b'])
  })
})

describe('service_checks_latest maintenance', () => {
  it('records a status change in history and upserts the latest row for its key', async () => {
    await postCheck({ service_key: 'systemd:paperless', host: 'homelab', status: 'down' })
    await postCheck({ service_key: 'systemd:paperless', host: 'homelab-2', status: 'healthy' })

    expect(await historyCount('systemd:paperless')).toBe(2)

    const { results } = await env.DB.prepare('SELECT * FROM service_checks_latest').all<{
      service_key: string
      host: string
      status: string
      checked_at: string
    }>()
    expect(results).toHaveLength(1)
    expect(results[0]).toMatchObject({ service_key: 'systemd:paperless', host: 'homelab-2', status: 'healthy' })

    const newest = await env.DB.prepare('SELECT MAX(checked_at) AS t FROM service_checks').first<{ t: string }>()
    expect(results[0].checked_at).toBe(newest?.t)
  })

  // Nothing reads raw history (argus#844): a poll that repeats the previous
  // status and detail would only add a row to a table D1 never shrinks.
  it('writes no history row when status and detail repeat', async () => {
    const check = { service_key: 'systemd:paperless', host: 'homelab', status: 'healthy', detail: { activeState: 'active', restarts: 0 } }
    await postCheck(check)
    await postCheck(check)
    await postCheck(check)

    expect(await historyCount('systemd:paperless')).toBe(1)
  })

  it('writes no history row when a check with no detail repeats', async () => {
    const check = { service_key: 'homelab:disk:/', host: 'homelab', status: 'healthy' }
    await postCheck(check)
    await postCheck(check)

    expect(await historyCount('homelab:disk:/')).toBe(1)
  })

  it('writes a history row when the status changes', async () => {
    await postCheck({ service_key: 'systemd:paperless', host: 'homelab', status: 'healthy', detail: { note: 'ok' } })
    await postCheck({ service_key: 'systemd:paperless', host: 'homelab', status: 'down', detail: { note: 'ok' } })

    expect(await historyCount('systemd:paperless')).toBe(2)
  })

  it('writes a history row when the detail changes', async () => {
    await postCheck({ service_key: 'homelab:disk:/', host: 'homelab', status: 'healthy', detail: { usedPercent: 40 } })
    await postCheck({ service_key: 'homelab:disk:/', host: 'homelab', status: 'healthy', detail: { usedPercent: 41 } })

    expect(await historyCount('homelab:disk:/')).toBe(2)
  })

  it('writes a history row when detail appears or disappears', async () => {
    await postCheck({ service_key: 'homelab:disk:/', host: 'homelab', status: 'healthy' })
    await postCheck({ service_key: 'homelab:disk:/', host: 'homelab', status: 'healthy', detail: { usedPercent: 41 } })
    await postCheck({ service_key: 'homelab:disk:/', host: 'homelab', status: 'healthy' })

    expect(await historyCount('homelab:disk:/')).toBe(3)
  })

  it('compares each key with its own previous check only', async () => {
    await postCheck({ service_key: 'systemd:a', host: 'homelab', status: 'healthy' })
    await postCheck({ service_key: 'systemd:b', host: 'homelab', status: 'healthy' })
    await postCheck({ service_key: 'systemd:a', host: 'homelab', status: 'healthy' })

    expect(await historyCount('systemd:a')).toBe(1)
    expect(await historyCount('systemd:b')).toBe(1)
  })

  // The dashboard reads service_checks_latest, so its checked_at must keep
  // moving on every poll even though history stays quiet.
  it('still refreshes the latest row on every poll', async () => {
    const check = { service_key: 'systemd:paperless', host: 'homelab', status: 'healthy' }
    await postCheck(check)
    const first = await latestCheckedAt('systemd:paperless')

    await new Promise((resolve) => setTimeout(resolve, 5))
    await postCheck(check)
    const second = await latestCheckedAt('systemd:paperless')

    expect(second > first).toBe(true)
    expect(await historyCount('systemd:paperless')).toBe(1)
  })

  it('never replaces a newer latest row with an older one', async () => {
    const future = '2999-01-01T00:00:00.000Z'
    await env.DB.prepare(
      'INSERT INTO service_checks_latest (service_key, host, status, detail, checked_at) VALUES (?, ?, ?, NULL, ?)',
    )
      .bind('systemd:paperless', 'homelab', 'degraded', future)
      .run()

    await postCheck({ service_key: 'systemd:paperless', host: 'homelab', status: 'healthy' })

    const row = await env.DB.prepare('SELECT status, checked_at FROM service_checks_latest WHERE service_key = ?')
      .bind('systemd:paperless')
      .first<{ status: string; checked_at: string }>()
    expect(row).toEqual({ status: 'degraded', checked_at: future })
  })

  // Migration 0002 backfills the latest table from history already in D1.
  // Re-runs its backfill statement against fresh fixture rows to prove it
  // picks the newest row per key, breaking checked_at ties deterministically.
  it('backfills one latest row per key from existing history', async () => {
    const fixture = [
      ['a', 'systemd:paperless', 'down', '2026-08-14T00:00:00.000Z'],
      ['b', 'systemd:paperless', 'healthy', '2026-08-14T00:05:00.000Z'],
      ['c', 'homelab:disk:/', 'degraded', '2026-08-14T00:01:00.000Z'],
      ['d', 'homelab:disk:/', 'healthy', '2026-08-14T00:01:00.000Z'],
    ]
    for (const [id, serviceKey, status, checkedAt] of fixture) {
      await env.DB.prepare(
        'INSERT INTO service_checks (id, service_key, host, status, detail, checked_at) VALUES (?, ?, ?, ?, NULL, ?)',
      )
        .bind(id, serviceKey, 'homelab', status, checkedAt)
        .run()
    }

    const migration = env.TEST_MIGRATIONS.find((m) => m.name.startsWith('0002_'))
    const backfill = migration?.queries.find((q) => q.includes('INSERT INTO service_checks_latest'))
    expect(backfill).toBeTruthy()
    await env.DB.prepare(backfill!).run()

    const { results } = await env.DB.prepare(
      'SELECT service_key, status, checked_at FROM service_checks_latest ORDER BY service_key',
    ).all()
    expect(results).toEqual([
      { service_key: 'homelab:disk:/', status: 'healthy', checked_at: '2026-08-14T00:01:00.000Z' },
      { service_key: 'systemd:paperless', status: 'healthy', checked_at: '2026-08-14T00:05:00.000Z' },
    ])
  })
})

async function postCheck(body: Record<string, unknown>): Promise<void> {
  const res = await fetchWorker('/checks', {
    method: 'POST',
    headers: { authorization: `Bearer ${TEST_COLLECTOR_TOKEN}` },
    body: JSON.stringify(body),
  })
  expect(res.status).toBe(204)
}

async function historyCount(serviceKey: string): Promise<number> {
  const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM service_checks WHERE service_key = ?')
    .bind(serviceKey)
    .first<{ n: number }>()
  return row?.n ?? 0
}

async function latestCheckedAt(serviceKey: string): Promise<string> {
  const row = await env.DB.prepare('SELECT checked_at FROM service_checks_latest WHERE service_key = ?')
    .bind(serviceKey)
    .first<{ checked_at: string }>()
  return row!.checked_at
}
