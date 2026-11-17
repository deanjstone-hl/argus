import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runCheck } from '../poller.js'
import { createClaudeWindowAdapter, createOauthUsageSource, OAUTH_USAGE_URL } from './claude-window.js'

vi.mock('../record-check.js', () => ({ recordCheck: vi.fn() }))

// The shape of the usage endpoint's reply, as argus-config's budget-signals reads it. Hand-built:
// no live call was made to record it.
const REPLY = JSON.parse(readFileSync(new URL('../__fixtures__/claude-oauth-usage.hand-built.json', import.meta.url), 'utf8')) as unknown

// A fake, never a real token.
const TOKEN = 'FAKE-TEST-TOKEN'

describe('Claude window adapter', () => {
  it('is one card, polled every five minutes', () => {
    const adapter = createClaudeWindowAdapter(async () => REPLY)
    expect([adapter.key, adapter.host, adapter.intervalMs]).toEqual(['claude-window', 'multi', 300_000])
  })

  it('reports the five-hour and weekly usage against the cap, with their reset times', async () => {
    const result = await runCheck(createClaudeWindowAdapter(async () => REPLY))
    expect(result).toEqual({
      status: 'healthy',
      detail: {
        source: 'oauth-usage',
        fiveHour: { utilization: 42, resetsAt: '2026-10-30T07:00:00.123456+00:00' },
        sevenDay: { utilization: 63, resetsAt: '2026-11-02T00:00:00+00:00' },
      },
    })
  })

  it('still reports the five-hour window when the weekly one is missing', async () => {
    const result = await runCheck(createClaudeWindowAdapter(async () => ({ five_hour: { utilization: 5, resets_at: null } })))
    expect(result).toEqual({
      status: 'healthy',
      detail: { source: 'oauth-usage', fiveHour: { utilization: 5, resetsAt: null }, sevenDay: null },
    })
  })

  it('degrades, without throwing, when the reply has no five-hour utilization', async () => {
    const result = await runCheck(createClaudeWindowAdapter(async () => ({ seven_day: { utilization: 1 } })))
    expect(result.status).toBe('degraded')
    expect(result.detail).toMatchObject({ source: 'oauth-usage', fiveHour: null, error: expect.stringContaining('five_hour') })
  })

  it('degrades, without throwing, when the source fails', async () => {
    const result = await runCheck(
      createClaudeWindowAdapter(async () => {
        throw new Error('usage endpoint answered 401')
      }),
    )
    expect(result.status).toBe('degraded')
    expect(result.detail).toEqual({ source: 'oauth-usage', fiveHour: null, sevenDay: null, error: 'usage endpoint answered 401' })
  })
})

describe('OAuth usage source', () => {
  let configDir: string

  beforeEach(() => {
    configDir = mkdtempSync(join(tmpdir(), 'claude-window-'))
  })
  afterEach(() => {
    rmSync(configDir, { recursive: true, force: true })
  })

  const writeCredentials = (value: unknown) => writeFileSync(join(configDir, '.credentials.json'), JSON.stringify(value))

  it('asks the usage endpoint with the stored token and the OAuth beta header, refusing redirects', async () => {
    writeCredentials({ claudeAiOauth: { accessToken: TOKEN } })
    const fetchImpl = vi.fn(async () => Response.json(REPLY))
    expect(await createOauthUsageSource({ configDir, fetchImpl }).fetchUsage()).toEqual(REPLY)
    expect(fetchImpl).toHaveBeenCalledWith(
      OAUTH_USAGE_URL,
      expect.objectContaining({ redirect: 'error', headers: { Authorization: `Bearer ${TOKEN}`, 'anthropic-beta': 'oauth-2025-04-20' } }),
    )
    expect(OAUTH_USAGE_URL).toBe('https://api.anthropic.com/api/oauth/usage')
  })

  it('reads the token on every call, so a refreshed token is picked up', async () => {
    const seen: string[] = []
    const fetchImpl = vi.fn(async (_url: string, init: { headers: Record<string, string> }) => {
      seen.push(init.headers.Authorization ?? '')
      return Response.json(REPLY)
    })
    const source = createOauthUsageSource({ configDir, fetchImpl })
    writeCredentials({ claudeAiOauth: { accessToken: 'first' } })
    await source.fetchUsage()
    writeCredentials({ claudeAiOauth: { accessToken: 'second' } })
    await source.fetchUsage()
    expect(seen).toEqual(['Bearer first', 'Bearer second'])
  })

  it('fails with a plain message, and makes no request, when the credentials file is missing', async () => {
    const fetchImpl = vi.fn(async () => Response.json(REPLY))
    await expect(createOauthUsageSource({ configDir, fetchImpl }).fetchUsage()).rejects.toThrow('no OAuth credentials (ENOENT)')
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it.each([
    ['not JSON', 'not json at all'],
    ['no claudeAiOauth', '{}'],
    ['an empty token', '{"claudeAiOauth":{"accessToken":""}}'],
    ['a non-string token', '{"claudeAiOauth":{"accessToken":7}}'],
  ])('fails without a request when the credentials hold %s', async (_name, contents) => {
    writeFileSync(join(configDir, '.credentials.json'), contents)
    const fetchImpl = vi.fn(async () => Response.json(REPLY))
    await expect(createOauthUsageSource({ configDir, fetchImpl }).fetchUsage()).rejects.toThrow(/^no OAuth credentials/)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('reports a 401 as an expired token, without the token in the message', async () => {
    writeCredentials({ claudeAiOauth: { accessToken: TOKEN } })
    const fetchImpl = vi.fn(async () => new Response('{"error":"unauthorized"}', { status: 401 }))
    const failure = await createOauthUsageSource({ configDir, fetchImpl }).fetchUsage().catch((error: Error) => error)
    expect(failure).toBeInstanceOf(Error)
    expect((failure as Error).message).toBe('usage endpoint answered 401 (token expired or revoked)')
    expect((failure as Error).message).not.toContain(TOKEN)
  })

  it('reports any other non-2xx status by code alone', async () => {
    writeCredentials({ claudeAiOauth: { accessToken: TOKEN } })
    const fetchImpl = vi.fn(async () => new Response('x', { status: 503 }))
    await expect(createOauthUsageSource({ configDir, fetchImpl }).fetchUsage()).rejects.toThrow('usage endpoint answered 503')
  })

  it('reports a network failure or an unreadable body without echoing the token', async () => {
    writeCredentials({ claudeAiOauth: { accessToken: TOKEN } })
    const down = createOauthUsageSource({
      configDir,
      fetchImpl: async () => {
        throw new TypeError(`fetch failed for header Bearer ${TOKEN}`)
      },
    })
    const downFailure = await down.fetchUsage().catch((error: Error) => error)
    expect((downFailure as Error).message).toBe('usage endpoint unreachable (TypeError)')

    const garbled = createOauthUsageSource({ configDir, fetchImpl: async () => new Response('<html>', { status: 200 }) })
    await expect(garbled.fetchUsage()).rejects.toThrow('usage endpoint reply is not JSON')
  })

  it('feeds the adapter: a missing token is degraded, not a throw', async () => {
    const adapter = createClaudeWindowAdapter(createOauthUsageSource({ configDir, fetchImpl: vi.fn() }).fetchUsage)
    const result = await runCheck(adapter)
    expect(result.status).toBe('degraded')
    expect(result.detail).toMatchObject({ error: 'no OAuth credentials (ENOENT)' })
  })
})
