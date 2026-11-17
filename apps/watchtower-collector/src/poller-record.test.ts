import { afterEach, expect, test, vi } from 'vitest'
import { recordResult } from './poller.js'

const recordCheck = vi.hoisted(() => vi.fn())
vi.mock('./record-check.js', () => ({ recordCheck }))

afterEach(() => {
  vi.restoreAllMocks()
  recordCheck.mockReset()
})

const adapter = { key: 'systemd:paperless', host: 'homelab', intervalMs: 30_000, check: async () => ({ status: 'healthy' as const }) }

test('a failed record logs the cause code, not just "fetch failed"', async () => {
  const error = vi.spyOn(console, 'error').mockImplementation(() => {})
  recordCheck.mockRejectedValue(new TypeError('fetch failed', { cause: Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }) }))

  await recordResult(adapter, { status: 'healthy' })

  expect(error).toHaveBeenCalledWith('[poller] failed to record systemd:paperless:', 'fetch failed (cause ECONNRESET: read ECONNRESET)')
})

test('a failed record does not throw into the poll loop', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
  recordCheck.mockRejectedValue(new Error('boom'))

  await expect(recordResult(adapter, { status: 'healthy' })).resolves.toBeUndefined()
})
