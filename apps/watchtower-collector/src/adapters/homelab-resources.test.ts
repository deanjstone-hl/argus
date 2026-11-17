import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { runCheck } from '../poller.js'
import { createLoadAdapter, createMemoryAdapter } from './homelab-resources.js'

vi.mock('../record-check.js', () => ({ recordCheck: vi.fn() }))

// homelab, 2026-10-16 12:44 UTC: 4 CPUs, load 6.19 4.21 4.04.
const files: Record<string, string> = {
  '/proc/loadavg': readFileSync(new URL('../__fixtures__/homelab-loadavg.txt', import.meta.url), 'utf8'),
  '/proc/meminfo': readFileSync(new URL('../__fixtures__/homelab-meminfo.txt', import.meta.url), 'utf8'),
  '/proc/pressure/memory': readFileSync(new URL('../__fixtures__/homelab-pressure-memory.txt', import.meta.url), 'utf8'),
}

function reader(overrides: Record<string, string | Error> = {}) {
  return async (path: string) => {
    const value = path in overrides ? overrides[path] : files[path]
    if (value === undefined) throw new Error(`ENOENT: ${path}`)
    if (value instanceof Error) throw value
    return value
  }
}

describe('homelab load adapter', () => {
  it('reports the real load as healthy on 4 CPUs', async () => {
    const adapter = createLoadAdapter({ readFile: reader(), cpus: () => 4 })
    expect(adapter.key).toBe('homelab:load')
    expect(adapter.host).toBe('homelab')
    expect(await runCheck(adapter)).toEqual({
      status: 'healthy',
      detail: { load1: 6.19, load5: 4.21, load15: 4.04, cpus: 4 },
    })
  })

  it('is degraded when the 5-minute load reaches twice the CPUs', async () => {
    const adapter = createLoadAdapter({ readFile: reader({ '/proc/loadavg': '25.05 17.22 7.88 3/900 1\n' }), cpus: () => 4 })
    expect((await runCheck(adapter)).status).toBe('degraded')
    const atLine = createLoadAdapter({ readFile: reader({ '/proc/loadavg': '9.00 8.00 3.00 3/900 1\n' }), cpus: () => 4 })
    expect((await runCheck(atLine)).status).toBe('degraded')
  })

  it('ignores a 1-minute spike', async () => {
    const adapter = createLoadAdapter({ readFile: reader({ '/proc/loadavg': '14.00 5.00 3.00 3/900 1\n' }), cpus: () => 4 })
    expect((await runCheck(adapter)).status).toBe('healthy')
  })

  it('is down when /proc/loadavg cannot be read or parsed', async () => {
    expect((await runCheck(createLoadAdapter({ readFile: reader({ '/proc/loadavg': 'nonsense' }), cpus: () => 4 }))).status).toBe('down')
  })
})

describe('homelab memory adapter', () => {
  it('reports the real reading with PSI', async () => {
    const adapter = createMemoryAdapter({ readFile: reader() })
    expect(adapter.key).toBe('homelab:memory')
    const result = await runCheck(adapter)
    expect(result.status).toBe('healthy')
    expect(result.detail).toMatchObject({ pressure: { full: { avg60: 0.59 } } })
  })

  it('is degraded when memory stalls', async () => {
    const adapter = createMemoryAdapter({
      readFile: reader({ '/proc/pressure/memory': 'some avg10=20.00 avg60=14.00 avg300=5.00 total=1\nfull avg10=9.00 avg60=6.00 avg300=2.00 total=1\n' }),
    })
    expect((await runCheck(adapter)).status).toBe('degraded')
  })

  it('still reports memory on a kernel without PSI', async () => {
    const adapter = createMemoryAdapter({ readFile: reader({ '/proc/pressure/memory': new Error('ENOENT') }) })
    const result = await runCheck(adapter)
    expect(result.status).toBe('healthy')
    expect(result.detail).toMatchObject({ pressure: null })
  })
})
