import { describe, expect, it } from 'vitest'
import { CheckError } from './adapter.js'
import { createGithubApi } from './github-api.js'

interface Reply {
  status: number
  body?: unknown
  headers?: Record<string, string>
}

function serve(replies: Reply[]) {
  const calls: Array<{ url: string; headers: Headers }> = []
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), headers: new Headers(init?.headers) })
    const reply = replies.shift() ?? { status: 500 }
    return new Response(reply.body === undefined ? null : JSON.stringify(reply.body), { status: reply.status, headers: reply.headers })
  }) as typeof fetch
  return { fetchImpl, calls }
}

describe('createGithubApi', () => {
  it('calls the REST API with the token and API version', async () => {
    const { fetchImpl, calls } = serve([{ status: 200, body: { ok: 1 } }])
    const api = createGithubApi({ token: 'actions-token', fetch: fetchImpl })
    expect(await api.get('/repos/deanjstone/argus/actions/runs?per_page=1')).toEqual({ ok: 1 })
    expect(calls[0]?.url).toBe('https://api.github.com/repos/deanjstone/argus/actions/runs?per_page=1')
    expect(calls[0]?.headers.get('authorization')).toBe('Bearer actions-token')
    expect(calls[0]?.headers.get('x-github-api-version')).toBe('2022-11-28')
  })

  it('revalidates with the ETag and reuses the body on 304, which costs no rate limit', async () => {
    const { fetchImpl, calls } = serve([
      { status: 200, body: { runs: 1 }, headers: { etag: 'W/"abc"' } },
      { status: 304 },
    ])
    const api = createGithubApi({ token: 't', fetch: fetchImpl })
    await api.get('/x')
    expect(await api.get('/x')).toEqual({ runs: 1 })
    expect(calls[1]?.headers.get('if-none-match')).toBe('W/"abc"')
  })

  it('never refetches a path marked immutable', async () => {
    const { fetchImpl, calls } = serve([{ status: 200, body: { jobs: [] } }])
    const api = createGithubApi({ token: 't', fetch: fetchImpl })
    await api.get('/jobs', { immutable: true })
    expect(await api.get('/jobs', { immutable: true })).toEqual({ jobs: [] })
    expect(calls).toHaveLength(1)
  })

  it('degrades on a refusal, naming the path and status', async () => {
    const { fetchImpl } = serve([{ status: 404 }])
    const error = await createGithubApi({ token: 't', fetch: fetchImpl }).get('/repos/deanjstone/gone/actions/runs').catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(CheckError)
    expect(error).toMatchObject({ status: 'degraded', message: 'GitHub API /repos/deanjstone/gone/actions/runs returned 404' })
  })

  it('says when the rate limit ran out', async () => {
    const { fetchImpl } = serve([{ status: 403, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1792156039' } }])
    const error = await createGithubApi({ token: 't', fetch: fetchImpl }).get('/x').catch((caught: unknown) => caught)
    expect(error).toMatchObject({ status: 'degraded', message: 'GitHub API rate limit exhausted until 2026-10-16T13:07:19.000Z' })
  })
})
