import type {
  PrinterJobDetail,
  PrinterMarkerDetail,
  ScannerJobDetail,
} from '@argus/watchtower-contract'
import { list, num, row, rows, text } from '../fields'
import type { CardFormatter, DetailRow } from '../types'
import { formatAbsoluteTime, formatClockSkew, formatRelativeTime, pluralise } from '../units'

export function formatInkLevel(marker: PrinterMarkerDetail): string {
  if (marker.level === null) return 'unknown'
  return marker.low ? `${marker.level}% · low` : `${marker.level}%`
}

function jobRow(job: PrinterJobDetail, now: number): DetailRow {
  const pages = job.pages === null ? null : pluralise(job.pages, 'page')
  const age = job.at === null ? null : formatRelativeTime(job.at, now)
  return {
    label: job.name || `job ${job.id}`,
    value: [job.user, pages, job.state, age].filter(Boolean).join(' · '),
    ...(job.at === null ? {} : { title: formatAbsoluteTime(job.at) }),
  }
}

export const printerFormatter: CardFormatter = {
  id: 'printer',
  matches: (check) => check.service_key === 'printer',
  format: (_check, detail, now) => {
    const state = text(detail, 'state')
    const markers = list<PrinterMarkerDetail>(detail, 'markers')
    const reasons = list<string>(detail, 'reasons')
    const levels = markers.map((marker) => marker.level).filter((level): level is number => level !== null)
    const lowest = levels.length > 0 ? `lowest ink ${Math.min(...levels)}%` : null
    const skew = num(detail, 'clockSkewSeconds')
    const low = markers.filter((marker) => marker.low).map((marker) => `${marker.name} low`)
    return {
      title: 'Printer',
      summary: [state, lowest].filter(Boolean).join(' · ') || null,
      reason: text(detail, 'message') ?? (reasons.length > 0 ? reasons.join(', ') : low.join(', ') || state),
      rows: rows(row('Model', text(detail, 'model')), row('Printer clock', skew === null ? null : formatClockSkew(skew))),
      sections: [
        {
          title: 'Ink',
          rows: markers.map((marker) => ({
            label: marker.name,
            value: formatInkLevel(marker),
            swatch: marker.color,
            ...(marker.low ? { tone: 'warn' as const } : {}),
          })),
        },
        { title: 'Queue', rows: list<PrinterJobDetail>(detail, 'queue').map((job) => jobRow(job, now)), empty: 'empty' },
        { title: 'Recent jobs', rows: list<PrinterJobDetail>(detail, 'recentJobs').map((job) => jobRow(job, now)) },
      ],
    }
  },
}

function scanRow(scan: ScannerJobDetail, now: number): DetailRow {
  const pages = scan.images === null ? null : pluralise(scan.images, 'page')
  return {
    label: scan.at === null ? 'unknown time' : formatRelativeTime(scan.at, now),
    value: [pages, scan.state].filter(Boolean).join(' · '),
    ...(scan.at === null ? {} : { title: formatAbsoluteTime(scan.at) }),
  }
}

// Scans are listed by age: their job ids are UUIDs and say nothing.
export const scannerFormatter: CardFormatter = {
  id: 'scanner',
  matches: (check) => check.service_key === 'scanner',
  format: (_check, detail, now) => {
    const state = text(detail, 'state')
    const feeder = text(detail, 'adfState')
    const feederFault = feeder !== null && feeder !== 'empty' && feeder !== 'loaded'
    return {
      title: 'Scanner',
      summary: [state, feeder === null ? null : `feeder ${feeder}`].filter(Boolean).join(' · ') || null,
      reason: feederFault ? `Feeder: ${feeder}` : state === null ? null : `Scanner ${state}`,
      sections: [
        { title: 'Recent scans', rows: list<ScannerJobDetail>(detail, 'recentScans').map((scan) => scanRow(scan, now)), empty: 'none' },
      ],
    }
  },
}
