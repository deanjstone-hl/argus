import type {
  HostCrashDumpsDetail,
  HostDiskDetail,
  HostMemoryDetail,
  HostReport,
} from '@argus/watchtower-contract'
import { CheckError, type Adapter, type HealthResult } from '../adapter.js'
import { evaluateMemory } from '../memory.js'
import { evaluateMemoryReconcile } from '../memory-reconcile.js'
import { evaluateUnit } from '../systemd-unit.js'
import { createT3StaleAdapter } from '../t3-stale.js'
import { evaluateTimers } from '../timer-freshness.js'
import { createVaultSyncAdapters } from '../vault-sync.js'

// The LNV-LGN5 cards: the Windows laptop and the WSL2 inside it, read from
// the usage-shim's GET /host over the tailnet (argus#682). The shim reports
// raw facts; every threshold is here.

const HOST = 'lnv-lgn5'
// Shorter than every interval below, so the cards polled together share one
// request and the next poll always refetches.
const CACHE_MS = 30_000
const GB = 1024 ** 3

// C:: 90% matches homelab's disk card; under 10 GB free, one more WSL dump
// (2-6 GB each) fills it, as ten of them did on 2026-10-16.
const DISK_DEGRADED_PCT = 90
const DISK_DOWN_FREE_BYTES = 10 * GB
// A WSL dump means WSL crashed: worth seeing for a day. Past 10 GB they are
// a disk problem whatever their age.
const DUMP_RECENT_MS = 24 * 3_600_000
const DUMP_DEGRADED_BYTES = 10 * GB

export interface HostReportSourceOptions {
  url: string
  token: string
  fetch?: typeof fetch
  now?: () => number
}

export type HostReportSource = () => Promise<HostReport>

export function createHostReportSource(options: HostReportSourceOptions): HostReportSource {
  const fetchImpl = options.fetch ?? fetch
  const now = options.now ?? Date.now
  let cached: { at: number; report: Promise<HostReport> } | null = null

  async function fetchReport(): Promise<HostReport> {
    const response = await fetchImpl(options.url, {
      headers: { authorization: `Bearer ${options.token}` },
      signal: AbortSignal.timeout(15_000),
    })
    // It answered, so the laptop is awake: a refusal is a shim problem.
    if (!response.ok) throw new CheckError('degraded', `${options.url} returned ${response.status}`)
    return (await response.json()) as HostReport
  }

  return () => {
    if (cached && now() - cached.at < CACHE_MS) return cached.report
    const report = fetchReport()
    const entry = { at: now(), report }
    cached = entry
    report.catch(() => {
      if (cached === entry) cached = null
    })
    return report
  }
}

function checkDisk(report: HostReport): HealthResult {
  if (report.disk === null) throw new CheckError('degraded', 'C: is not mounted at /mnt/c on WSL2')
  const { totalBytes, freeBytes } = report.disk
  const pctUsed = Math.round(((totalBytes - freeBytes) / totalBytes) * 100)
  const detail: HostDiskDetail = { path: 'C:', totalBytes, freeBytes, pctUsed }
  const status = freeBytes < DISK_DOWN_FREE_BYTES ? 'down' : pctUsed >= DISK_DEGRADED_PCT ? 'degraded' : 'healthy'
  return { status, detail }
}

// Only WSL's own dumps are judged; Windows app dumps are shown, not counted.
function checkCrashDumps(report: HostReport, now: number): HealthResult {
  const detail: HostCrashDumpsDetail = report.crashDumps
  const wsl = detail.wsl
  if (wsl === null) throw new CheckError('degraded', 'the WSL crash-dump folder could not be read')
  const recent = wsl.newestAt !== null && now - Date.parse(wsl.newestAt) < DUMP_RECENT_MS
  return { status: recent || wsl.totalBytes >= DUMP_DEGRADED_BYTES ? 'degraded' : 'healthy', detail }
}

// Memory thresholds are shared with homelab's own card (memory.ts).
function checkMemory(report: HostReport): HealthResult {
  const detail: HostMemoryDetail = report.memory
  return evaluateMemory(detail)
}

function checkUnit(report: HostReport, unit: string): HealthResult {
  const entry = report.units[unit]
  if (!entry) throw new CheckError('down', `${unit} is not in the WSL2 host report`)
  return evaluateUnit('user', entry.unit, entry.triggers)
}

// The silent-failure parts are newer than the shim on the laptop may be.
function part<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new CheckError('degraded', `the WSL2 usage-shim does not report ${what}; redeploy it`)
  return value
}

function adapter(key: string, intervalMs: number, check: () => Promise<HealthResult>): Adapter {
  return { key: `${HOST}:${key}`, host: HOST, intervalMs, failureStatus: 'unreachable', check }
}

// memory-reconcile runs on WSL2 only, so its card is here and not on homelab.
// The T3 card is the WSL2 side of homelab's own, from the shim's t3-stale.py run.
export function createHostReportAdapters(
  source: HostReportSource,
  units: string[],
  now: () => number = Date.now,
  vaults: string[] = [],
): Adapter[] {
  return [
    adapter('disk:C:', 300_000, async () => checkDisk(await source())),
    adapter('crash-dumps', 300_000, async () => checkCrashDumps(await source(), now())),
    adapter('memory', 60_000, async () => checkMemory(await source())),
    ...units.map((unit) => adapter(`systemd:${unit}`, 60_000, async () => checkUnit(await source(), unit))),
    adapter('timers', 60_000, async () => evaluateTimers(HOST, part((await source()).timers, 'timers'), now())),
    adapter('memory-reconcile', 60_000, async () =>
      evaluateMemoryReconcile(part((await source()).memoryReconcile, 'the memory-reconcile heartbeat'), now()),
    ),
    ...createVaultSyncAdapters(
      HOST,
      vaults,
      async (name) => part((await source()).vaults, 'vault sync').find((vault) => vault.name === name),
      'unreachable',
    ),
    createT3StaleAdapter(HOST, async () => (await source()).t3Stale, 'unreachable'),
  ]
}
