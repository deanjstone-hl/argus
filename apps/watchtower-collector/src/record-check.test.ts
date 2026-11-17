import { expect, test, vi } from 'vitest'

import type { CheckTarget } from './post-check.js'
import { recordToTargets } from './record-check.js'

const input = { service_key: 'systemd:paperless', host: 'homelab', status: 'healthy', detail: null } as const

const target = (name: 'd1' | 'hub', record: CheckTarget['record']): CheckTarget => ({ name, record })

test('writes each check to every target, the same payload', async () => {
  const d1 = vi.fn(async () => {})
  const hub = vi.fn(async () => {})

  await recordToTargets([target('d1', d1), target('hub', hub)], input)

  expect(d1).toHaveBeenCalledWith(input, {})
  expect(hub).toHaveBeenCalledWith(input, {})
})

test('a hub that is down does not stop the D1 write, and the failure names the hub', async () => {
  const d1 = vi.fn(async () => {})
  const hub = vi.fn(async () => {
    throw new TypeError('fetch failed', { cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }) })
  })

  await expect(recordToTargets([target('d1', d1), target('hub', hub)], input)).rejects.toThrow('hub: fetch failed (cause ECONNREFUSED: connect ECONNREFUSED)')
  expect(d1).toHaveBeenCalledTimes(1)
})

test('a D1 failure does not stop the hub write either', async () => {
  const hub = vi.fn(async () => {})

  await expect(
    recordToTargets(
      [
        target('d1', async () => {
          throw new Error('worker-client: POST /watchtower/checks failed with 503: down')
        }),
        target('hub', hub),
      ],
      input,
    ),
  ).rejects.toThrow('d1: worker-client: POST /watchtower/checks failed with 503: down')
  expect(hub).toHaveBeenCalledTimes(1)
})

test('both failing reports both', async () => {
  const fail = (message: string) => async () => {
    throw new Error(message)
  }

  await expect(recordToTargets([target('d1', fail('one')), target('hub', fail('two'))], input)).rejects.toThrow('d1: one; hub: two')
})

test('passes the retry options on to every target', async () => {
  const d1 = vi.fn(async () => {})

  await recordToTargets([target('d1', d1)], input, { retryDelayMs: 0 })

  expect(d1).toHaveBeenCalledWith(input, { retryDelayMs: 0 })
})

test('with both flags on, one check reaches the Worker and the hub with the same body', async () => {
  const { resolveTargets } = await import('./check-targets.js')
  const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(null, { status: 204 }))
  const targets = resolveTargets({
    WATCHTOWER_WORKER_URL: 'https://api.myargus.cc',
    WATCHTOWER_COLLECTOR_TOKEN: 'd1-token',
    WATCHTOWER_HUB_URL: 'http://127.0.0.1:3790',
    WATCHTOWER_HUB_TOKEN: 'hub-token',
  })

  await recordToTargets(targets, input)

  const calls = fetchMock.mock.calls.map(([url, init]) => ({ url, auth: (init?.headers as Record<string, string>).authorization, body: init?.body }))
  fetchMock.mockRestore()
  expect(calls).toEqual([
    { url: 'https://api.myargus.cc/watchtower/checks', auth: 'Bearer d1-token', body: JSON.stringify(input) },
    { url: 'http://127.0.0.1:3790/watchtower/checks', auth: 'Bearer hub-token', body: JSON.stringify(input) },
  ])
})
