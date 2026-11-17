import type { CapacityThresholds, D1Detail, D1TableDetail, HealthStatus } from '@argus/watchtower-contract'
import type { Adapter } from '../adapter.js'

// A D1 database's size against its plan limit, and the rows in each of its
// tables (argus#688). Two sources:
//
// - GraphQL analytics (d1StorageAdaptiveGroups): the day's largest size.
//   Readable with the collector's existing token, but it lags: a database
//   pruned this morning still shows yesterday's peak.
// - The D1 query API: the tables' row counts, and the database's size as of
//   that query. It needs Account > D1: Read on the token; until then the
//   card says so and shows the analytics size.
//
// count(*) reads every row, and rows read are billed (Workers Free allows
// 5M a day), so the counts are refreshed every six hours, not every poll.

const HOST = 'cloudflare'
const INTERVAL_MS = 300_000
const API = 'https://api.cloudflare.com/client/v4'
export const COUNT_EVERY_MS = 6 * 3_600_000

// A database's size limit on Workers Free; Workers Paid allows 10 GB.
export const D1_FREE_LIMIT_BYTES = 500 * 1_000_000
const THRESHOLDS: CapacityThresholds = { degradedAt: 0.8, downAt: 0.95 }

export const D1_QUERY_UNAVAILABLE = 'The Cloudflare token cannot query D1 (needs Account > D1: Read)'

// SQLite's own tables, Cloudflare's (_cf_KV) and wrangler's migrations log.
const TABLES_SQL = `SELECT name FROM sqlite_master WHERE type = 'table' AND substr(name, 1, 7) <> 'sqlite_' AND substr(name, 1, 4) <> '_cf_' AND name <> 'd1_migrations' ORDER BY name`

export interface D1Database {
  name: string
  id: string
}

// `name:id,name:id`, as D1_DATABASES.
export function parseD1Databases(value: string | undefined): D1Database[] {
  return (value ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const [name, id] = entry.split(':').map((part) => part.trim())
      if (!name || !id) throw new Error(`D1_DATABASES entry "${entry}" is not name:id`)
      return { name, id }
    })
}

export interface D1AdapterOptions {
  accountId: string
  // Reads GraphQL analytics, and D1 too when no queryToken is given.
  token: string
  queryToken?: string
  database: D1Database
  limitBytes?: number
  fetch?: typeof fetch
  now?: () => number
}

interface QueryResult<Row> {
  results: Row[]
  meta?: { size_after?: number }
}

interface QueryBody<Row> {
  result: Array<QueryResult<Row>> | null
  success: boolean
  errors: Array<{ code: number; message: string }>
}

interface StorageBody {
  data: { viewer: { accounts: Array<{ d1StorageAdaptiveGroups: Array<{ max: { databaseSizeBytes: number } }> }> } } | null
  errors: Array<{ message: string }> | null
}

interface Count {
  at: number
  tables: D1TableDetail[]
  sizeBytes: number | null
}

// Authentication (10000) and authorisation (7403) refusals mean the token
// lacks the scope; anything else is a real failure worth its own message.
const SCOPE_ERRORS = new Set([7403, 10000])

class ScopeError extends Error {}

const quoteIdentifier = (name: string) => `"${name.replace(/"/g, '""')}"`
const quoteText = (name: string) => `'${name.replace(/'/g, "''")}'`

function judge(sizeBytes: number, limitBytes: number): HealthStatus {
  const used = sizeBytes / limitBytes
  if (used >= THRESHOLDS.downAt) return 'down'
  if (used >= THRESHOLDS.degradedAt) return 'degraded'
  return 'healthy'
}

