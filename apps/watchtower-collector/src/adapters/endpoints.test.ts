import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { CheckError } from '../adapter.js'
import {
  createEndpointAdapters,
  createTlsAdapters,
  PROBE_USER_AGENT,
  PUBLIC_ENDPOINTS,
  type PeerCertificate,
} from './endpoints.js'

// Real anonymous probes and the certificates each host presented, captured
// from WSL2 on 2026-10-16 at 15:42 UTC.
const PROBES = JSON.parse(readFileSync(new URL('../__fixtures__/endpoint-probes-myargus.json', import.meta.url), 'utf8')) as {
  probes: Record<string, { status: number; location: string | null; latencyMs: number }>
}
const CERTS = JSON.parse(readFileSync(new URL('../__fixtures__/tls-certs-myargus.json', import.meta.url), 'utf8')) as Record<string, PeerCertificate>

const NOW = Date.parse('2026-10-16T15:42:30Z')

function replay(overrides: Record<string, { status: number; location?: string | null }> = {}, delayMs = 0) {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = []
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    calls.push({ url, init })
    const probe = overrides[url] ?? PROBES.probes[url]
    if (!probe) throw new TypeError(`fetch failed: no fixture for ${url}`)
    if (delayMs > 0) clock += delayMs
    const headers = probe.location ? { location: probe.location } : undefined
    return new Response(null, { status: probe.status, headers })
  }) as typeof fetch
  let clock = NOW
  return { fetchImpl, calls, now: () => clock }
}

function adapter(host: string, options: ReturnType<typeof replay>) {
  const found = createEndpointAdapters(PUBLIC_ENDPOINTS, { fetch: options.fetchImpl, now: options.now }).find((candidate) => candidate.key === `endpoint:${host}`)
  if (!found) throw new Error(`no endpoint adapter for ${host}`)
  return found
}

describe('PUBLIC_ENDPOINTS', () => {
  it('covers every *.myargus.cc host a Worker or the dashboard answers on', () => {
    expect(PUBLIC_ENDPOINTS.map((endpoint) => new URL(endpoint.url).host)).toEqual([
      'api.myargus.cc',
      'memory.myargus.cc',
      'vault.myargus.cc',
      'mail.myargus.cc',
      'mcp.myargus.cc',
      'watchtower.myargus.cc',
    ])
  })
})

describe('endpoint probes', () => {
  it('counts every real endpoint as up, 401s and the Access redirect included', async () => {
    const options = replay()
    for (const endpoint of PUBLIC_ENDPOINTS) {
      const host = new URL(endpoint.url).host
      const result = await adapter(host, options).check()
      expect(result.status, host).toBe('healthy')
    }
  })

  it('reports the status, redirect host and latency it saw', async () => {
    const result = await adapter('mail.myargus.cc', replay()).check()
    expect(result.detail).toEqual({
      url: 'https://mail.myargus.cc/',
      expected: 302,
      expectedRedirectHost: 'cloudflareaccess.com',
      statusCode: 302,
      redirectHost: 'team.cloudflareaccess.com',
      latencyMs: 0,
      slowAfterMs: 3000,
    })
  })

  it('probes anonymously, without following redirects, as the probe user agent', async () => {
    const options = replay()
    await adapter('api.myargus.cc', options).check()
    const init = options.calls[0]?.init
    expect(init?.redirect).toBe('manual')
    expect(new Headers(init?.headers).get('user-agent')).toBe(PROBE_USER_AGENT)
    expect(new Headers(init?.headers).has('authorization')).toBe(false)
  })

  it('is down on a 5xx', async () => {
    const result = await adapter('memory.myargus.cc', replay({ 'https://memory.myargus.cc/mcp': { status: 502 } })).check()
    expect(result.status).toBe('down')
    expect(result.detail).toMatchObject({ statusCode: 502 })
  })

  it('is degraded on an answer it did not expect, such as an API open to anonymous requests', async () => {
    expect((await adapter('api.myargus.cc', replay({ 'https://api.myargus.cc/watchtower/checks': { status: 200 } })).check()).status).toBe('degraded')
    expect((await adapter('api.myargus.cc', replay({ 'https://api.myargus.cc/watchtower/checks': { status: 404 } })).check()).status).toBe('degraded')
  })

  it('is degraded when a redirect goes somewhere other than Access', async () => {
    const result = await adapter('mail.myargus.cc', replay({ 'https://mail.myargus.cc/': { status: 302, location: 'https://example.com/' } })).check()
    expect(result.status).toBe('degraded')
    expect(result.detail).toMatchObject({ redirectHost: 'example.com' })
  })

  it('is degraded when the answer is right but slow', async () => {
    const result = await adapter('vault.myargus.cc', replay({}, 3500)).check()
    expect(result.status).toBe('degraded')
    expect(result.detail).toMatchObject({ statusCode: 401, latencyMs: 3500 })
  })

  it('records a probe that got no answer as down', async () => {
    const options = replay({ 'https://vault.myargus.cc/mcp': undefined as never })
    const failing = createEndpointAdapters([{ url: 'https://nowhere.myargus.cc/', expected: 200 }], { fetch: options.fetchImpl, now: options.now })[0]!
    expect(failing.failureStatus).toBe('down')
    await expect(failing.check()).rejects.toThrow(/nowhere\.myargus\.cc/)
  })

  it('files every probe under the public surface, every 5 minutes', () => {
    const [first] = createEndpointAdapters(PUBLIC_ENDPOINTS)
    expect(first).toMatchObject({ key: 'endpoint:api.myargus.cc', host: 'myargus.cc', intervalMs: 300_000 })
  })
})

