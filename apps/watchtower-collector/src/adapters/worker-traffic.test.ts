import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { PROBE_USER_AGENT } from './endpoints.js'
import {
  createWorkerTrafficAdapters,
  createWorkerTrafficSource,
  WORKER_ROUTES,
  ZONE_ANALYTICS_UNAVAILABLE,
  type WorkerTrafficSourceOptions,
} from './worker-traffic.js'

// Real Workers analytics for the account's last hour, and the zone query's
// real refusal, both read with the collector's own token on 2026-10-16 at
// 15:41 UTC. The zone statuses are hand-built, since that token cannot read
// them (see the fixture's note).
const fixture = (name: string) => JSON.parse(readFileSync(new URL(`../__fixtures__/${name}`, import.meta.url), 'utf8')) as unknown
const INVOCATIONS = fixture('cloudflare-invocations-1h.json')
const ZONE_AUTHZ = fixture('cloudflare-zone-authz.json')
const ZONE_STATUSES = fixture('cloudflare-zone-statuses.hand-built.json')

const NOW = Date.parse('2026-10-16T15:41:20Z')
const SCRIPTS = ['reader-api', 'argus-memory-mcp', 'argus-agent-email', 'argus-agent-email-mcp', 'argus-email', 'argus-vault-agent-relay', 'argus-watchtower-api']

interface Call {
  query: string
  variables: Record<string, unknown>
  authorization: string | null
}

function graphql(zoneBody: unknown, invocationsBody: unknown = INVOCATIONS) {
  const calls: Call[] = []
  const fetchImpl = (async (_input: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { query: string; variables: Record<string, unknown> }
    calls.push({ ...body, authorization: new Headers(init?.headers).get('authorization') })
    return Response.json(body.query.includes('zones(') ? zoneBody : invocationsBody)
  }) as typeof fetch
  return { fetchImpl, calls }
}

function adapters(zoneBody: unknown, overrides: Partial<WorkerTrafficSourceOptions> = {}, invocationsBody?: unknown) {
  const { fetchImpl, calls } = graphql(zoneBody, invocationsBody)
  const source = createWorkerTrafficSource({
    accountId: 'account-1',
    zoneId: 'zone-1',
    token: 'cf-token',
    fetch: fetchImpl,
    now: () => NOW,
    ...overrides,
  })
  const list = createWorkerTrafficAdapters(source, SCRIPTS)
  const get = (script: string) => {
    const found = list.find((adapter) => adapter.key === `worker-traffic:${script}`)
    if (!found) throw new Error(`no adapter for ${script}`)
    return found
  }
  return { list, get, calls }
}

describe('WORKER_ROUTES', () => {
  it('knows every Worker the collector watches, with the route from its wrangler config', () => {
    for (const script of SCRIPTS) expect(script in WORKER_ROUTES, script).toBe(true)
    expect(WORKER_ROUTES['argus-watchtower-api']).toEqual({ host: 'api.myargus.cc', pathPrefix: '/watchtower/', api: true })
    expect(WORKER_ROUTES['argus-agent-email']).toBeNull()
  })
})

describe('worker traffic, without zone analytics', () => {
  it('reports each Worker’s real invocations and says why HTTP status counts are missing', async () => {
    const { get } = adapters(ZONE_AUTHZ)
    const result = await get('argus-watchtower-api').check()
    expect(result).toEqual({
      status: 'healthy',
      detail: {
        script: 'argus-watchtower-api',
        windowMinutes: 60,
        api: true,
        route: 'api.myargus.cc/watchtower/*',
        invocations: { requests: 452, errors: 0, byStatus: { success: 452 } },
        http: null,
        httpUnavailable: ZONE_ANALYTICS_UNAVAILABLE,
        thresholds: {
          minRequests: 20,
          serverErrorRateDegraded: 0.02,
          serverErrorRateDown: 0.2,
          clientErrorRateDegraded: 0.1,
          minClientErrors: 10,
        },
      },
    })
  })

  it('names the missing permission', () => {
    expect(ZONE_ANALYTICS_UNAVAILABLE).toMatch(/Zone.*Analytics.*Read/)
  })

  it('counts a Worker with no traffic in the window as quiet, not failing', async () => {
    const result = await adapters(ZONE_AUTHZ).get('argus-agent-email').check()
    expect(result.status).toBe('healthy')
    expect(result.detail).toMatchObject({ route: null, invocations: { requests: 0, errors: 0, byStatus: {} }, httpUnavailable: 'Not routed over HTTP' })
  })

  it('judges server errors from script exceptions alone', async () => {
    const failing = {
      data: { viewer: { accounts: [{ workersInvocationsAdaptive: [
        { dimensions: { scriptName: 'argus-memory-mcp', status: 'success' }, sum: { requests: 70, errors: 0 } },
        { dimensions: { scriptName: 'argus-memory-mcp', status: 'scriptThrewException' }, sum: { requests: 30, errors: 30 } },
      ] }] } },
      errors: null,
    }
    const result = await adapters(ZONE_AUTHZ, {}, failing).get('argus-memory-mcp').check()
    expect(result.status).toBe('down')
    expect(result.detail).toMatchObject({ invocations: { requests: 100, errors: 30, byStatus: { success: 70, scriptThrewException: 30 } } })
  })

  it('is unavailable without a zone id, rather than querying an empty zone', async () => {
    const { get, calls } = adapters(ZONE_AUTHZ, { zoneId: undefined })
    expect((await get('argus-memory-mcp').check()).detail).toMatchObject({ httpUnavailable: 'CLOUDFLARE_ZONE_ID not set' })
    expect(calls.some((call) => call.query.includes('zones('))).toBe(false)
  })
})

