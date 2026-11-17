import { afterEach, beforeEach, describe, test, vi } from 'vitest'
import assert from 'node:assert/strict'
import type { HealthStatus } from '@argus/watchtower-contract'
import type { Adapter, HealthResult } from './adapter.js'
import { runCheck } from './poller.js'
import { createCloudflareAdapter } from './adapters/cloudflare.js'
import { createSupabaseProjectAdapter } from './adapters/supabase-projects.js'
import { createSyncthingAdapter } from './adapters/syncthing.js'
import { createSystemdAdapter } from './adapters/systemd.js'
import { createDiskAdapter } from './adapters/disk.js'
import { createUptimeAdapter } from './adapters/uptime.js'
import { createAiUsageAdapter, createRemoteHostSource } from './adapters/ai-usage.js'

// Every failure an adapter can meet, and the status it is recorded with. The
// status is the contract: `unreachable` means the source never answered (a
// remote API or a sleeping laptop), `down` means a local check failed, and
// `degraded` means the source answered with something unusable.

const failures = vi.hoisted(() => ({ execFile: false, readFile: false }))

// runCheck only produces the result; recording it is not under test here.
vi.mock('./record-check.js', () => ({ recordCheck: vi.fn() }))

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return {
    ...actual,
    execFile: (...args: unknown[]) => {
      if (!failures.execFile) return (actual.execFile as (...a: unknown[]) => unknown)(...args)
      const callback = args.at(-1) as (error: Error) => void
      callback(new Error('Failed to connect to bus: No medium found'))
      return undefined
    },
  }
})

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    readFile: (...args: Parameters<typeof actual.readFile>) =>
      failures.readFile
        ? Promise.reject(new Error("ENOENT: no such file or directory, open '/proc/uptime'"))
        : actual.readFile(...args),
  }
})

type FetchHandler = () => Promise<Response>

const networkError: FetchHandler = async () => {
  throw new TypeError('fetch failed', { cause: new Error('getaddrinfo ENOTFOUND') })
}
const status500: FetchHandler = async () => new Response('oops', { status: 500 })
const notJson: FetchHandler = async () => new Response('<html>', { status: 200 })

function stubFetch(handler: FetchHandler): void {
  vi.stubGlobal('fetch', vi.fn(handler))
}

async function expectStatus(adapter: Adapter, status: HealthStatus, error?: RegExp): Promise<HealthResult> {
  const result = await runCheck(adapter)
  assert.equal(result.status, status, JSON.stringify(result.detail))
  if (error) assert.match(String(result.detail?.error), error)
  return result
}

beforeEach(() => {
  failures.execFile = false
  failures.readFile = false
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('runCheck', () => {
  test('records a throw from an adapter as down, with the message as detail', async () => {
    const adapter: Adapter = {
      key: 'test',
      host: 'test',
      intervalMs: 1,
      check: async () => {
        throw new Error('boom')
      },
    }
    assert.deepEqual(await runCheck(adapter), { status: 'down', detail: { error: 'boom' } })
  })

  test('passes a returned result through untouched', async () => {
    const result: HealthResult = { status: 'degraded', detail: { note: 'x' } }
    const adapter: Adapter = { key: 'test', host: 'test', intervalMs: 1, check: async () => result }
    assert.deepEqual(await runCheck(adapter), result)
  })
})

describe.each(['pages', 'worker'] as const)('cloudflare %s project', (kind) => {
  const adapter = () => createCloudflareAdapter('account', 'token', { name: 'site', kind })

  test('is unreachable on a network error', async () => {
    stubFetch(networkError)
    await expectStatus(adapter(), 'unreachable', /fetch failed/)
  })

  test('is unreachable on a non-2xx response', async () => {
    stubFetch(status500)
    await expectStatus(adapter(), 'unreachable', /returned 500/)
  })

  test('is unreachable when the API reports failure', async () => {
    stubFetch(async () => Response.json({ success: false, result: null, errors: [{ code: 10000 }] }))
    await expectStatus(adapter(), 'unreachable', /reported failure/)
  })

  test('is unreachable when the body is not JSON', async () => {
    stubFetch(notJson)
    await expectStatus(adapter(), 'unreachable')
  })
})

describe('supabase project', () => {
  const adapter = () => createSupabaseProjectAdapter('token', 'ref123')

  test('is unreachable on a network error', async () => {
    stubFetch(networkError)
    await expectStatus(adapter(), 'unreachable', /fetch failed/)
  })

  test('is unreachable on a non-2xx response', async () => {
    stubFetch(status500)
    await expectStatus(adapter(), 'unreachable', /project ref123 returned 500/)
  })

  test('is unreachable when the body is not JSON', async () => {
    stubFetch(notJson)
    await expectStatus(adapter(), 'unreachable')
  })
})

describe('syncthing (plain fetch)', () => {
  const adapter = () => createSyncthingAdapter('http://syncthing.test', 'key')

  test('is down on a network error', async () => {
    stubFetch(networkError)
    await expectStatus(adapter(), 'down', /fetch failed/)
  })

  test('is down on a non-2xx response', async () => {
    stubFetch(status500)
    await expectStatus(adapter(), 'down', /returned 500/)
  })

  test('is down when the body is not JSON', async () => {
    stubFetch(notJson)
    await expectStatus(adapter(), 'down')
  })
})

describe('local adapters', () => {
  test('systemd is down when systemctl fails', async () => {
    failures.execFile = true
    await expectStatus(createSystemdAdapter({ unit: 'missing.service', scope: 'user' }), 'down', /No medium found/)
  })

  test('disk is down when the path cannot be statted', async () => {
    await expectStatus(createDiskAdapter('/does/not/exist'), 'down', /ENOENT/)
  })

  test('uptime is down when /proc/uptime cannot be read', async () => {
    failures.readFile = true
    await expectStatus(createUptimeAdapter(), 'down', /ENOENT/)
  })
})

describe('ai-usage', () => {
  const remote = (handler: FetchHandler) =>
    createRemoteHostSource('remote', 'http://shim.test/usage', 'token', vi.fn(handler))

  test.each([
    ['a network error', networkError],
    ['a non-2xx response', status500],
    ['a body that is not JSON', notJson],
  ])('is unreachable when the only host fails with %s', async (_label, handler) => {
    const result = await expectStatus(createAiUsageAdapter([remote(handler)]), 'unreachable')
    const hosts = result.detail?.hosts as Array<{ status: string; error?: string }>
    assert.equal(hosts[0]?.status, 'unreachable')
    assert.ok(hosts[0]?.error)
  })
})
