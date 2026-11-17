import type { AiUsageHostDetail } from '@argus/watchtower-contract'
import type { Adapter, HealthResult } from '../adapter.js'

const STALE_AFTER_MS = 24 * 60 * 60 * 1000

export interface CcusageDaily {
  period: string
  totalTokens: number
  totalCost: number
}

export interface CcusageOutput {
  daily: CcusageDaily[]
  totals: { totalTokens: number; totalCost: number }
}

export interface HostSource {
  name: string
  fetchUsage: () => Promise<CcusageOutput>
}

function latestPeriod(output: CcusageOutput): string | null {
  return output.daily.reduce<string | null>((latest, day) => {
    if (latest === null || day.period > latest) return day.period
    return latest
  }, null)
}

function isFresh(period: string | null, now: Date): boolean {
  if (period === null) return false
  const periodEnd = new Date(`${period}T23:59:59.999Z`).getTime()
  return now.getTime() - periodEnd <= STALE_AFTER_MS
}

// One host failing is part of the aggregate result, not a failed check: it
// marks that host unreachable and the others still report.
async function checkHost(host: HostSource, now: Date): Promise<AiUsageHostDetail> {
  try {
    const output = await host.fetchUsage()
    const period = latestPeriod(output)
    return {
      name: host.name,
      status: isFresh(period, now) ? 'healthy' : 'degraded',
      totalTokens: output.totals.totalTokens,
      totalCost: output.totals.totalCost,
      latestPeriod: period,
    }
  } catch (error) {
    return {
      name: host.name,
      status: 'unreachable',
      totalTokens: 0,
      totalCost: 0,
      latestPeriod: null,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

function overallStatus(hostResults: AiUsageHostDetail[]): HealthResult['status'] {
  if (hostResults.every((h) => h.status === 'unreachable')) return 'unreachable'
  if (hostResults.some((h) => h.status !== 'healthy')) return 'degraded'
  return 'healthy'
}

async function checkAiUsage(hosts: HostSource[], now: () => Date): Promise<HealthResult> {
  const hostResults = await Promise.all(hosts.map((host) => checkHost(host, now())))

  const totalTokens = hostResults.reduce((sum, h) => sum + h.totalTokens, 0)
  const totalCost = hostResults.reduce((sum, h) => sum + h.totalCost, 0)

  return {
    status: overallStatus(hostResults),
    detail: {
      totalTokens,
      totalCost,
      hosts: hostResults,
    },
  }
}

type FetchImpl = (url: string, init: { headers: Record<string, string> }) => Promise<Response>

export function createRemoteHostSource(
  name: string,
  url: string,
  token: string,
  fetchImpl: FetchImpl = fetch,
): HostSource {
  return {
    name,
    fetchUsage: async () => {
      const response = await fetchImpl(url, { headers: { Authorization: `Bearer ${token}` } })
      if (!response.ok) {
        throw new Error(`${url} returned ${response.status}`)
      }
      return (await response.json()) as CcusageOutput
    },
  }
}

export function createLocalHostSource(name: string, runCcusage: () => Promise<string>): HostSource {
  return {
    name,
    fetchUsage: async () => JSON.parse(await runCcusage()) as CcusageOutput,
  }
}

export function createAiUsageAdapter(
  hosts: HostSource[],
  options: { now?: () => Date; intervalMs?: number } = {},
): Adapter {
  const now = options.now ?? (() => new Date())
  const intervalMs = options.intervalMs ?? 300_000

  return {
    key: 'ai-usage',
    host: 'multi',
    intervalMs,
    check: () => checkAiUsage(hosts, now),
  }
}
