import { describe, expect, it, vi } from 'vitest'
import { runCheck } from './poller.js'
import { createT3StaleAdapter, evaluateT3Stale, runT3StaleCheck, type T3StaleDeps } from './t3-stale.js'

vi.mock('./record-check.js', () => ({ recordCheck: vi.fn() }))

// What argus-config's hooks/t3-stale.py --no-state really printed on WSL2,
// 2026-11-11: one day behind, under the 3-day threshold.
const CURRENT = { host: 'wsl2', active: '0.1.8-nightly.20261109.4399', channel: 'nightly', threshold_days: 3, newest: '0.1.9', behind_days: 1, stale: false }
const STALE = {
  host: 'wsl2',
  active: '0.1.8-nightly.20261106.1',
  channel: 'nightly',
  threshold_days: 3,
  newest: '0.1.8-nightly.20261107.1',
  behind_days: 4,
  stale: true,
  line: 't3 stale: wsl2 0.1.8-nightly.20261106.1 is 4 days behind 0.1.8-nightly.20261107.1',
}
const HOOK = '/home/deanj/.argus/hooks/t3-stale.py'

function deps(output: string, overrides: Partial<T3StaleDeps> = {}) {
  const runs: Array<{ hook: string; host: string }> = []
  const value: T3StaleDeps = {
    hookPath: HOOK,
    run: async (hook, host) => {
      runs.push({ hook, host })
      return output
    },
    ...overrides,
  }
  return { deps: value, runs }
}

describe('runT3StaleCheck', () => {
  it('runs the T3 staleness hook for the host and keeps the JSON it prints', async () => {
    const { deps: value, runs } = deps(`${JSON.stringify(CURRENT)}\n`)
    const report = await runT3StaleCheck('wsl2', value)
    expect(runs).toEqual([{ hook: HOOK, host: 'wsl2' }])
    expect(report).toEqual({ reading: CURRENT, error: null })
  })

  it('reports a hook that cannot run, rather than calling the host current', async () => {
    const { deps: value } = deps('', { run: async () => { throw new Error(`python3: can't open file '${HOOK}'`) } })
    const report = await runT3StaleCheck('homelab', value)
    expect(report.reading).toBeNull()
    expect(report.error).toMatch(/can't open file/)
  })

  it('reports output that is not JSON', async () => {
    const { deps: value } = deps('Traceback (most recent call last):')
    const report = await runT3StaleCheck('wsl2', value)
    expect(report.reading).toBeNull()
    expect(report.error).toMatch(/not JSON/)
  })
})

describe('evaluateT3Stale', () => {
  it('is healthy at 0 days behind', () => {
    const result = evaluateT3Stale({ reading: { ...CURRENT, newest: CURRENT.active, behind_days: 0 }, error: null })
    expect(result.status).toBe('healthy')
    expect(result.detail).toEqual({ host: 'wsl2', channel: 'nightly', active: CURRENT.active, newest: CURRENT.active, behindDays: 0, thresholdDays: 3 })
  })

  it('is healthy under the hook’s threshold, however far behind', () => {
    expect(evaluateT3Stale({ reading: CURRENT, error: null }).status).toBe('healthy')
  })

  it('degrades when the hook says the host is stale', () => {
    const result = evaluateT3Stale({ reading: STALE, error: null })
    expect(result.status).toBe('degraded')
    expect(result.detail).toMatchObject({ behindDays: 4, thresholdDays: 3, newest: '0.1.8-nightly.20261107.1' })
  })

  it('degrades with the hook’s own words when it could not measure', () => {
    const reading = { host: 'wsl2', error: 't3 stale: no readable activeVersion in /home/deanj/.t3/runtime/service-state.json' }
    expect(() => evaluateT3Stale({ reading, error: null })).toThrow(reading.error)
  })

  it('degrades when the hook could not be run', () => {
    expect(() => evaluateT3Stale({ reading: null, error: 'no such file' })).toThrow(/t3-stale.py could not run: no such file/)
  })

  it('degrades on a reading with no version or day count', () => {
    expect(() => evaluateT3Stale({ reading: { host: 'wsl2', stale: false }, error: null })).toThrow(/unusable/)
  })
})

describe('createT3StaleAdapter', () => {
  it('polls inside the dashboard’s stale allowance, as `<host>:t3-stale`', () => {
    const adapter = createT3StaleAdapter('homelab', async () => ({ reading: CURRENT, error: null }))
    expect(adapter.key).toBe('homelab:t3-stale')
    expect(adapter.host).toBe('homelab')
    expect(adapter.intervalMs).toBe(300_000)
  })

  it('records a stale host as degraded with the detail', async () => {
    const adapter = createT3StaleAdapter('wsl2', async () => ({ reading: STALE, error: null }))
    const result = await runCheck(adapter)
    expect(result.status).toBe('degraded')
    expect(result.detail).toMatchObject({ host: 'wsl2', behindDays: 4 })
  })

  it('says so when the host report has no T3 part', async () => {
    const adapter = createT3StaleAdapter('lnv-lgn5', async () => undefined)
    const result = await runCheck(adapter)
    expect(result.status).toBe('degraded')
    expect(JSON.stringify(result.detail)).toMatch(/redeploy/)
  })
})
