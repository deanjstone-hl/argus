import type { NoticeBoardRepoDetail } from '@argus/watchtower-contract'
import { list, num, row, rows, text, timeRow } from '../fields'
import type { CardFormatter } from '../types'
import { formatRelativeTime, pluralise } from '../units'

// The notice board's queue: messages no session has acked yet, and those
// that went dead after five unacked deliveries.
const ago = (iso: string, now: number) => formatRelativeTime(iso, now)

function repoValue(repo: NoticeBoardRepoDetail, now: number): string {
  return [
    repo.queued > 0 ? `${repo.queued} queued` : null,
    repo.claimed > 0 ? `${repo.claimed} claimed` : null,
    repo.dead > 0 ? `${repo.dead} dead` : null,
    repo.oldestUnackedAt === null ? null : `oldest ${ago(repo.oldestUnackedAt, now)}`,
  ]
    .filter(Boolean)
    .join(' · ')
}

export const noticeBoardFormatter: CardFormatter = {
  id: 'notice-board',
  matches: (check) => check.service_key === 'notice-board:queue',
  format: (_check, detail, now) => {
    const unacked = num(detail, 'unacked') ?? 0
    const oldest = text(detail, 'oldestUnackedAt')
    const dead = num(detail, 'dead') ?? 0
    const recentDead = num(detail, 'recentDead') ?? 0
    const oldAfter = num(detail, 'oldUnackedAfterMs')
    const old = oldest !== null && oldAfter !== null && now - Date.parse(oldest) > oldAfter

    const reasons = [
      old ? `A message has waited unacked for ${ago(oldest, now).replace(/ ago$/, '')}` : null,
      recentDead > 0 ? `${pluralise(recentDead, 'message')} went dead this week, never acked after 5 deliveries` : null,
    ].filter(Boolean)

    return {
      title: 'Notice board',
      summary: unacked === 0 ? 'nothing waiting' : `${unacked} unacked${oldest === null ? '' : ` · oldest ${ago(oldest, now)}`}`,
      reason: reasons.join('; ') || null,
      rows: rows(
        row('Unacked', String(unacked)),
        timeRow('Oldest', oldest, now),
        dead === 0 ? null : row('Dead', recentDead > 0 ? `${dead} (${recentDead} this week)` : String(dead)),
      ),
      sections: [
        {
          title: 'Repos',
          rows: list<NoticeBoardRepoDetail>(detail, 'repos').map((repo) => ({
            label: repo.repo.split('/').pop() ?? repo.repo,
            title: repo.repo,
            value: repoValue(repo, now),
          })),
        },
      ],
    }
  },
}
