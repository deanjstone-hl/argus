import { readFileSync } from 'node:fs'
import type { HostReport } from '@argus/watchtower-contract'
import { describe, expect, it, vi } from 'vitest'
import { runCheck } from '../poller.js'
import { createHostReportAdapters, createHostReportSource } from './host-report.js'

vi.mock('../record-check.js', () => ({ recordCheck: vi.fn() }))

// The usage-shim's real GET /host from WSL2 on LNV-LGN5, 2026-10-16 11:28 UTC:
// C: 59 GB free of 511 GB, two WSL dumps from 08:53 that day.
const REAL: HostReport = JSON.parse(readFileSync(new URL('../__fixtures__/host-report-lnv-lgn5.json', import.meta.url), 'utf8'))
const NOW = Date.parse('2026-10-16T11:30:00Z')
const GB = 1024 ** 3
const URL_ = 'http://100.64.0.1:8765/host'

function report(overrides: Partial<HostReport> = {}): HostReport {
  return { ...structuredClone(REAL), ...overrides }
}

function serve(body: unknown, status = 200) {
  const calls: Array<{ url: string; init?: RequestInit }> = []
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init })
    return new Response(JSON.stringify(body), { status })
  }) as typeof fetch
  return { fetchImpl, calls }
}

function adapters(body: unknown, status = 200) {
  const { fetchImpl, calls } = serve(body, status)
  const source = createHostReportSource({ url: URL_, token: 'shim-token', fetch: fetchImpl, now: () => NOW })
  const list = createHostReportAdapters(source, ['agent-engine.service', 'memory-reconcile.timer'], () => NOW, ['CONTEXT', 'CORTEX'])
  return { byKey: (key: string) => list.find((adapter) => adapter.key === key)!, list, calls }
}

describe('LNV-LGN5 adapters', () => {
  it('makes the C:, crash-dump, memory and unit cards under host lnv-lgn5', () => {
    const { list } = adapters(REAL)
    expect(list.map((adapter) => adapter.key)).toEqual([
      'lnv-lgn5:disk:C:',
      'lnv-lgn5:crash-dumps',
      'lnv-lgn5:memory',
      'lnv-lgn5:systemd:agent-engine.service',
      'lnv-lgn5:systemd:memory-reconcile.timer',
      'lnv-lgn5:timers',
      'lnv-lgn5:memory-reconcile',
      'lnv-lgn5:vault:CONTEXT',
      'lnv-lgn5:vault:CORTEX',
      'lnv-lgn5:t3-stale',
    ])
    for (const adapter of list) {
      expect(adapter.host).toBe('lnv-lgn5')
      expect(adapter.failureStatus).toBe('unreachable')
    }
  })

  it('fetches the report once for every card in a poll, with the shim token', async () => {
    const { list, calls } = adapters(REAL)
    await Promise.all(list.map((adapter) => runCheck(adapter)))
    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toBe(URL_)
    expect(new Headers(calls[0]?.init?.headers).get('authorization')).toBe('Bearer shim-token')
  })

  it('reports a sleeping laptop as unreachable on every card', async () => {
    const fetchImpl = (async () => {
      throw new Error('connect ETIMEDOUT 100.64.0.1:8765')
    }) as typeof fetch
    const source = createHostReportSource({ url: URL_, token: 't', fetch: fetchImpl, now: () => NOW })
    for (const adapter of createHostReportAdapters(source, ['agent-engine.service'], () => NOW)) {
      expect((await runCheck(adapter)).status).toBe('unreachable')
    }
  })

  it('reports a shim that answers with an error as degraded', async () => {
    const result = await runCheck(adapters({ error: 'unauthorized' }, 401).byKey('lnv-lgn5:memory'))
    expect(result.status).toBe('degraded')
    expect(result.detail).toEqual({ error: `${URL_} returned 401` })
  })
})

