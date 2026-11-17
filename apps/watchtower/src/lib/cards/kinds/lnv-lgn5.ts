import type { HostDumpDirReport } from '@argus/watchtower-contract'
import { num, record, row, rows } from '../fields'
import type { CardFormatter, DetailSection } from '../types'
import { formatAbsoluteTime, formatBytes, formatRelativeTime, pluralise } from '../units'

// LNV-LGN5: the Windows laptop and its WSL2, from the usage-shim's host
// report.

export const hostDiskFormatter: CardFormatter = {
  id: 'lnv-lgn5-disk',
  matches: (check) => check.service_key.startsWith('lnv-lgn5:disk:'),
  format: (check, detail) => {
    const drive = check.service_key.slice('lnv-lgn5:disk:'.length)
    const total = num(detail, 'totalBytes')
    const free = num(detail, 'freeBytes')
    const pctUsed = num(detail, 'pctUsed')
    return {
      title: drive,
      summary: free === null || total === null ? null : `${formatBytes(free)} free of ${formatBytes(total)}`,
      reason: free === null ? null : `Only ${formatBytes(free)} free on ${drive}${pctUsed === null ? '' : ` (${pctUsed}% used)`}`,
      rows: rows(
        row('Free', free === null ? null : formatBytes(free)),
        row('Used', pctUsed === null ? null : `${pctUsed}%`),
        row('Size', total === null ? null : formatBytes(total)),
      ),
    }
  },
}

function dumpSection(title: string, dir: HostDumpDirReport | null, now: number): DetailSection {
  if (dir === null) return { title, rows: [], empty: 'Could not be read' }
  if (dir.count === 0) return { title, rows: [], empty: 'None' }
  return {
    title,
    rows: rows(
      row('Dumps', `${dir.count} · ${formatBytes(dir.totalBytes)}`),
      dir.newestAt === null ? null : row('Newest', formatRelativeTime(dir.newestAt, now), { title: formatAbsoluteTime(dir.newestAt) }),
    ),
  }
}

export const crashDumpsFormatter: CardFormatter = {
  id: 'lnv-lgn5-crash-dumps',
  matches: (check) => check.service_key === 'lnv-lgn5:crash-dumps',
  format: (_check, detail, now) => {
    const wsl = record(detail, 'wsl') as HostDumpDirReport | null
    const windows = record(detail, 'windows') as HostDumpDirReport | null
    const wslCount = wsl?.count ?? 0
    const wslSummary = wsl === null ? null : wslCount === 0 ? 'no WSL crash dumps' : `${pluralise(wslCount, 'WSL crash dump')} · ${formatBytes(wsl.totalBytes)}`
    return {
      title: 'Crash dumps',
      summary: wslSummary,
      reason:
        wsl === null || wslCount === 0
          ? null
          : `${pluralise(wslCount, 'WSL crash dump')} (${formatBytes(wsl.totalBytes)})${wsl.newestAt === null ? '' : `, newest ${formatRelativeTime(wsl.newestAt, now)}`}`,
      sections: [dumpSection('WSL', wsl, now), dumpSection('Windows apps', windows, now)],
    }
  },
}
