import type { HostMemoryDetail, HostPressure } from '@argus/watchtower-contract'
import type { HealthResult } from './adapter.js'

// Memory as Linux reports it, shared by homelab's own card and LNV-LGN5's
// (argus#682, argus#685). The parsers match watchtower-usage-shim's, which
// reads the same files on WSL2 but cannot be imported from here.

const KIB = 1024
// PSI, % of the last minute: `some` = at least one task stalled on memory,
// `full` = every task did.
const PRESSURE_SOME_DEGRADED = 10
const PRESSURE_FULL_DOWN = 10
const AVAILABLE_DEGRADED_RATIO = 0.1

export function parseMeminfo(text: string): Omit<HostMemoryDetail, 'pressure'> {
  const values = new Map<string, number>()
  for (const line of text.split('\n')) {
    const match = /^(\w+):\s+(\d+) kB$/.exec(line.trim())
    if (match) values.set(match[1] as string, Number(match[2]) * KIB)
  }
  const value = (key: string) => values.get(key) ?? 0
  return {
    totalBytes: value('MemTotal'),
    availableBytes: value('MemAvailable'),
    swapTotalBytes: value('SwapTotal'),
    swapFreeBytes: value('SwapFree'),
  }
}

export function parsePressure(text: string): HostMemoryDetail['pressure'] {
  const lines = new Map<string, HostPressure>()
  for (const line of text.split('\n')) {
    const match = /^(some|full) avg10=([\d.]+) avg60=([\d.]+) avg300=([\d.]+)/.exec(line.trim())
    if (match) lines.set(match[1] as string, { avg10: Number(match[2]), avg60: Number(match[3]), avg300: Number(match[4]) })
  }
  const some = lines.get('some')
  const full = lines.get('full')
  return some && full ? { some, full } : null
}

export function evaluateMemory(detail: HostMemoryDetail): HealthResult {
  const { pressure, availableBytes, totalBytes } = detail
  if (pressure !== null && pressure.full.avg60 >= PRESSURE_FULL_DOWN) return { status: 'down', detail }
  const stalled = pressure !== null && pressure.some.avg60 >= PRESSURE_SOME_DEGRADED
  const short = totalBytes > 0 && availableBytes / totalBytes < AVAILABLE_DEGRADED_RATIO
  return { status: stalled || short ? 'degraded' : 'healthy', detail }
}
