import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { runCheck } from '../poller.js'
import { createSupabaseUsageAdapters, SUPABASE_EGRESS_UNAVAILABLE, SUPABASE_PLAN_LIMITS } from './supabase-usage.js'

vi.mock('../record-check.js', () => ({ recordCheck: vi.fn() }))

// Both projects' real Management API answers, 2026-10-16 ~16:35 UTC: the
// project, its organisation (on the free plan) and pg_database_size from the
// read-only SQL endpoint.
const CAPTURED = JSON.parse(readFileSync(new URL('../__fixtures__/supabase-usage.json', import.meta.url), 'utf8')) as {
  organization: { plan: string }
  projects: Record<string, unknown>
  sizes: Record<string, unknown>
}
const REFS = ['iyqhnvandyalaujyqbtj', 'centbxttgyenxtkknepx']
const MB = 1_000_000

interface Call {
  method: string
  path: string
  authorization: string | null
  body: unknown
}

function management(overrides: { plan?: string; sizeStatus?: number; sizes?: Record<string, unknown> } = {}) {
  const calls: Call[] = []
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input))
    calls.push({
      method: init?.method ?? 'GET',
      path: url.pathname,
      authorization: new Headers(init?.headers).get('authorization'),
      body: init?.body ? JSON.parse(String(init.body)) : null,
    })
    const [, , kind, id, ...rest] = url.pathname.split('/')
    if (kind === 'organizations') return Response.json({ ...CAPTURED.organization, plan: overrides.plan ?? CAPTURED.organization.plan })
    if (kind === 'projects' && rest.length === 0) return Response.json(CAPTURED.projects[id as string])
    if (overrides.sizeStatus) return Response.json({ message: 'Forbidden resource' }, { status: overrides.sizeStatus })
    return Response.json((overrides.sizes ?? CAPTURED.sizes)[id as string], { status: 201 })
  }) as typeof fetch
  const adapters = createSupabaseUsageAdapters({ token: 'sbp-token', refs: REFS, fetch: fetchImpl })
  return { adapters, calls }
}

describe('Supabase usage adapters', () => {
  it('is one card per project, polled every five minutes', () => {
    const { adapters } = management()
    expect(adapters.map((adapter) => [adapter.key, adapter.host, adapter.intervalMs, adapter.failureStatus])).toEqual([
      ['supabase-usage:iyqhnvandyalaujyqbtj', 'supabase', 300_000, 'unreachable'],
      ['supabase-usage:centbxttgyenxtkknepx', 'supabase', 300_000, 'unreachable'],
    ])
  })

  it('reports each database’s size against its free-plan limit, and says egress is not reported', async () => {
    const { adapters } = management()
    const [myargus, memory] = await Promise.all(adapters.map((adapter) => runCheck(adapter)))
    expect(myargus).toEqual({
      status: 'healthy',
      detail: {
        ref: 'iyqhnvandyalaujyqbtj',
        name: 'myargus',
        plan: 'free',
        dbSizeBytes: 108_465_299,
        dbLimitBytes: 500 * MB,
        egressBytes: null,
        egressLimitBytes: 5_000 * MB,
        egressUnavailable: SUPABASE_EGRESS_UNAVAILABLE,
        thresholds: { degradedAt: 0.8, downAt: 0.95 },
      },
    })
    expect(memory?.detail).toMatchObject({ name: 'claude-memory', dbSizeBytes: 32_369_811 })
  })

  it('measures size with a read-only query and reads nothing else from the database', async () => {
    const { adapters, calls } = management()
    await runCheck(adapters[0]!)
    expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual([
      'GET /v1/projects/iyqhnvandyalaujyqbtj',
      'GET /v1/organizations/dsxrmczmxtvfsbfmpahx',
      'POST /v1/projects/iyqhnvandyalaujyqbtj/database/query/read-only',
    ])
    expect(calls[2]?.body).toEqual({ query: 'select pg_database_size(current_database()) as bytes' })
    expect(new Set(calls.map((call) => call.authorization))).toEqual(new Set(['Bearer sbp-token']))
  })

  it('reads the project and its organisation once an hour, the size every poll', async () => {
    let now = 0
    const calls: Call[] = []
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input))
      calls.push({ method: init?.method ?? 'GET', path: url.pathname, authorization: null, body: null })
      const [, , kind, id, ...rest] = url.pathname.split('/')
      if (kind === 'organizations') return Response.json(CAPTURED.organization)
      if (rest.length === 0) return Response.json(CAPTURED.projects[id as string])
      return Response.json(CAPTURED.sizes[id as string], { status: 201 })
    }) as typeof fetch
    const [adapter] = createSupabaseUsageAdapters({ token: 't', refs: [REFS[0]!], fetch: fetchImpl, now: () => now })
    await runCheck(adapter!)
    now += 5 * 60_000
    await runCheck(adapter!)
    expect(calls.map((call) => call.path.split('/').pop())).toEqual(['iyqhnvandyalaujyqbtj', 'dsxrmczmxtvfsbfmpahx', 'read-only', 'read-only'])
    now += 3_600_000
    await runCheck(adapter!)
    expect(calls).toHaveLength(7)
  })

  it('degrades at 80% of the limit and goes down at 95%', async () => {
    const sized = (bytes: number) => management({ sizes: { iyqhnvandyalaujyqbtj: [{ bytes }] } }).adapters[0]!
    expect((await runCheck(sized(399 * MB))).status).toBe('healthy')
    expect((await runCheck(sized(400 * MB))).status).toBe('degraded')
    expect((await runCheck(sized(475 * MB))).status).toBe('down')
  })

  it('knows the pro plan’s limits and leaves an unknown plan’s limits empty', async () => {
    expect(SUPABASE_PLAN_LIMITS.pro).toEqual({ dbBytes: 8_000 * MB, egressBytes: 250_000 * MB })
    const result = await runCheck(management({ plan: 'enterprise' }).adapters[0]!)
    expect(result.status).toBe('healthy')
    expect(result.detail).toMatchObject({ plan: 'enterprise', dbLimitBytes: null, egressLimitBytes: null })
  })

  it('is unreachable when the size query is refused', async () => {
    const result = await runCheck(management({ sizeStatus: 403 }).adapters[0]!)
    expect(result).toEqual({ status: 'unreachable', detail: { error: 'Size query for iyqhnvandyalaujyqbtj returned 403' } })
  })
})