describe('C: free space', () => {
  it('is healthy with 59 GB free and reports used and free', async () => {
    const result = await runCheck(adapters(REAL).byKey('lnv-lgn5:disk:C:'))
    expect(result).toEqual({
      status: 'healthy',
      detail: { path: 'C:', totalBytes: 511054966784, freeBytes: 59013263360, pctUsed: 88 },
    })
  })

  it('is degraded from 90% used', async () => {
    const disk = { path: '/mnt/c', totalBytes: 500 * GB, freeBytes: 45 * GB }
    expect((await runCheck(adapters(report({ disk })).byKey('lnv-lgn5:disk:C:'))).status).toBe('degraded')
  })

  it('is down under 10 GB free — one more WSL dump fills it', async () => {
    const disk = { path: '/mnt/c', totalBytes: 500 * GB, freeBytes: 8 * GB }
    expect((await runCheck(adapters(report({ disk })).byKey('lnv-lgn5:disk:C:'))).status).toBe('down')
  })

  it('is degraded when the shim cannot see C:', async () => {
    const result = await runCheck(adapters(report({ disk: null })).byKey('lnv-lgn5:disk:C:'))
    expect(result).toEqual({ status: 'degraded', detail: { error: 'C: is not mounted at /mnt/c on WSL2' } })
  })
})

describe('crash dumps', () => {
  it('is degraded on the real day: two WSL dumps under 24 hours old', async () => {
    const result = await runCheck(adapters(REAL).byKey('lnv-lgn5:crash-dumps'))
    expect(result.status).toBe('degraded')
    expect(result.detail).toEqual(REAL.crashDumps)
  })

  it('is healthy once the newest WSL dump is a day old and they are small', async () => {
    const wsl = { ...REAL.crashDumps.wsl!, newestAt: '2026-10-15T08:00:00.000Z' }
    const result = await runCheck(adapters(report({ crashDumps: { wsl, windows: REAL.crashDumps.windows } })).byKey('lnv-lgn5:crash-dumps'))
    expect(result.status).toBe('healthy')
  })

  it('is degraded when WSL dumps hold 10 GB or more, however old', async () => {
    const wsl = { ...REAL.crashDumps.wsl!, count: 3, totalBytes: 12 * GB, newestAt: '2026-10-01T00:00:00.000Z' }
    const result = await runCheck(adapters(report({ crashDumps: { wsl, windows: null } })).byKey('lnv-lgn5:crash-dumps'))
    expect(result.status).toBe('degraded')
  })

  it('is healthy with no WSL dumps, whatever old Windows app dumps there are', async () => {
    const wsl = { path: REAL.crashDumps.wsl!.path, count: 0, totalBytes: 0, newestAt: null }
    const result = await runCheck(adapters(report({ crashDumps: { wsl, windows: REAL.crashDumps.windows } })).byKey('lnv-lgn5:crash-dumps'))
    expect(result.status).toBe('healthy')
  })
})

describe('memory pressure', () => {
  it('is healthy on the real day, with the totals and PSI', async () => {
    const result = await runCheck(adapters(REAL).byKey('lnv-lgn5:memory'))
    expect(result).toEqual({ status: 'healthy', detail: REAL.memory })
  })

  it('is degraded when tasks stall on memory 10% of the last minute', async () => {
    const pressure = { some: { avg10: 20, avg60: 12, avg300: 4 }, full: { avg10: 2, avg60: 1, avg300: 0.5 } }
    const result = await runCheck(adapters(report({ memory: { ...REAL.memory, pressure } })).byKey('lnv-lgn5:memory'))
    expect(result.status).toBe('degraded')
  })

  it('is down when every task stalls on memory 10% of the last minute', async () => {
    const pressure = { some: { avg10: 40, avg60: 30, avg300: 10 }, full: { avg10: 20, avg60: 15, avg300: 5 } }
    const result = await runCheck(adapters(report({ memory: { ...REAL.memory, pressure } })).byKey('lnv-lgn5:memory'))
    expect(result.status).toBe('down')
  })

  it('is degraded with under 10% of memory available', async () => {
    const memory = { ...REAL.memory, availableBytes: REAL.memory.totalBytes * 0.05 }
    expect((await runCheck(adapters(report({ memory })).byKey('lnv-lgn5:memory'))).status).toBe('degraded')
  })
})

