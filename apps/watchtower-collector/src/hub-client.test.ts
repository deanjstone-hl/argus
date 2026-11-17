import { afterEach, expect, test, vi } from 'vitest'

import { createHubTarget } from './hub-client.js'

afterEach(() => {
  vi.restoreAllMocks()
})

const target = createHubTarget({ url: 'http://127.0.0.1:3790', token: 'hub-device-token' })
const input = { service_key: 'systemd:paperless', host: 'homelab', status: 'healthy', detail: { note: 'ok' } } as const
const fast = { retryDelayMs: 0 }

test('the hub target is named hub', () => {
  expect(target.name).toBe('hub')
})

test('POSTs the unchanged contract payload to the hub with the device token', async () => {
  const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 204 }))

  await target.record(input)

  expect(fetchMock).toHaveBeenCalledTimes(1)
  const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
  expect(url).toBe('http://127.0.0.1:3790/watchtower/checks')
  expect(init.method).toBe('POST')
  expect(init.headers).toMatchObject({ authorization: 'Bearer hub-device-token', 'content-type': 'application/json' })
  expect(JSON.parse(init.body as string)).toEqual(input)
})

test('a trailing slash on the hub URL does not double up', async () => {
  const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 204 }))

  await createHubTarget({ url: 'http://127.0.0.1:3790/', token: 't' }).record(input)

  expect(fetchMock.mock.calls[0]?.[0]).toBe('http://127.0.0.1:3790/watchtower/checks')
})

test('retries a 5xx once, never a 4xx', async () => {
  const retried = vi
    .spyOn(globalThis, 'fetch')
    .mockResolvedValueOnce(new Response('Bad Gateway', { status: 502 }))
    .mockResolvedValueOnce(new Response(null, { status: 204 }))
  await expect(target.record(input, fast)).resolves.toBeUndefined()
  expect(retried).toHaveBeenCalledTimes(2)

  retried.mockReset()
  retried.mockImplementation(async () => new Response('unauthorized', { status: 401 }))
  await expect(target.record(input, fast)).rejects.toThrow(/hub-client: POST \/watchtower\/checks failed with 401: unauthorized/)
  expect(retried).toHaveBeenCalledTimes(1)
})