describe('worker traffic, with zone analytics', () => {
  it('flags a run of 401s on an API Worker, the #675 failure', async () => {
    const result = await adapters(ZONE_STATUSES).get('argus-watchtower-api').check()
    expect(result.status).toBe('degraded')
    expect(result.detail).toMatchObject({ http: { requests: 510, clientErrors: 58, serverErrors: 0 }, httpUnavailable: null })
  })

  it('does not hold 4xx against a Worker that is not an API', async () => {
    const statuses = structuredClone(ZONE_STATUSES) as { data: { viewer: { zones: Array<Record<string, unknown>> } } }
    statuses.data.viewer.zones[0]!.argus_email = [
      { count: 10, dimensions: { edgeResponseStatus: 200 } },
      { count: 40, dimensions: { edgeResponseStatus: 403 } },
    ]
    expect((await adapters(statuses).get('argus-email').check()).status).toBe('healthy')
  })

  it('is degraded on a few 5xx and down when a fifth of requests fail', async () => {
    const statuses = (ok: number, failed: number) => ({
      data: { viewer: { zones: [{ argus_memory_mcp: [
        { count: ok, dimensions: { edgeResponseStatus: 200 } },
        { count: failed, dimensions: { edgeResponseStatus: 502 } },
      ] }] } },
      errors: null,
    })
    expect((await adapters(statuses(98, 2)).get('argus-memory-mcp').check()).status).toBe('degraded')
    expect((await adapters(statuses(99, 1)).get('argus-memory-mcp').check()).status).toBe('healthy')
    expect((await adapters(statuses(80, 20)).get('argus-memory-mcp').check()).status).toBe('down')
    // Too little traffic to call a rate down: one failure of three is degraded.
    expect((await adapters(statuses(2, 1)).get('argus-memory-mcp').check()).status).toBe('degraded')
  })

  it('asks the zone for each routed Worker’s host and path, leaving out the endpoint probes', async () => {
    const { get, calls } = adapters(ZONE_STATUSES)
    await get('argus-watchtower-api').check()
    const zone = calls.find((call) => call.query.includes('zones('))
    expect(zone?.query).toContain('argus_watchtower_api: httpRequestsAdaptiveGroups')
    expect(zone?.query).not.toContain('argus_agent_email:')
    expect(zone?.variables).toMatchObject({
      zone: 'zone-1',
      argus_watchtower_api: { clientRequestHTTPHost: 'api.myargus.cc', clientRequestPath_like: '/watchtower/%', userAgent_neq: PROBE_USER_AGENT },
      argus_memory_mcp: { clientRequestHTTPHost: 'memory.myargus.cc', userAgent_neq: PROBE_USER_AGENT },
    })
    expect(zone?.authorization).toBe('Bearer cf-token')
  })

  it('reads the last hour, from one query of each kind shared by every card in a poll', async () => {
    const { list, calls } = adapters(ZONE_STATUSES)
    await Promise.all(list.map((adapter) => adapter.check()))
    expect(calls).toHaveLength(2)
    const invocations = calls.find((call) => !call.query.includes('zones('))
    expect(invocations?.variables).toMatchObject({ account: 'account-1', since: '2026-10-16T14:41:20.000Z', until: '2026-10-16T15:41:20.000Z' })
  })
})

describe('worker traffic failures', () => {
  it('throws when Workers analytics itself fails, so the card is unreachable', async () => {
    const { list, get } = adapters(ZONE_AUTHZ, {}, { data: null, errors: [{ message: 'rate limited' }] })
    expect(list[0]?.failureStatus).toBe('unreachable')
    await expect(get('argus-memory-mcp').check()).rejects.toThrow(/rate limited/)
  })

  it('keeps the invocation counts when only the zone query fails for another reason', async () => {
    const result = await adapters({ data: null, errors: [{ message: 'timeout', extensions: { code: 'timeout' } }] }).get('argus-watchtower-api').check()
    expect(result.detail).toMatchObject({ http: null, httpUnavailable: 'Zone analytics failed: timeout' })
  })

  it('files the cards under cloudflare, every 5 minutes', () => {
    expect(adapters(ZONE_AUTHZ).list[0]).toMatchObject({ key: 'worker-traffic:reader-api', host: 'cloudflare', intervalMs: 300_000 })
  })
})