describe('WSL2 units', () => {
  it('reports agent-engine running on WSL2 as healthy', async () => {
    const result = await runCheck(adapters(REAL).byKey('lnv-lgn5:systemd:agent-engine.service'))
    expect(result.status).toBe('healthy')
    expect(result.detail).toMatchObject({ scope: 'user', activeState: 'active', subState: 'running', activeSince: '2026-10-16T07:27:13.000Z' })
  })

  it('reports the memory-reconcile timer by its last run', async () => {
    const result = await runCheck(adapters(REAL).byKey('lnv-lgn5:systemd:memory-reconcile.timer'))
    expect(result.status).toBe('healthy')
    expect(result.detail).toMatchObject({ timer: { lastTrigger: '2026-10-16T11:27:01.000Z', lastRun: { result: 'success', exitStatus: 0 } } })
  })

  it('reports a unit the shim did not return as down', async () => {
    const result = await runCheck(adapters(report({ units: {} })).byKey('lnv-lgn5:systemd:agent-engine.service'))
    expect(result).toEqual({ status: 'down', detail: { error: 'agent-engine.service is not in the WSL2 host report' } })
  })
})

// The parts of GET /host the silent-failure cards read, captured on WSL2 at
// 2026-10-16 13:27 UTC: every --user timer, the reconciler's heartbeat, and
// both vaults clean by vault-staleness.sh.
describe('silent-failure cards from the host report', () => {
  const LATER = Date.parse('2026-10-16T13:30:00Z')
  const TIMERS = JSON.parse(readFileSync(new URL('../__fixtures__/timers-wsl2.json', import.meta.url), 'utf8'))
  const HEARTBEAT = JSON.parse(readFileSync(new URL('../__fixtures__/memory-reconcile-heartbeat-wsl2.json', import.meta.url), 'utf8'))
  const full = report({
    timers: TIMERS,
    memoryReconcile: { path: '/home/deanj/.argus/memory-reconcile-heartbeat.json', heartbeat: HEARTBEAT, error: null },
    vaults: [
      { name: 'CONTEXT', path: '/home/deanj/CONTEXT', checkout: true, lines: [], error: null },
      { name: 'CORTEX', path: '/home/deanj/CORTEX', checkout: true, lines: [], error: null },
    ],
    t3Stale: {
      reading: { host: 'wsl2', active: '0.1.8-nightly.20261106.1', channel: 'nightly', threshold_days: 3, newest: '0.1.8-nightly.20261107.1', behind_days: 4, stale: true },
      error: null,
    },
  })

  function byKey(body: unknown, key: string) {
    const { fetchImpl } = serve(body)
    const source = createHostReportSource({ url: URL_, token: 't', fetch: fetchImpl, now: () => LATER })
    return createHostReportAdapters(source, [], () => LATER, ['CONTEXT', 'CORTEX']).find((adapter) => adapter.key === key)!
  }

  it('judges every WSL2 timer on one card', async () => {
    const result = await runCheck(byKey(full, 'lnv-lgn5:timers'))
    expect(result.status).toBe('healthy')
    expect(result.detail).toMatchObject({ host: 'lnv-lgn5' })
    expect((result.detail as { timers: unknown[] }).timers).toHaveLength(6)
  })

  it('reads the memory-reconcile heartbeat, degraded by its refusal', async () => {
    const result = await runCheck(byKey(full, 'lnv-lgn5:memory-reconcile'))
    expect(result.status).toBe('degraded')
    expect(result.detail).toMatchObject({ lastRunAt: '2026-10-16T13:27:11.964Z', refusals: [{ key: 'project-linux-server' }] })
  })

  it('makes a card per vault', async () => {
    expect(await runCheck(byKey(full, 'lnv-lgn5:vault:CORTEX'))).toEqual({
      status: 'healthy',
      detail: { vault: 'CORTEX', path: '/home/deanj/CORTEX', checkout: true, lines: [] },
    })
  })

  it('reads the T3 version and days behind, degraded when the hook says stale', async () => {
    const result = await runCheck(byKey(full, 'lnv-lgn5:t3-stale'))
    expect(result.status).toBe('degraded')
    expect(result.detail).toEqual({
      host: 'wsl2',
      channel: 'nightly',
      active: '0.1.8-nightly.20261106.1',
      newest: '0.1.8-nightly.20261107.1',
      behindDays: 4,
      thresholdDays: 3,
    })
  })

  it('says a shim too old to report them is out of date', async () => {
    for (const key of ['lnv-lgn5:timers', 'lnv-lgn5:memory-reconcile', 'lnv-lgn5:vault:CONTEXT', 'lnv-lgn5:t3-stale']) {
      const result = await runCheck(byKey(REAL, key))
      expect(result.status, key).toBe('degraded')
      expect(result.detail, key).toEqual({ error: expect.stringMatching(/usage-shim does not report .*; redeploy it/) })
    }
  })
})
