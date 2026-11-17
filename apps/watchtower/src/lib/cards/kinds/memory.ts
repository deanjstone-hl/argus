import type { HostPressure } from '@argus/watchtower-contract'
import { num, record, row, rows } from '../fields'
import type { CardFormatter } from '../types'
import { formatBytes } from '../units'

// Memory from /proc/meminfo and PSI: homelab's own and WSL2's on
// LNV-LGN5. Both are judged by the collector's memory.ts.

function pressureOf(detail: Record<string, unknown>): { some: HostPressure; full: HostPressure } | null {
  const pressure = record(detail, 'pressure')
  const some = pressure ? record(pressure, 'some') : null
  const full = pressure ? record(pressure, 'full') : null
  return some && full ? { some: some as HostPressure, full: full as HostPressure } : null
}

// Which memory each key is: homelab's own, or WSL2's on LNV-LGN5.
const TITLES: Record<string, string> = { 'homelab:memory': 'Memory', 'lnv-lgn5:memory': 'WSL2 memory' }

export const memoryFormatter: CardFormatter = {
  id: 'memory',
  matches: (check) => check.service_key in TITLES,
  format: (check, detail) => {
    const total = num(detail, 'totalBytes')
    const available = num(detail, 'availableBytes')
    const swapTotal = num(detail, 'swapTotalBytes')
    const swapFree = num(detail, 'swapFreeBytes')
    const pressure = pressureOf(detail)
    const availableText = total === null || available === null ? null : `${formatBytes(available)} of ${formatBytes(total)}`
    const stalled = pressure === null ? 0 : Math.max(pressure.some.avg60, pressure.full.avg60)
    return {
      title: TITLES[check.service_key],
      summary: availableText === null ? null : `${availableText} available`,
      reason: stalled >= 1 ? `Tasks stalled on memory ${Math.round(stalled)}% of the last minute` : availableText === null ? null : `Only ${availableText} available`,
      rows: rows(
        row('Available', availableText),
        row('Swap used', swapTotal === null || swapFree === null || swapTotal === 0 ? null : `${formatBytes(swapTotal - swapFree)} of ${formatBytes(swapTotal)}`),
        row('Pressure (1 min)', pressure === null ? null : `${Math.round(pressure.some.avg60)}% some · ${Math.round(pressure.full.avg60)}% full`),
      ),
    }
  },
}
