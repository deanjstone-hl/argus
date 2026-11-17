import type { CapacityThresholds, HealthStatus, SupabaseUsageDetail } from '@argus/watchtower-contract'
import type { Adapter } from '../adapter.js'

// Each Supabase project's database size against its organisation's plan
// (argus#688), from the Management API with the PAT the project cards
// already use. Size is pg_database_size over the read-only SQL endpoint,
// which runs as supabase_read_only_user.
//
// Egress has no Management API endpoint: the dashboard's usage page reads
// a private billing API the PAT cannot reach. Until one exists the card
// carries the plan's egress limit and says the figure is not reported.

const HOST = 'supabase'
const INTERVAL_MS = 300_000
// The plan and project name change rarely; the size every poll.
const META_EVERY_MS = 3_600_000
const API = 'https://api.supabase.com/v1'
const MB = 1_000_000

const THRESHOLDS: CapacityThresholds = { degradedAt: 0.8, downAt: 0.95 }

// Per project database size, and egress per organisation per billing cycle
// (uncached; cached egress has its own equal allowance).
export const SUPABASE_PLAN_LIMITS: Record<string, { dbBytes: number; egressBytes: number }> = {
  free: { dbBytes: 500 * MB, egressBytes: 5_000 * MB },
  pro: { dbBytes: 8_000 * MB, egressBytes: 250_000 * MB },
}

export const SUPABASE_EGRESS_UNAVAILABLE = 'The Management API does not report egress'

export interface SupabaseUsageOptions {
  token: string
  refs: string[]
  fetch?: typeof fetch
  now?: () => number
}

interface Meta {
  at: number
  name: string
  plan: string | null
}

function judge(sizeBytes: number, limitBytes: number | null): HealthStatus {
  if (limitBytes === null) return 'healthy'
  const used = sizeBytes / limitBytes
  if (used >= THRESHOLDS.downAt) return 'down'
  if (used >= THRESHOLDS.degradedAt) return 'degraded'
  return 'healthy'
}

export function createSupabaseUsageAdapters(options: SupabaseUsageOptions): Adapter[] {
  const fetchImpl = options.fetch ?? fetch
  const now = options.now ?? Date.now
  const headers = { authorization: `Bearer ${options.token}` }

  async function getJson<T>(path: string): Promise<T> {
    const response = await fetchImpl(`${API}${path}`, { headers, signal: AbortSignal.timeout(15_000) })
    if (!response.ok) throw new Error(`${path} returned ${response.status}`)
    return (await response.json()) as T
  }

  return options.refs.map((ref): Adapter => {
    let meta: Meta | null = null

    async function readMeta(): Promise<Meta> {
      if (meta !== null && now() - meta.at < META_EVERY_MS) return meta
      const project = await getJson<{ name: string; organization_slug: string }>(`/projects/${ref}`)
      const organization = await getJson<{ plan?: string }>(`/organizations/${project.organization_slug}`)
      meta = { at: now(), name: project.name, plan: organization.plan ?? null }
      return meta
    }

    async function readSize(): Promise<number> {
      const response = await fetchImpl(`${API}/projects/${ref}/database/query/read-only`, {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify({ query: 'select pg_database_size(current_database()) as bytes' }),
        signal: AbortSignal.timeout(15_000),
      })
      if (!response.ok) throw new Error(`Size query for ${ref} returned ${response.status}`)
      const rows = (await response.json()) as Array<{ bytes: number | string }>
      const bytes = Number(rows[0]?.bytes)
      if (!Number.isFinite(bytes)) throw new Error(`Size query for ${ref} returned no size`)
      return bytes
    }

    async function check() {
      const { name, plan } = await readMeta()
      const dbSizeBytes = await readSize()
      const limits = plan === null ? undefined : SUPABASE_PLAN_LIMITS[plan]
      const detail: SupabaseUsageDetail = {
        ref,
        name,
        plan,
        dbSizeBytes,
        dbLimitBytes: limits?.dbBytes ?? null,
        egressBytes: null,
        egressLimitBytes: limits?.egressBytes ?? null,
        egressUnavailable: SUPABASE_EGRESS_UNAVAILABLE,
        thresholds: THRESHOLDS,
      }
      return { status: judge(dbSizeBytes, detail.dbLimitBytes), detail }
    }

    return { key: `supabase-usage:${ref}`, host: HOST, intervalMs: INTERVAL_MS, failureStatus: 'unreachable', check }
  })
}
