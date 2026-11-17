import { afterEach, test, vi } from 'vitest'
import assert from 'node:assert/strict'

import { createWorkerTarget } from './worker-client.js'

afterEach(() => {
  vi.restoreAllMocks()
})

const target = createWorkerTarget({ url: 'https://api.myargus.cc', token: 'test-collector-token' })
const recordCheck = target.record

test('the D1 target is named d1', () => {
  assert.equal(target.name, 'd1')
})

test('recordCheck POSTs the correct request shape', async () => {
  const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 204 }))

  await recordCheck({ service_key: 'systemd:paperless', host: 'homelab', status: 'healthy', detail: { note: 'ok' } })

  assert.equal(fetchMock.mock.calls.length, 1)
  const call = fetchMock.mock.calls[0]
  assert.ok(call)
  const [url, init] = call as unknown as [string, RequestInit]
  assert.equal(url, 'https://api.myargus.cc/watchtower/checks')
  assert.equal(init.method, 'POST')
  assert.equal((init.headers as Record<string, string>).authorization, 'Bearer test-collector-token')
  assert.equal((init.headers as Record<string, string>)['content-type'], 'application/json')
  assert.deepEqual(JSON.parse(init.body as string), {
    service_key: 'systemd:paperless',
    host: 'homelab',
    status: 'healthy',
    detail: { note: 'ok' },
  })
})

test('recordCheck sends no authorization header when no token is set', async () => {
  const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 204 }))

  await createWorkerTarget({ url: 'https://api.myargus.cc' }).record({ service_key: 'x', host: 'homelab', status: 'healthy' })

  const init = fetchMock.mock.calls[0]?.[1] as RequestInit
  assert.equal((init.headers as Record<string, string>).authorization, undefined)
})

test('recordCheck resolves on a 2xx response', async () => {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 204 }))

  await assert.doesNotReject(recordCheck({ service_key: 'x', host: 'homelab', status: 'healthy' }))
})

test('recordCheck throws on a non-2xx response', async () => {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('server error', { status: 500 }))

  await assert.rejects(
    recordCheck({ service_key: 'x', host: 'homelab', status: 'healthy' }, { retryDelayMs: 0 }),
    /worker-client: POST \/watchtower\/checks failed with 500/,
  )
})

const fast = { retryDelayMs: 0 }
const input = { service_key: 'x', host: 'homelab', status: 'healthy' } as const

test('recordCheck retries once after a network failure and resolves when the retry lands', async () => {
  const fetchMock = vi
    .spyOn(globalThis, 'fetch')
    .mockRejectedValueOnce(new TypeError('fetch failed', { cause: Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }) }))
    .mockResolvedValueOnce(new Response(null, { status: 204 }))

  await assert.doesNotReject(recordCheck(input, fast))
  assert.equal(fetchMock.mock.calls.length, 2)
})

test('recordCheck retries once after a 5xx response', async () => {
  const fetchMock = vi
    .spyOn(globalThis, 'fetch')
    .mockResolvedValueOnce(new Response('Bad Gateway', { status: 502 }))
    .mockResolvedValueOnce(new Response(null, { status: 204 }))

  await assert.doesNotReject(recordCheck(input, fast))
  assert.equal(fetchMock.mock.calls.length, 2)
})

test('recordCheck gives up after one retry and throws the second failure', async () => {
  const fetchMock = vi
    .spyOn(globalThis, 'fetch')
    .mockResolvedValueOnce(new Response('first', { status: 500 }))
    .mockResolvedValueOnce(new Response('second', { status: 503 }))

  await assert.rejects(recordCheck(input, fast), /failed with 503: second/)
  assert.equal(fetchMock.mock.calls.length, 2)
})

test('recordCheck does not retry a 4xx response, which the same request would meet again', async () => {
  const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('bad request', { status: 400 }))

  await assert.rejects(recordCheck(input, fast), /failed with 400/)
  assert.equal(fetchMock.mock.calls.length, 1)
})

test('recordCheck keeps the cause of a network failure that persists', async () => {
  const cause = Object.assign(new Error('getaddrinfo ENOTFOUND api.myargus.cc'), { code: 'ENOTFOUND' })
  vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('fetch failed', { cause }))

  await assert.rejects(recordCheck(input, fast), (error: unknown) => error instanceof TypeError && error.cause === cause)
})
