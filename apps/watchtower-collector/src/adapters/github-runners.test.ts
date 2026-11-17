import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { runCheck } from '../poller.js'
import { createGithubRunnerAdapters, createRunnerSource, parseRunnerList } from './github-runners.js'

vi.mock('../record-check.js', () => ({ recordCheck: vi.fn() }))

// GET /repos/deanjstone/argus/actions/runners on 2026-10-16: both runners
// online and busy.
const ARGUS = JSON.parse(readFileSync(new URL('../__fixtures__/github-runners-argus.json', import.meta.url), 'utf8'))

function withRunners(overrides: Array<Partial<{ name: string; status: string; busy: boolean }>>) {
  return { ...ARGUS, runners: ARGUS.runners.map((runner: object, index: number) => ({ ...runner, ...overrides[index] })) }
}

function respond(bodies: Record<string, unknown>, status = 200) {
  const calls: Array<{ url: string; init?: RequestInit }> = []
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init })
    const repo = /repos\/[^/]+\/([^/]+)\/actions/.exec(String(url))?.[1] ?? ''
    if (status !== 200) return new Response('{"message":"Resource not accessible by personal access token"}', { status })
    return new Response(JSON.stringify(bodies[repo] ?? { total_count: 0, runners: [] }), { status: 200 })
  }) as typeof fetch
  return { fetchImpl, calls }
}

describe('parseRunnerList', () => {
  it('reads repo/runner pairs', () => {
    expect(parseRunnerList('argus/homelab, argus/homelab-2,context/homelab-context')).toEqual([
      { repo: 'argus', name: 'homelab' },
      { repo: 'argus', name: 'homelab-2' },
      { repo: 'context', name: 'homelab-context' },
    ])
  })

  it('rejects an entry without a repo', () => {
    expect(() => parseRunnerList('homelab')).toThrow(/repo\/runner/)
  })
})

describe('github runner adapters', () => {
  const runners = parseRunnerList('argus/homelab,argus/homelab-2')

  function adapters(fetchImpl: typeof fetch, now = () => 0) {
    const source = createRunnerSource({ owner: 'deanjstone', token: 'gh-token', fetch: fetchImpl, now })
    return createGithubRunnerAdapters(source, runners)
  }

  it('makes one card per runner, keyed by repo and name, grouped under github-runners', () => {
    const [first, second] = adapters(respond({}).fetchImpl)
    expect(first?.key).toBe('github-runner:argus/homelab')
    expect(second?.key).toBe('github-runner:argus/homelab-2')
    expect(first?.host).toBe('github-runners')
    expect(first?.failureStatus).toBe('unreachable')
  })

  it('reports a busy online runner as healthy, from GitHub’s busy flag', async () => {
    const [first] = adapters(respond({ argus: ARGUS }).fetchImpl)
    expect(await runCheck(first!)).toEqual({
      status: 'healthy',
      detail: {
        repo: 'argus',
        name: 'homelab',
        online: true,
        busy: true,
        version: '2.337.0',
        labels: ['self-hosted', 'Linux', 'X64', 'homelab'],
      },
    })
  })

  it('reports an idle online runner as healthy and not busy', async () => {
    const [first] = adapters(respond({ argus: withRunners([{ busy: false }]) }).fetchImpl)
    const result = await runCheck(first!)
    expect(result.status).toBe('healthy')
    expect(result.detail).toMatchObject({ online: true, busy: false })
  })

  it('reports an offline runner as down', async () => {
    const [first] = adapters(respond({ argus: withRunners([{ status: 'offline', busy: false }]) }).fetchImpl)
    const result = await runCheck(first!)
    expect(result.status).toBe('down')
    expect(result.detail).toMatchObject({ online: false })
  })

  it('reports a runner GitHub no longer lists as down', async () => {
    const [, second] = adapters(respond({ argus: withRunners([{}, { name: 'homelab-3' }]) }).fetchImpl)
    const result = await runCheck(second!)
    expect(result.status).toBe('down')
    expect(result.detail).toEqual({ error: 'runner homelab-2 is not registered on deanjstone/argus' })
  })

  it('sends the token and fetches a repo once for all of its runners within a poll', async () => {
    const { fetchImpl, calls } = respond({ argus: ARGUS })
    const [first, second] = adapters(fetchImpl)
    await Promise.all([runCheck(first!), runCheck(second!)])
    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toBe('https://api.github.com/repos/deanjstone/argus/actions/runners?per_page=100')
    expect(new Headers(calls[0]?.init?.headers).get('authorization')).toBe('Bearer gh-token')
  })

  it('fetches again once the cached listing is older than the poll interval', async () => {
    const { fetchImpl, calls } = respond({ argus: ARGUS })
    let clock = 0
    const [first] = adapters(fetchImpl, () => clock)
    await runCheck(first!)
    clock = 60_000
    await runCheck(first!)
    expect(calls).toHaveLength(2)
  })

  it('reports a rejected token as degraded without echoing it', async () => {
    const [first] = adapters(respond({}, 403).fetchImpl)
    const result = await runCheck(first!)
    expect(result.status).toBe('degraded')
    expect(JSON.stringify(result)).toMatch(/403/)
    expect(JSON.stringify(result)).not.toMatch(/gh-token/)
  })

  it('reports a network failure as unreachable', async () => {
    const fetchImpl = (async () => {
      throw new Error('getaddrinfo ENOTFOUND api.github.com')
    }) as typeof fetch
    const [first] = adapters(fetchImpl)
    expect((await runCheck(first!)).status).toBe('unreachable')
  })
})