describe('TLS certificates', () => {
  const read = async (host: string) => {
    const cert = CERTS[host]
    if (!cert) throw new Error(`no certificate fixture for ${host}`)
    return cert
  }

  function tls(host: string, readCertificate = read, now = NOW) {
    const found = createTlsAdapters([host], { readCertificate, now: () => now })[0]
    if (!found) throw new Error('no tls adapter')
    return found
  }

  it('reads the real certificates as healthy, with days left and the names they cover', async () => {
    const result = await tls('vault.myargus.cc').check()
    expect(result).toEqual({
      status: 'healthy',
      detail: {
        host: 'vault.myargus.cc',
        validFrom: '2026-09-13T03:37:33.000Z',
        validTo: '2026-12-12T04:37:30.000Z',
        daysLeft: 56,
        issuer: 'Google Trust Services WE1',
        subject: 'myargus.cc',
        names: ['myargus.cc', 'vault.myargus.cc', '*.vault.myargus.cc'],
        degradedBelowDays: 21,
        downBelowDays: 7,
      },
    })
    for (const host of Object.keys(CERTS)) expect((await tls(host).check()).status, host).toBe('healthy')
  })

  it('is degraded inside three weeks of expiry, when renewal should already have happened', async () => {
    const result = await tls('vault.myargus.cc', read, Date.parse('2026-11-25T00:00:00Z')).check()
    expect(result.status).toBe('degraded')
    expect(result.detail).toMatchObject({ daysLeft: 17 })
  })

  it('is down inside a week of expiry, and once expired', async () => {
    expect((await tls('vault.myargus.cc', read, Date.parse('2026-12-08T00:00:00Z')).check()).status).toBe('down')
    const expired = await tls('vault.myargus.cc', read, Date.parse('2026-12-20T00:00:00Z')).check()
    expect(expired.status).toBe('down')
    expect(expired.detail).toMatchObject({ daysLeft: -8 })
  })

  it('refuses a certificate whose dates it cannot read', async () => {
    const garbled = async () => ({ ...CERTS['api.myargus.cc']!, valid_to: 'soon' })
    await expect(tls('api.myargus.cc', garbled).check()).rejects.toBeInstanceOf(CheckError)
  })

  it('files certificates under the public surface, every 5 minutes, down when the handshake fails', () => {
    const [first] = createTlsAdapters(['api.myargus.cc'])
    expect(first).toMatchObject({ key: 'tls:api.myargus.cc', host: 'myargus.cc', intervalMs: 300_000, failureStatus: 'down' })
  })
})
