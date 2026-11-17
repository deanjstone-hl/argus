import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { runCheck } from '../poller.js'
import { COUNT_EVERY_MS, createD1Adapter, D1_FREE_LIMIT_BYTES, D1_QUERY_UNAVAILABLE, parseD1Databases, type D1AdapterOptions } from './d1.js'

vi.mock('../record-check.js', () => ({ recordCheck: vi.fn() }))

// The database's real storage analytics, read with the collector's own token
// on 2026-10-16 at 16:36 UTC, and its row counts in the shape of the D1 query
// API, read the same minute with wrangler because that token cannot query D1
// (see the fixture's note).
const fixture = (name: string) => JSON.parse(readFileSync(new URL(`../__fixtures__/${name}`, import.meta.url), 'utf8')) as Record<string, unknown>
const STORAGE = fixture('d1-storage-argus-watchtower.json')
const QUERY = fixture('d1-query-argus-watchtower.hand-built.json') as { tables: unknown; counts: unknown }
// The D1 query API's real refusal of that token.
const QUERY_AUTHZ = { result: null, success: false, errors: [{ code: 7403, message: 'The given account is not valid or is not authorized to access this service' }], messages: [] }

const NOW = Date.parse('2026-10-16T16:36:30Z')
const DATABASE = { name: 'argus-watchtower', id: '00000000-0000-4000-b000-000000000012' }

interface Call {
  url: string
  authorization: string | null
  body: { query?: string; variables?: Record<string, unknown>; sql?: string }
}

function cloudflare(queryBodies: unknown[] = [QUERY.tables, QUERY.counts], storage: unknown = STORAGE, queryStatus = 200) {
  const calls: Call[] = []
  const answers = [...queryBodies]
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    calls.push({ url, authorization: new Headers(init?.headers).get('authorization'), body: JSON.parse(String(init?.body)) })
    if (url.endsWith('/graphql')) return Response.json(storage)
    return Response.json(answers.length > 1 ? answers.shift() : answers[0], { status: queryStatus })
  }) as typeof fetch
  return { fetchImpl, calls }
}

function adapter(fetchImpl: typeof fetch, overrides: Partial<D1AdapterOptions> = {}, now = () => NOW) {
  return createD1Adapter({ accountId: 'account-1', token: 'cf-token', database: DATABASE, fetch: fetchImpl, now, ...overrides })
}

