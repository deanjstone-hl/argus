import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { runCheck } from '../poller.js'
import { createNoticeBoardAdapter, NOTICE_BOARD_OLD_UNACKED_MS, NOTICE_BOARD_RECENT_DEAD_MS } from './notice-board.js'

vi.mock('../record-check.js', () => ({ recordCheck: vi.fn() }))

// The board's real GET /repos, 2026-10-16 13:26 UTC: six repos, every
// message acked. The unacked and dead messages below are made up in the
// shape of the board's Message rows, since none existed to capture.
const REPOS = JSON.parse(readFileSync(new URL('../__fixtures__/notice-board-repos.json', import.meta.url), 'utf8'))
const NOW = Date.parse('2026-10-16T13:30:00Z')
const HOUR = 3_600_000
const URL_ = 'http://127.0.0.1:3790'
const ARGUS = 'github.com/deanjstone/argus'
const CONFIG = 'github.com/deanjstone/argus-config'

function message(repo: string, state: string, createdAt: string) {
  return { id: `01J${createdAt}`, repo_key: repo, kind: 'handoff', state, created_at: createdAt, attempts: state === 'dead' ? 5 : 0 }
}

function withCounts(changes: Record<string, Partial<Record<'queued' | 'claimed' | 'dead', number>>>) {
  const body = structuredClone(REPOS)
  for (const repo of body.repos) Object.assign(repo, changes[repo.repo_key] ?? {})
  return body
}

function board(repos: unknown, messages: Record<string, unknown[]> = {}, status = 200) {
  const calls: Array<{ url: string; auth: string | null }> = []
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input))
    calls.push({ url: String(input), auth: new Headers(init?.headers).get('authorization') })
    if (status !== 200) return new Response(JSON.stringify({ error: 'unauthorized' }), { status })
    if (url.pathname === '/repos') return new Response(JSON.stringify(repos))
    const repo = decodeURIComponent(url.pathname.split('/')[2] as string)
    const key = `${repo}?${url.searchParams.get('state')}`
    return new Response(JSON.stringify({ messages: messages[key] ?? [] }))
  }) as typeof fetch
  const adapter = createNoticeBoardAdapter({ url: URL_, token: 'board-token', fetch: fetchImpl, now: () => NOW })
  return { adapter, calls }
}

describe('notice-board queue adapter', () => {
  it('is one homelab card', () => {
    const { adapter } = board(REPOS)
    expect([adapter.key, adapter.host, adapter.intervalMs]).toEqual(['notice-board:queue', 'homelab', 60_000])
  })

  it('reads the real board as healthy, with one request and the homelab token', async () => {
    const { adapter, calls } = board(REPOS)
    const result = await runCheck(adapter)
    expect(result).toEqual({
      status: 'healthy',
      detail: {
        unacked: 0,
        oldestUnackedAt: null,
        dead: 0,
        recentDead: 0,
        recentDeadMs: NOTICE_BOARD_RECENT_DEAD_MS,
        oldUnackedAfterMs: NOTICE_BOARD_OLD_UNACKED_MS,
        repos: [],
      },
    })
    expect(calls).toEqual([{ url: `${URL_}/repos`, auth: 'Bearer board-token' }])
  })

  it('counts queued and claimed messages and finds the oldest', async () => {
    const repos = withCounts({ [ARGUS]: { queued: 2, claimed: 1 }, [CONFIG]: { queued: 1 } })
    const { adapter, calls } = board(repos, {
      [`${ARGUS}?queued`]: [message(ARGUS, 'queued', '2026-10-16T09:00:00.000Z'), message(ARGUS, 'queued', '2026-10-16T12:00:00.000Z')],
      [`${ARGUS}?claimed`]: [message(ARGUS, 'claimed', '2026-10-16T08:00:00.000Z')],
      [`${CONFIG}?queued`]: [message(CONFIG, 'queued', '2026-10-16T11:00:00.000Z')],
    })
    const result = await runCheck(adapter)
    expect(result.status).toBe('healthy')
    expect(result.detail).toMatchObject({
      unacked: 4,
      oldestUnackedAt: '2026-10-16T08:00:00.000Z',
      repos: [
        { repo: ARGUS, queued: 2, claimed: 1, dead: 0, oldestUnackedAt: '2026-10-16T08:00:00.000Z' },
        { repo: CONFIG, queued: 1, claimed: 0, dead: 0, oldestUnackedAt: '2026-10-16T11:00:00.000Z' },
      ],
    })
    expect(calls.map((call) => call.url)).toContain(`${URL_}/repos/${encodeURIComponent(ARGUS)}/messages?state=claimed`)
  })

  it('is degraded when a message has waited unacked for a day', async () => {
    const repos = withCounts({ [ARGUS]: { queued: 1 } })
    const created = new Date(NOW - NOTICE_BOARD_OLD_UNACKED_MS - HOUR).toISOString()
    const { adapter } = board(repos, { [`${ARGUS}?queued`]: [message(ARGUS, 'queued', created)] })
    expect((await runCheck(adapter)).status).toBe('degraded')
  })

  it('is degraded by a message that went dead this week, not by an old one', async () => {
    const repos = withCounts({ [ARGUS]: { dead: 2 } })
    const { adapter } = board(repos, {
      [`${ARGUS}?dead`]: [message(ARGUS, 'dead', '2026-09-01T00:00:00.000Z'), message(ARGUS, 'dead', '2026-10-15T00:00:00.000Z')],
    })
    const result = await runCheck(adapter)
    expect(result.status).toBe('degraded')
    expect(result.detail).toMatchObject({ dead: 2, recentDead: 1 })

    const { adapter: oldOnly } = board(withCounts({ [ARGUS]: { dead: 1 } }), {
      [`${ARGUS}?dead`]: [message(ARGUS, 'dead', '2026-09-01T00:00:00.000Z')],
    })
    expect(await runCheck(oldOnly)).toMatchObject({ status: 'healthy', detail: { dead: 1, recentDead: 0 } })
  })

  it('is down when the board does not answer', async () => {
    const fetchImpl = (async () => {
      throw new TypeError('fetch failed')
    }) as typeof fetch
    const adapter = createNoticeBoardAdapter({ url: URL_, token: 't', fetch: fetchImpl, now: () => NOW })
    expect(await runCheck(adapter)).toEqual({ status: 'down', detail: { error: 'fetch failed' } })
  })

  it('is degraded when the board refuses the token', async () => {
    const { adapter } = board(REPOS, {}, 401)
    expect(await runCheck(adapter)).toEqual({ status: 'degraded', detail: { error: `${URL_}/repos returned 401` } })
  })
})
