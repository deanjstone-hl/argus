import { afterPrefix, num, row, rows, text } from '../fields'
import type { CardFormatter } from '../types'
import { formatDuration, pluralise } from '../units'

const DISK_PREFIX = 'homelab:disk:'
const SUPABASE_PREFIX = 'supabase:'

export const diskFormatter: CardFormatter = {
  id: 'disk',
  matches: (check) => check.service_key.startsWith(DISK_PREFIX),
  format: (check, detail) => {
    const pctUsed = num(detail, 'pctUsed')
    const used = pctUsed === null ? null : `${pctUsed}% used`
    return {
      title: `Disk ${text(detail, 'path') ?? afterPrefix(check.service_key, DISK_PREFIX)}`,
      summary: used,
      reason: used,
    }
  },
}

// homelab's load average; the collector judges it against the
// 5-minute figure.
export const loadFormatter: CardFormatter = {
  id: 'load',
  matches: (check) => check.service_key === 'homelab:load',
  format: (_check, detail) => {
    const [load1, load5, load15] = ['load1', 'load5', 'load15'].map((key) => num(detail, key))
    const cpus = num(detail, 'cpus')
    const fixed = (value: number | null | undefined) => (value == null ? null : value.toFixed(2))
    const onCpus = cpus === null ? '' : ` on ${pluralise(cpus, 'CPU')}`
    return {
      title: 'Load',
      summary: load5 == null ? null : `${[load1, load5, load15].map(fixed).join(' · ')}${onCpus}`,
      reason: load5 == null ? null : `Load ${fixed(load5)} over 5 minutes${onCpus}`,
      rows: rows(row('1 min', fixed(load1)), row('5 min', fixed(load5)), row('15 min', fixed(load15)), row('CPUs', cpus === null ? null : String(cpus))),
    }
  },
}

export const uptimeFormatter: CardFormatter = {
  id: 'uptime',
  matches: (check) => check.service_key === 'homelab:uptime',
  format: (_check, detail) => {
    const seconds = num(detail, 'uptimeSeconds')
    return { title: 'Uptime', summary: seconds === null ? null : `up ${formatDuration(seconds)}` }
  },
}

// `ACTIVE_HEALTHY` → `active healthy`.
function humanise(status: string): string {
  return status.toLowerCase().replace(/_/g, ' ')
}

export const supabaseFormatter: CardFormatter = {
  id: 'supabase',
  matches: (check) => check.service_key.startsWith(SUPABASE_PREFIX),
  format: (check, detail) => {
    const projectStatus = text(detail, 'projectStatus')
    const status = projectStatus === null ? null : humanise(projectStatus)
    const region = text(detail, 'region')
    return {
      title: text(detail, 'name') ?? afterPrefix(check.service_key, SUPABASE_PREFIX),
      summary: [status, region].filter(Boolean).join(' · ') || null,
      reason: status === null ? null : `Project ${status}`,
      rows: rows(row('Status', status), row('Region', region)),
    }
  },
}
