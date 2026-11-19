import type { HealthStatus, WorkerTrafficDetail } from '@argus/watchtower-contract'
import type { Adapter } from '../adapter.js'
import { REGISTRY, type LinkId } from '../lib/links.js'
import type { LinkEntry } from '../lib/links-core.js'
import { PROBE_USER_AGENT } from './endpoints.js'

// Each Worker's error rates over the last hour, from Cloudflare's GraphQL
// Analytics API (argus#687). Two reads, each shared by every card in a poll:
//
// - Workers analytics (account): invocations by status, and the scripts'
//   own exceptions. Readable with the collector's existing token.
// - HTTP analytics (zone): edge response codes on each Worker's route, which
//   is where a 4xx shows. It needs Zone > Analytics: Read on the Argus zone; until
//   the token has it, each card says so and is judged on exceptions alone.
//
// The endpoint probes send their own user agent and are left out, or every
// API Worker's 4xx rate would include the probes' anonymous 401s.

const HOST = 'cloudflare'
const INTERVAL_MS = 300_000
// Shorter than the poll interval, so a poll's cards share one pair of reads.
const CACHE_MS = 60_000
const WINDOW_MINUTES = 60
const GRAPHQL_URL = 'https://api.cloudflare.com/client/v4/graphql'

const THRESHOLDS: WorkerTrafficDetail['thresholds'] = {
  // Below this many requests a rate is not called down.
  minRequests: 20,
  serverErrorRateDegraded: 0.02,
  serverErrorRateDown: 0.2,
  // API Workers only: a client holding a bad token gets 401s, not 5xx.
  clientErrorRateDegraded: 0.1,
  minClientErrors: 10,
}

export const ZONE_ANALYTICS_UNAVAILABLE = `The Cloudflare token cannot read zone analytics (needs Zone > Analytics: Read on ${REGISTRY.domain})`

interface WorkerRoute {
  host: string
  pathPrefix?: string
  // Its clients hold tokens: a run of 4xx is a credential failure.
  api: boolean
}

// The route of a Worker, from its links registry entry. An API or MCP Worker mounted on its
// bucket's shared host (api., mcp.) answers only under its own path, so it carries that path;
// a Worker with a host of its own answers the whole host.
function routeOf(id: LinkId, api: boolean): WorkerRoute {
  const entries: readonly LinkEntry[] = REGISTRY.entries
  const entry = entries.find((candidate) => candidate.id === id)
  if (!entry?.host || entry.status === 'retired') throw new Error(`links.json has no live host for ${id}`)
  const route: WorkerRoute = { host: entry.host, api }
  const mount = (entry.path ?? '').replace(/\/+$/, '')
  if (mount !== '' && entry.host === `${entry.bucket}.${REGISTRY.domain}`) route.pathPrefix = `${mount}/`
  return route
}

// Each Worker's route, by script name. Null: it has no HTTP route (argus-agent-email only
// receives Email Routing events). A script with no entry here is reported as having no
// known route, which is how a retired Worker still listed in CLOUDFLARE_WORKER_PROJECTS reads.
export const WORKER_ROUTES: Record<string, WorkerRoute | null> = {
  'argus-watchtower-api': routeOf('watchtower-api', true),
  'argus-memory-mcp': routeOf('memory', true),
  'argus-agent-email-mcp': routeOf('email-mcp', true),
  'argus-email': routeOf('mail', false),
  'reader-api': routeOf('reader-api', true),
  'argus-agent-email': null,
}

type Invocations = WorkerTrafficDetail['invocations']
type HttpCounts = NonNullable<WorkerTrafficDetail['http']>

export interface WorkerTraffic {
  invocations: Map<string, Invocations>
  // Per routed script, or why there are no zone counts at all.
  http: Map<string, HttpCounts> | { unavailable: string }
}

export type WorkerTrafficSource = () => Promise<WorkerTraffic>

export interface WorkerTrafficSourceOptions {
  accountId: string
  zoneId: string | undefined
  token: string
  scripts?: string[]
  fetch?: typeof fetch
  now?: () => number
}