export function createD1Adapter(options: D1AdapterOptions): Adapter {
  const fetchImpl = options.fetch ?? fetch
  const now = options.now ?? Date.now
  const limitBytes = options.limitBytes ?? D1_FREE_LIMIT_BYTES
  const { database } = options
  let lastCount: Count | null = null

  async function query<Row>(sql: string): Promise<QueryResult<Row>> {
    const response = await fetchImpl(`${API}/accounts/${options.accountId}/d1/database/${database.id}/query`, {
      method: 'POST',
      headers: { authorization: `Bearer ${options.queryToken ?? options.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ sql }),
      signal: AbortSignal.timeout(15_000),
    })
    const body = (await response.json()) as QueryBody<Row>
    if (!body.success || !body.result?.[0]) {
      if (body.errors?.some((error) => SCOPE_ERRORS.has(error.code))) throw new ScopeError(D1_QUERY_UNAVAILABLE)
      throw new Error(`D1 query returned ${response.status}: ${body.errors?.map((error) => error.message).join('; ') || 'no result'}`)
    }
    return body.result[0]
  }

  async function count(): Promise<Count> {
    const tables = await query<{ name: string }>(TABLES_SQL)
    if (tables.results.length === 0) return { at: now(), tables: [], sizeBytes: tables.meta?.size_after ?? null }
    const counts = await query<{ name: string; row_count: number }>(
      tables.results
        .map(({ name }) => `SELECT ${quoteText(name)} AS name, count(*) AS row_count FROM ${quoteIdentifier(name)}`)
        .join(' UNION ALL '),
    )
    return {
      at: now(),
      tables: counts.results.map((row) => ({ name: row.name, rows: row.row_count })),
      sizeBytes: counts.meta?.size_after ?? tables.meta?.size_after ?? null,
    }
  }

  async function analyticsSize(): Promise<number | null> {
    const since = new Date(now() - 86_400_000).toISOString().slice(0, 10)
    const response = await fetchImpl(`${API}/graphql`, {
      method: 'POST',
      headers: { authorization: `Bearer ${options.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        query: `query($account: String!, $database: String!, $since: Date!) {
          viewer { accounts(filter: { accountTag: $account }) {
            d1StorageAdaptiveGroups(limit: 2, filter: { databaseId: $database, date_geq: $since }, orderBy: [date_DESC]) {
              max { databaseSizeBytes } dimensions { date }
            }
          } }
        }`,
        variables: { account: options.accountId, database: database.id, since },
      }),
      signal: AbortSignal.timeout(15_000),
    })
    if (!response.ok) throw new Error(`Cloudflare GraphQL returned ${response.status}`)
    const body = (await response.json()) as StorageBody
    if (body.errors?.length || !body.data) {
      throw new Error(`D1 storage analytics failed: ${body.errors?.map((error) => error.message).join('; ') ?? 'no data'}`)
    }
    return body.data.viewer.accounts[0]?.d1StorageAdaptiveGroups[0]?.max.databaseSizeBytes ?? null
  }

  async function check() {
    let rowsUnavailable: string | null = null
    if (lastCount === null || now() - lastCount.at > COUNT_EVERY_MS) {
      try {
        lastCount = await count()
      } catch (error) {
        if (!(error instanceof ScopeError)) throw error
        rowsUnavailable = error.message
        lastCount = null
      }
    }

    const counted = lastCount
    const sizeFromQuery = counted?.sizeBytes ?? null
    const sizeBytes = sizeFromQuery ?? (await analyticsSize())
    if (sizeBytes === null) throw new Error(`No size reported for D1 database ${database.name}`)

    const detail: D1Detail = {
      database: database.name,
      databaseId: database.id,
      sizeBytes,
      sizeSource: sizeFromQuery !== null ? 'query' : 'analytics',
      limitBytes,
      tables: counted?.tables ?? null,
      totalRows: counted ? counted.tables.reduce((sum, table) => sum + table.rows, 0) : null,
      countedAt: counted ? new Date(counted.at).toISOString() : null,
      rowsUnavailable,
      thresholds: THRESHOLDS,
    }
    return { status: judge(sizeBytes, limitBytes), detail }
  }

  return {
    key: `d1:${database.name}`,
    host: HOST,
    intervalMs: INTERVAL_MS,
    failureStatus: 'unreachable',
    check,
  }
}
