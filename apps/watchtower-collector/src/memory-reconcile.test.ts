import { readFileSync } from 'node:fs'
import type { MemoryReconcileReport } from '@argus/watchtower-contract'
import { describe, expect, it } from 'vitest'
import { evaluateMemoryReconcile, MEMORY_RECONCILE_STALE_MS } from './memory-reconcile.js'

// WSL2's real ~/.argus/memory-reconcile-heartbeat.json at 2026-10-16 13:28
// UTC: a good run at 13:27, and one hash-mismatch refusal outstanding since
// 2026-09-29.
const HEARTBEAT = JSON.parse(readFileSync(new URL('./__fixtures__/memory-reconcile-heartbeat-wsl2.json', import.meta.url), 'utf8'))
const PATH = '/home/deanj/.argus/memory-reconcile-heartbeat.json'
const NOW = Date.parse('2026-10-16T13:30:00Z')
const MINUTE = 60_000

function report(heartbeat: unknown, error: string | null = null): MemoryReconcileReport {
  return { path: PATH, heartbeat, error }
}

describe('evaluateMemoryReconcile', () => {
  it('counts three missed 20-minute runs as stale', () => {
    expect(MEMORY_RECONCILE_STALE_MS).toBe(60 * MINUTE)
  })

  it('reads the real heartbeat: a fresh run, degraded by its one refusal', () => {
    const result = evaluateMemoryReconcile(report(HEARTBEAT), NOW)
    expect(result.status).toBe('degraded')
    expect(result.detail).toEqual({
      path: PATH,
      lastRunAt: '2026-10-16T13:27:11.964Z',
      ok: true,
      lastError: null,
      written: 0,
      deleted: 0,
      refusals: [{ key: 'project-linux-server', reason: 'hash-mismatch', seenAt: '2026-09-29T00:47:15.970Z' }],
      staleAfterMs: MEMORY_RECONCILE_STALE_MS,
    })
  })

  it('is healthy with a fresh good run and no refusals', () => {
    expect(evaluateMemoryReconcile(report({ ...HEARTBEAT, refusals: [] }), NOW).status).toBe('healthy')
  })

  it('reads a heartbeat from before refusals were recorded as none', () => {
    const { refusals: _refusals, ...older } = HEARTBEAT
    const result = evaluateMemoryReconcile(report(older), NOW)
    expect(result.status).toBe('healthy')
    expect(result.detail.refusals).toEqual([])
  })

  it('is degraded once the last run is over an hour old', () => {
    const lastRunAt = new Date(NOW - 61 * MINUTE).toISOString()
    expect(evaluateMemoryReconcile(report({ ...HEARTBEAT, lastRunAt, refusals: [] }), NOW).status).toBe('degraded')
    const recent = new Date(NOW - 59 * MINUTE).toISOString()
    expect(evaluateMemoryReconcile(report({ ...HEARTBEAT, lastRunAt: recent, refusals: [] }), NOW).status).toBe('healthy')
  })

  it('is down when the last run failed, with the reconciler’s error', () => {
    const result = evaluateMemoryReconcile(report({ lastRunAt: '2026-10-16T13:27:00.000Z', ok: false, error: 'vault lock held' }), NOW)
    expect(result.status).toBe('down')
    expect(result.detail).toMatchObject({ ok: false, lastError: 'vault lock held', written: null, refusals: [] })
  })

  it('throws degraded when there is no heartbeat file', () => {
    expect(() => evaluateMemoryReconcile(report(null), NOW)).toThrow(`no heartbeat at ${PATH}: memory-reconcile has not run on this machine`)
  })

  it('throws degraded when the heartbeat cannot be read or is not a heartbeat', () => {
    expect(() => evaluateMemoryReconcile(report(null, 'Unexpected end of JSON input'), NOW)).toThrow(/heartbeat .* unreadable: Unexpected end/)
    expect(() => evaluateMemoryReconcile(report({ ok: true }), NOW)).toThrow(/has no lastRunAt/)
  })
})