interface GraphqlError {
  message: string
  extensions?: { code?: string }
}

interface GraphqlBody<T> {
  data: T | null
  errors: GraphqlError[] | null
}

interface InvocationRow {
  dimensions: { scriptName: string; status: string }
  sum: { requests: number; errors: number }
}

interface StatusRow {
  count: number
  dimensions: { edgeResponseStatus: number }
}

// A GraphQL alias: letters, digits and underscores.
const alias = (script: string) => script.replace(/[^A-Za-z0-9_]/g, '_')

function routeText(route: WorkerRoute): string {
  return `${route.host}${route.pathPrefix ? `${route.pathPrefix}*` : ''}`
}

export function createWorkerTrafficSource(options: WorkerTrafficSourceOptions): WorkerTrafficSource {
  const fetchImpl = options.fetch ?? fetch
  const now = options.now ?? Date.now
  let cached: { at: number; traffic: Promise<WorkerTraffic> } | null = null

  async function graphql<T>(query: string, variables: Record<string, unknown>): Promise<GraphqlBody<T>> {
    const response = await fetchImpl(GRAPHQL_URL, {
      method: 'POST',
      headers: { authorization: `Bearer ${options.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(15_000),
    })
    if (!response.ok) throw new Error(`Cloudflare GraphQL returned ${response.status}`)
    return (await response.json()) as GraphqlBody<T>
  }

  async function readInvocations(since: string, until: string): Promise<Map<string, Invocations>> {
    const body = await graphql<{ viewer: { accounts: Array<{ workersInvocationsAdaptive: InvocationRow[] }> } }>(
      `query($account: String!, $since: Time!, $until: Time!) {
        viewer { accounts(filter: { accountTag: $account }) {
          workersInvocationsAdaptive(limit: 1000, filter: { datetime_geq: $since, datetime_leq: $until }) {
            sum { requests errors } dimensions { scriptName status }
          }
        } }
      }`,
      { account: options.accountId, since, until },
    )
    if (body.errors?.length || !body.data) {
      throw new Error(`Workers analytics failed: ${body.errors?.map((error) => error.message).join('; ') ?? 'no data'}`)
    }
    const totals = new Map<string, Invocations>()
    for (const row of body.data.viewer.accounts[0]?.workersInvocationsAdaptive ?? []) {
      const entry = totals.get(row.dimensions.scriptName) ?? { requests: 0, errors: 0, byStatus: {} }
      entry.requests += row.sum.requests
      entry.errors += row.sum.errors
      entry.byStatus[row.dimensions.status] = (entry.byStatus[row.dimensions.status] ?? 0) + row.sum.requests
      totals.set(row.dimensions.scriptName, entry)
    }
    return totals
  }

  async function readHttp(since: string, until: string): Promise<WorkerTraffic['http']> {
    if (!options.zoneId) return { unavailable: 'CLOUDFLARE_ZONE_ID not set' }
    const routed = (options.scripts ?? Object.keys(WORKER_ROUTES)).flatMap((script) => {
      const route = WORKER_ROUTES[script]
      return route ? [{ script, route }] : []
    })
    if (routed.length === 0) return new Map()

    const variables: Record<string, unknown> = { zone: options.zoneId }
    for (const { script, route } of routed) {
      variables[alias(script)] = {
        datetime_geq: since,
        datetime_leq: until,
        clientRequestHTTPHost: route.host,
        ...(route.pathPrefix ? { clientRequestPath_like: `${route.pathPrefix}%` } : {}),
        userAgent_neq: PROBE_USER_AGENT,
      }
    }
    const declarations = routed.map(({ script }) => `$${alias(script)}: ZoneHttpRequestsAdaptiveGroupsFilter_InputObject!`).join(', ')
    const fields = routed
      .map(({ script }) => `${alias(script)}: httpRequestsAdaptiveGroups(limit: 100, filter: $${alias(script)}) { count dimensions { edgeResponseStatus } }`)
      .join('\n')

    const body = await graphql<{ viewer: { zones: Array<Record<string, StatusRow[]>> } }>(
      `query($zone: String!, ${declarations}) { viewer { zones(filter: { zoneTag: $zone }) { ${fields} } } }`,
      variables,
    )
    if (body.errors?.length || !body.data) {
      if (body.errors?.some((error) => error.extensions?.code === 'authz')) return { unavailable: ZONE_ANALYTICS_UNAVAILABLE }
      return { unavailable: `Zone analytics failed: ${body.errors?.map((error) => error.message).join('; ') ?? 'no data'}` }
    }

    const zone = body.data.viewer.zones[0] ?? {}
    const counts = new Map<string, HttpCounts>()
    for (const { script } of routed) {
      const entry: HttpCounts = { requests: 0, clientErrors: 0, serverErrors: 0 }
      for (const row of zone[alias(script)] ?? []) {
        entry.requests += row.count
        const status = row.dimensions.edgeResponseStatus
        if (status >= 400 && status < 500) entry.clientErrors += row.count
        if (status >= 500) entry.serverErrors += row.count
      }
      counts.set(script, entry)
    }
    return counts
  }

  async function read(): Promise<WorkerTraffic> {
    const until = new Date(now()).toISOString()
    const since = new Date(now() - WINDOW_MINUTES * 60_000).toISOString()
    // A failed zone read only costs the HTTP counts; a failed Workers read
    // is the whole card's.
    const [invocations, http] = await Promise.all([
      readInvocations(since, until),
      readHttp(since, until).catch((error: unknown) => ({
        unavailable: `Zone analytics failed: ${error instanceof Error ? error.message : String(error)}`,
      })),
    ])
    return { invocations, http }
  }

  return () => {
    if (cached && now() - cached.at < CACHE_MS) return cached.traffic
    const traffic = read()
    const entry = { at: now(), traffic }
    cached = entry
    traffic.catch(() => {
      if (cached === entry) cached = null
    })
    return traffic
  }
}

function judge(detail: WorkerTrafficDetail): HealthStatus {
  const { invocations, http, thresholds } = detail
  const requests = http?.requests ?? invocations.requests
  const serverErrors = Math.max(http?.serverErrors ?? 0, invocations.errors)
  const serverRate = requests > 0 ? serverErrors / requests : 0
  if (requests >= thresholds.minRequests && serverRate >= thresholds.serverErrorRateDown) return 'down'
  if (serverErrors > 0 && serverRate >= thresholds.serverErrorRateDegraded) return 'degraded'
  if (detail.api && http !== null && http.clientErrors >= thresholds.minClientErrors && http.clientErrors / http.requests >= thresholds.clientErrorRateDegraded) {
    return 'degraded'
  }
  return 'healthy'
}

export function createWorkerTrafficAdapters(source: WorkerTrafficSource, scripts: string[]): Adapter[] {
  return scripts.map((script) => ({
    key: `worker-traffic:${script}`,
    host: HOST,
    intervalMs: INTERVAL_MS,
    failureStatus: 'unreachable',
    check: async () => {
      const traffic = await source()
      const route = WORKER_ROUTES[script]
      const known = script in WORKER_ROUTES
      const http = route && !('unavailable' in traffic.http) ? (traffic.http.get(script) ?? null) : null
      const httpUnavailable =
        route === null
          ? 'Not routed over HTTP'
          : !known || route === undefined
            ? 'No route known for this Worker'
            : 'unavailable' in traffic.http
              ? traffic.http.unavailable
              : null
      const detail: WorkerTrafficDetail = {
        script,
        windowMinutes: WINDOW_MINUTES,
        api: route?.api ?? false,
        route: route ? routeText(route) : null,
        invocations: traffic.invocations.get(script) ?? { requests: 0, errors: 0, byStatus: {} },
        http,
        httpUnavailable,
        thresholds: THRESHOLDS,
      }
      return { status: judge(detail), detail }
    },
  }))
}
