import type { NoticeBoardQueueDetail, NoticeBoardRepoDetail } from '@argus/watchtower-contract'
import { CheckError, type Adapter, type HealthResult } from '../adapter.js'

// The notice board's queue (served by deanjstone/ops-hub), read on homelab, where the
// board listens on loopback. Unacked means queued (no session has opened the
// repo yet) or claimed (a session took it and its Stop hook has not acked).
// Read-only: GET /repos, then GET messages by state for repos that have any.

// A message waits for the next session in its repo; a day of nobody taking
// it, or of a session holding it unacked, is worth seeing.
export const NOTICE_BOARD_OLD_UNACKED_MS = 24 * 3_600_000
// Dead (five unacked deliveries) is final and stays in the counts for good,
// so only a recent one is a new failure.
export const NOTICE_BOARD_RECENT_DEAD_MS = 7 * 24 * 3_600_000

export interface NoticeBoardOptions {
  url: string
  token: string
  fetch?: typeof fetch
  now?: () => number
}

interface RepoSummary {
  repo_key: string
  queued: number
  claimed: number
  dead: number
}

interface MessageRow {
  created_at: string
}

export function createNoticeBoardAdapter(options: NoticeBoardOptions): Adapter {
  const fetchImpl = options.fetch ?? fetch
  const now = options.now ?? Date.now
  const base = options.url.replace(/\/$/, '')

  async function get<T>(path: string): Promise<T> {
    const url = `${base}${path}`
    const response = await fetchImpl(url, {
      headers: { authorization: `Bearer ${options.token}` },
      signal: AbortSignal.timeout(10_000),
    })
    // It answered: a refusal is the collector's token, not the board.
    if (!response.ok) throw new CheckError('degraded', `${url} returned ${response.status}`)
    return (await response.json()) as T
  }

  async function messages(repo: string, state: string): Promise<MessageRow[]> {
    return (await get<{ messages: MessageRow[] }>(`/repos/${encodeURIComponent(repo)}/messages?state=${state}`)).messages
  }

  // Messages come oldest first.
  const oldest = (...lists: MessageRow[][]) =>
    lists
      .flat()
      .map((message) => message.created_at)
      .sort()[0] ?? null

  async function check(): Promise<HealthResult> {
    const { repos } = await get<{ repos: RepoSummary[] }>('/repos')
    const at = now()
    const involved = repos.filter((repo) => repo.queued + repo.claimed + repo.dead > 0)
    const details = await Promise.all(
      involved.map(async (repo) => {
        const [queued, claimed, dead] = await Promise.all([
          repo.queued > 0 ? messages(repo.repo_key, 'queued') : [],
          repo.claimed > 0 ? messages(repo.repo_key, 'claimed') : [],
          repo.dead > 0 ? messages(repo.repo_key, 'dead') : [],
        ])
        const recentDead = dead.filter((message) => at - Date.parse(message.created_at) < NOTICE_BOARD_RECENT_DEAD_MS).length
        const detail: NoticeBoardRepoDetail = {
          repo: repo.repo_key,
          queued: repo.queued,
          claimed: repo.claimed,
          dead: repo.dead,
          oldestUnackedAt: oldest(queued, claimed),
        }
        return { detail, recentDead }
      }),
    )

    const oldestUnackedAt =
      details
        .map(({ detail }) => detail.oldestUnackedAt)
        .filter((value): value is string => value !== null)
        .sort()[0] ?? null
    const detail: NoticeBoardQueueDetail = {
      unacked: repos.reduce((total, repo) => total + repo.queued + repo.claimed, 0),
      oldestUnackedAt,
      dead: repos.reduce((total, repo) => total + repo.dead, 0),
      recentDead: details.reduce((total, entry) => total + entry.recentDead, 0),
      recentDeadMs: NOTICE_BOARD_RECENT_DEAD_MS,
      oldUnackedAfterMs: NOTICE_BOARD_OLD_UNACKED_MS,
      // Longest-waiting first; repos with only dead messages last.
      repos: details
        .map((entry) => entry.detail)
        .sort((a, b) => (a.oldestUnackedAt ?? '~').localeCompare(b.oldestUnackedAt ?? '~')),
    }
    const old = oldestUnackedAt !== null && at - Date.parse(oldestUnackedAt) > NOTICE_BOARD_OLD_UNACKED_MS
    return { status: old || detail.recentDead > 0 ? 'degraded' : 'healthy', detail }
  }

  return { key: 'notice-board:queue', host: 'homelab', intervalMs: 60_000, check }
}