describe('D1 capacity adapter', () => {
  it('is one Cloudflare card per database, polled every five minutes', () => {
    const { fetchImpl } = cloudflare()
    const d1 = adapter(fetchImpl)
    expect([d1.key, d1.host, d1.intervalMs, d1.failureStatus]).toEqual(['d1:argus-watchtower', 'cloudflare', 300_000, 'unreachable'])
  })

  it('counts every user table and reports the size the count saw, against the Workers Free limit', async () => {
    const { fetchImpl, calls } = cloudflare()
    const result = await runCheck(adapter(fetchImpl))
    expect(result).toEqual({
      status: 'healthy',
      detail: {
        database: 'argus-watchtower',
        databaseId: DATABASE.id,
        sizeBytes: 36_880_384,
        sizeSource: 'query',
        limitBytes: D1_FREE_LIMIT_BYTES,
        tables: [
          { name: 'service_checks', rows: 59_525 },
          { name: 'service_checks_latest', rows: 14 },
        ],
        totalRows: 59_539,
        countedAt: '2026-10-16T16:36:30.000Z',
        rowsUnavailable: null,
        thresholds: { degradedAt: 0.8, downAt: 0.95 },
      },
    })
    const queries = calls.filter((call) => call.url.endsWith('/query'))
    expect(queries.map((call) => call.url)).toEqual([
      `https://api.cloudflare.com/client/v4/accounts/account-1/d1/database/${DATABASE.id}/query`,
      `https://api.cloudflare.com/client/v4/accounts/account-1/d1/database/${DATABASE.id}/query`,
    ])
    expect(queries[0]?.body.sql).toMatch(/FROM sqlite_master WHERE type = 'table'/)
    // Wrangler's and D1's own bookkeeping tables are not the database's rows.
    expect(queries[0]?.body.sql).toMatch(/_cf_/)
    expect(queries[0]?.body.sql).toMatch(/d1_migrations/)
    expect(queries[1]?.body.sql).toBe(
      `SELECT 'service_checks' AS name, count(*) AS row_count FROM "service_checks" UNION ALL SELECT 'service_checks_latest' AS name, count(*) AS row_count FROM "service_checks_latest"`,
    )
    expect(new Set(calls.map((call) => call.authorization))).toEqual(new Set(['Bearer cf-token']))
  })

  it('uses a separate query token when one is given', async () => {
    const { fetchImpl, calls } = cloudflare()
    await runCheck(adapter(fetchImpl, { queryToken: 'd1-token' }))
    expect(calls.filter((call) => call.url.endsWith('/query')).map((call) => call.authorization)).toEqual(['Bearer d1-token', 'Bearer d1-token'])
  })

  it('counts rows at most every six hours, since every count reads every row', async () => {
    const { fetchImpl, calls } = cloudflare()
    let now = NOW
    const d1 = adapter(fetchImpl, {}, () => now)
    await runCheck(d1)
    now += 5 * 60_000
    const second = await runCheck(d1)
    expect(calls.filter((call) => call.url.endsWith('/query'))).toHaveLength(2)
    expect(second.detail).toMatchObject({ totalRows: 59_539, countedAt: '2026-10-16T16:36:30.000Z', sizeSource: 'query' })
    now = NOW + COUNT_EVERY_MS + 1
    await runCheck(d1)
    expect(calls.filter((call) => call.url.endsWith('/query'))).toHaveLength(4)
  })

  it('falls back to the day’s analytics size and says why while the token cannot query D1', async () => {
    const { fetchImpl } = cloudflare([QUERY_AUTHZ], STORAGE, 403)
    const result = await runCheck(adapter(fetchImpl))
    expect(result.status).toBe('healthy')
    expect(result.detail).toMatchObject({
      sizeBytes: 332_271_600,
      sizeSource: 'analytics',
      tables: null,
      totalRows: null,
      countedAt: null,
      rowsUnavailable: D1_QUERY_UNAVAILABLE,
    })
  })

  it('asks GraphQL for this database’s storage since yesterday', async () => {
    const { fetchImpl, calls } = cloudflare([QUERY_AUTHZ], STORAGE, 403)
    await runCheck(adapter(fetchImpl))
    const graphql = calls.find((call) => call.url.endsWith('/graphql'))
    expect(graphql?.body.query).toMatch(/d1StorageAdaptiveGroups/)
    expect(graphql?.body.variables).toEqual({ account: 'account-1', database: DATABASE.id, since: '2026-10-15' })
  })

  it('degrades at 80% of the limit and goes down at 95%', async () => {
    const { fetchImpl } = cloudflare()
    expect((await runCheck(adapter(fetchImpl, { limitBytes: 40_000_000 }))).status).toBe('degraded')
    expect((await runCheck(adapter(fetchImpl, { limitBytes: 38_000_000 }))).status).toBe('down')
    expect((await runCheck(adapter(fetchImpl, { limitBytes: 46_200_000 }))).status).toBe('healthy')
  })

  it('is unreachable when neither source reports a size', async () => {
    const empty = { data: { viewer: { accounts: [{ d1StorageAdaptiveGroups: [] }] } }, errors: null }
    const { fetchImpl } = cloudflare([QUERY_AUTHZ], empty, 403)
    const result = await runCheck(adapter(fetchImpl))
    expect(result.status).toBe('unreachable')
    expect(result.detail).toEqual({ error: 'No size reported for D1 database argus-watchtower' })
  })
})

describe('parseD1Databases', () => {
  it('reads name:id pairs and refuses anything else', () => {
    expect(parseD1Databases(' argus-watchtower:615a , other:abc')).toEqual([
      { name: 'argus-watchtower', id: '615a' },
      { name: 'other', id: 'abc' },
    ])
    expect(parseD1Databases('')).toEqual([])
    expect(() => parseD1Databases('argus-watchtower')).toThrow('D1_DATABASES entry "argus-watchtower" is not name:id')
  })
})
