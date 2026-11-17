import { num, row, rows, text } from '../fields'
import type { CardFormatter } from '../types'
import { pluralise } from '../units'

// `<host>:t3-stale`: how far behind the newest release on its channel a
// host's T3 is, from argus-config's hooks/t3-stale.py. The
// collector marks the card degraded once the hook calls the host stale
// (behind_days >= T3_STALE_DAYS); the days and versions here are the hook's.
const KEY = /^[\w-]+:t3-stale$/

const days = (count: number) => pluralise(count, 'day')

export const t3StaleFormatter: CardFormatter = {
  id: 't3-stale',
  matches: (check) => KEY.test(check.service_key),
  format: (check, detail) => {
    const host = text(detail, 'host') ?? check.host
    const active = text(detail, 'active')
    const newest = text(detail, 'newest')
    const behind = num(detail, 'behindDays')
    const threshold = num(detail, 'thresholdDays')
    const upToDate = behind === 0

    return {
      title: `T3 on ${host}`,
      summary: [active, behind === null ? null : upToDate ? 'up to date' : `${days(behind)} behind`].filter(Boolean).join(' · ') || null,
      reason:
        behind === null
          ? null
          : `${host} ${days(behind)} behind: running ${active ?? 'an unknown version'}, newest is ${newest ?? 'unknown'}${threshold === null ? '' : ` (flagged at ${days(threshold)})`}`,
      rows: rows(
        row('Running', active),
        row('Newest', newest),
        row('Behind', behind === null ? null : days(behind)),
        row('Channel', text(detail, 'channel')),
        row('Flagged at', threshold === null ? null : `${days(threshold)} behind`),
      ),
    }
  },
}
