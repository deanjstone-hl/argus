import type { MemoryReconcileDetail } from '@argus/watchtower-contract'
import { list, num, row, rows, text, timeRow } from '../fields'
import type { CardFormatter } from '../types'
import { formatAllowance, formatRelativeTime, pluralise } from '../units'

// memory-mcp's reconciler on WSL2, from its heartbeat file: when it last
// ran, and the refusals it leaves for the owner to settle.
type Refusal = MemoryReconcileDetail['refusals'][number]

// The timer's interval: a third of the collector's stale allowance.
const RUNS_EVERY_FRACTION = 3

function tildePath(path: string): string {
  return path.replace(/^\/home\/[^/]+/, '~')
}

function breakdown(refusals: Refusal[]): string {
  const counts = new Map<string, number>()
  for (const refusal of refusals) counts.set(refusal.reason, (counts.get(refusal.reason) ?? 0) + 1)
  return [...counts]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([reason, count]) => (refusals.length === 1 ? reason : `${count} ${reason}`))
    .join(', ')
}

export const memoryReconcileFormatter: CardFormatter = {
  id: 'memory-reconcile',
  matches: (check) => /^[\w-]+:memory-reconcile$/.test(check.service_key),
  format: (_check, detail, now) => {
    const lastRunAt = text(detail, 'lastRunAt')
    const refusals = list<Refusal>(detail, 'refusals')
    const staleAfter = num(detail, 'staleAfterMs')
    const path = text(detail, 'path')
    const failed = detail.ok === false
    const stale = lastRunAt !== null && staleAfter !== null && now - Date.parse(lastRunAt) > staleAfter
    const ran = lastRunAt === null ? null : formatRelativeTime(lastRunAt, now)

    const reasons = [
      failed ? `Last run failed: ${text(detail, 'lastError') ?? 'no error recorded'}` : null,
      stale && staleAfter !== null ? `Last ran ${ran}; it should run every ${formatAllowance(staleAfter / RUNS_EVERY_FRACTION)}` : null,
      refusals.length > 0
        ? `${pluralise(refusals.length, 'refusal')} to settle (${breakdown(refusals)})${path === null ? '' : `; each one’s detail is in ${tildePath(path)}`}`
        : null,
    ].filter(Boolean)

    return {
      title: 'memory-reconcile',
      summary: [ran === null ? null : `last ran ${ran}`, refusals.length === 0 ? 'no refusals' : pluralise(refusals.length, 'refusal')].filter(Boolean).join(' · '),
      reason: reasons.join('; ') || null,
      rows: rows(
        timeRow('Last run', lastRunAt, now),
        row('Result', detail.ok === true ? 'ok' : failed ? 'failed' : null),
        row('Written', num(detail, 'written') === null ? null : String(num(detail, 'written'))),
        row('Deleted', num(detail, 'deleted') === null ? null : String(num(detail, 'deleted'))),
      ),
      sections: [
        {
          title: 'Refusals',
          empty: 'None',
          rows: refusals.map((refusal) => ({
            label: refusal.key,
            value: `${refusal.reason}${refusal.seenAt === null ? '' : ` · first seen ${formatRelativeTime(refusal.seenAt, now)}`}`,
          })),
        },
      ],
    }
  },
}
