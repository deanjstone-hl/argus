import { readFileSync } from 'node:fs'
import type { HostReport, TimerFreshnessDetail, TimersDetail } from '@argus/watchtower-contract'
import { describe, expect, it } from 'vitest'
import { evaluateTimers, listUserTimers, TIMER_PROPERTIES } from './timer-freshness.js'

type Timers = NonNullable<HostReport['timers']>

// Every --user timer with `TZ=UTC systemctl --user show`, captured
// 2026-10-16 13:27 UTC on WSL2 (LNV-LGN5) and on homelab. Homelab's
// syncthing-drift-poller.timer really was stuck: it last fired on 10-08 and
// has nothing scheduled, because its OnUnitActiveSec needs a run to count from.
const WSL2: Timers = JSON.parse(readFileSync(new URL('./__fixtures__/timers-wsl2.json', import.meta.url), 'utf8'))
const HOMELAB: Timers = JSON.parse(readFileSync(new URL('./__fixtures__/timers-homelab.json', import.meta.url), 'utf8'))
const NOW = Date.parse('2026-10-16T13:30:00Z')

function edit(timers: Timers, name: string, unit: Record<string, string>, triggers: Record<string, string> = {}): Timers {
  const copy = structuredClone(timers)
  const entry = copy[name]
  if (!entry) throw new Error(`no fixture timer ${name}`)
  entry.unit = { ...entry.unit, ...unit }
  entry.triggers = { ...entry.triggers, ...triggers }
  return copy
}

function timer(detail: TimersDetail | undefined, name: string): TimerFreshnessDetail {
  const found = detail?.timers.find((entry) => entry.timer === name)
  if (!found) throw new Error(`no ${name} in the detail`)
  return found
}

const problems = (detail: TimersDetail | undefined) =>
  (detail?.timers ?? []).filter((entry) => entry.problem !== null).map((entry) => [entry.timer, entry.problem])

describe('evaluateTimers', () => {
  it('passes every WSL2 timer, a disabled package timer included', () => {
    const result = evaluateTimers('lnv-lgn5', WSL2, NOW)
    expect(result.status).toBe('healthy')
    expect(result.detail.host).toBe('lnv-lgn5')
    expect(result.detail.timers.map((entry) => entry.timer)).toEqual([
      'argus-context-fetch-install.timer',
      'launchpadlib-cache-clean.timer',
      'memory-reconcile.timer',
      'systemd-tmpfiles-clean.timer',
      't3-auto-update.timer',
      'vault-sync.timer',
    ])
    expect(timer(result.detail, 'systemd-tmpfiles-clean.timer')).toMatchObject({ vendor: true, unitFileState: 'disabled', problem: null })
  })

  it('reads the last run and the last success of a timer', () => {
    const entry = timer(evaluateTimers('lnv-lgn5', WSL2, NOW).detail, 'memory-reconcile.timer')
    expect(entry).toMatchObject({
      service: 'memory-reconcile.service',
      unitFileState: 'enabled',
      activeState: 'active',
      vendor: false,
      lastTrigger: '2026-10-16T13:27:06.000Z',
      nextTrigger: '2026-10-16T13:47:00.000Z',
      problem: null,
    })
    expect(entry.lastRun.result).toBe('success')
    expect(entry.lastSuccessAt).toBe(entry.lastRun.exitedAt)
  })

  it('finds homelab’s stuck syncthing-drift-poller and nothing else', () => {
    const result = evaluateTimers('homelab', HOMELAB, NOW)
    expect(result.status).toBe('degraded')
    expect(problems(result.detail)).toEqual([['syncthing-drift-poller.timer', 'unscheduled']])
    expect(timer(result.detail, 'syncthing-drift-poller.timer').lastTrigger).toBe('2026-10-08T23:55:01.000Z')
  })

  it('does not fault a new timer waiting for its first run', () => {
    // secret-scan.timer: weekly, enabled two hours before the capture.
    expect(timer(evaluateTimers('homelab', HOMELAB, NOW).detail, 'secret-scan.timer')).toMatchObject({ lastTrigger: null, problem: null })
  })

  it('shows a disabled timer of ours as degraded', () => {
    const timers = edit(WSL2, 'memory-reconcile.timer', { UnitFileState: 'disabled', ActiveState: 'inactive', SubState: 'dead', NextElapseUSecRealtime: '' })
    const result = evaluateTimers('lnv-lgn5', timers, NOW)
    expect(result.status).toBe('degraded')
    expect(problems(result.detail)).toEqual([['memory-reconcile.timer', 'disabled']])
  })

  it('shows an enabled timer that is not running as inactive', () => {
    const timers = edit(WSL2, 'vault-sync.timer', { ActiveState: 'inactive', SubState: 'dead' })
    expect(problems(evaluateTimers('lnv-lgn5', timers, NOW).detail)).toEqual([['vault-sync.timer', 'inactive']])
  })

  it('shows a timer whose last run failed', () => {
    const timers = edit(WSL2, 't3-auto-update.timer', {}, { Result: 'exit-code', ExecMainStatus: '1', ActiveState: 'failed' })
    const result = evaluateTimers('lnv-lgn5', timers, NOW)
    expect(problems(result.detail)).toEqual([['t3-auto-update.timer', 'failed']])
    expect(timer(result.detail, 't3-auto-update.timer').lastSuccessAt).toBeNull()
  })

  it('shows a timer whose next run is more than five minutes late as overdue', () => {
    const timers = edit(WSL2, 'vault-sync.timer', { NextElapseUSecRealtime: 'Fri 2026-10-16 13:20:00 UTC' })
    expect(problems(evaluateTimers('lnv-lgn5', timers, NOW).detail)).toEqual([['vault-sync.timer', 'overdue']])
    const late = edit(WSL2, 'vault-sync.timer', { NextElapseUSecRealtime: 'Fri 2026-10-16 13:27:00 UTC' })
    expect(problems(evaluateTimers('lnv-lgn5', late, NOW).detail)).toEqual([])
  })

  it('treats a run in progress as fine', () => {
    const timers = edit(WSL2, 'vault-sync.timer', {}, { ActiveState: 'activating', Result: 'success' })
    expect(problems(evaluateTimers('lnv-lgn5', timers, NOW).detail)).toEqual([])
  })

  it('shows a timer whose unit file is gone as not loaded', () => {
    const timers = edit(WSL2, 'vault-sync.timer', { LoadState: 'not-found', ActiveState: 'inactive' })
    expect(problems(evaluateTimers('lnv-lgn5', timers, NOW).detail)).toEqual([['vault-sync.timer', 'not-loaded']])
  })

  it('is degraded when a host has no timers at all to report', () => {
    expect(evaluateTimers('lnv-lgn5', {}, NOW).status).toBe('degraded')
  })
})

describe('listUserTimers', () => {
  it('shows every timer list-unit-files names, with the service each triggers', async () => {
    const calls: string[][] = []
    const run = async (args: string[]) => {
      calls.push(args)
      if (args[1] === 'list-unit-files') return 'memory-reconcile.timer enabled enabled\nsystemd-tmpfiles-clean.timer disabled enabled\n'
      if (args[1] === 'list-units') return ''
      const unit = args[2] as string
      if (unit.endsWith('.timer')) return `Id=${unit}\nUnit=${unit.replace('.timer', '.service')}\nUnitFileState=enabled\n`
      return `Id=${unit}\nResult=success\n`
    }
    const timers = await listUserTimers(run)
    expect(calls[0]).toEqual(['--user', 'list-unit-files', '--type=timer', '--no-legend', '--plain'])
    expect(Object.keys(timers)).toEqual(['memory-reconcile.timer', 'systemd-tmpfiles-clean.timer'])
    expect(timers['memory-reconcile.timer']?.triggers).toEqual({ Id: 'memory-reconcile.service', Result: 'success' })
    const firstShow = calls.find((args) => args[1] === 'show')
    expect(firstShow?.slice(0, 3)).toEqual(['--user', 'show', 'memory-reconcile.timer'])
    expect(firstShow?.[3]).toBe(`--property=${TIMER_PROPERTIES.join(',')}`)
    for (const property of ['UnitFileState', 'FragmentPath', 'NextElapseUSecMonotonic']) expect(TIMER_PROPERTIES).toContain(property)
  })

  // The shapes systemctl really prints on homelab once loop-wake@.timer exists:
  // list-unit-files names the template, list-units names its instances, and
  // `show` on the template is refused outright.
  const TEMPLATE_UNIT_FILES = 'loop-wake@.timer disabled enabled\nmemory-reconcile.timer enabled enabled\n'
  const INSTANCE_UNITS = 'loop-wake@afk.timer loaded active waiting Loop wake afk\nmemory-reconcile.timer loaded active waiting Memory reconcile\n'

  function templateAwareRun(overrides: { show?: (unit: string) => string } = {}) {
    const calls: string[][] = []
    const run = async (args: string[]) => {
      calls.push(args)
      if (args[1] === 'list-unit-files') return TEMPLATE_UNIT_FILES
      if (args[1] === 'list-units') return INSTANCE_UNITS
      const unit = args[2] as string
      if (unit.includes('@.')) throw new Error(`Command failed: systemctl --user show ${unit}\nUnit name ${unit} is neither a valid invocation ID nor unit name.`)
      if (overrides.show) return overrides.show(unit)
      if (unit.endsWith('.timer')) return `Id=${unit}\nLoadState=loaded\nUnit=${unit.replace('.timer', '.service')}\nUnitFileState=enabled\n`
      return `Id=${unit}\nResult=success\n`
    }
    return { run, calls }
  }

  it('never runs show on a template, and checks its instances from list-units', async () => {
    const { run, calls } = templateAwareRun()
    const timers = await listUserTimers(run)
    expect(Object.keys(timers).sort()).toEqual(['loop-wake@afk.timer', 'memory-reconcile.timer'])
    expect(calls.filter((args) => args[1] === 'show').every((args) => !(args[2] as string).includes('@.'))).toBe(true)
    expect(calls).toContainEqual(['--user', 'list-units', '--type=timer', '--all', '--no-legend', '--plain'])
    expect(timers['loop-wake@afk.timer']?.triggers).toEqual({ Id: 'loop-wake@afk.service', Result: 'success' })
  })

  it('lists a timer once when list-units and list-unit-files both name it', async () => {
    const { run, calls } = templateAwareRun()
    await listUserTimers(run)
    expect(calls.filter((args) => args[1] === 'show' && args[2] === 'memory-reconcile.timer')).toHaveLength(1)
  })

  it('marks the one unit whose show fails, not the whole listing', async () => {
    const { run } = templateAwareRun({
      show: (unit) => {
        if (unit === 'loop-wake@afk.timer') throw new Error('Connection timed out')
        return unit.endsWith('.timer') ? `Id=${unit}\nLoadState=loaded\nUnit=${unit.replace('.timer', '.service')}\nUnitFileState=enabled\nActiveState=active\nNextElapseUSecRealtime=Fri 2026-10-16 13:40:00 UTC\n` : `Id=${unit}\nResult=success\n`
      },
    })
    const timers = await listUserTimers(run)
    expect(Object.keys(timers).sort()).toEqual(['loop-wake@afk.timer', 'memory-reconcile.timer'])
    expect(timers['memory-reconcile.timer']?.unit.LoadState).toBe('loaded')
    const result = evaluateTimers('homelab', timers, NOW)
    expect(problems(result.detail)).toEqual([['loop-wake@afk.timer', 'not-loaded']])
    expect(result.status).toBe('degraded')
  })

  it('keeps a template-only host healthy when the instance is fine', async () => {
    const { run } = templateAwareRun({
      show: (unit) =>
        unit.endsWith('.timer')
          ? `Id=${unit}\nLoadState=loaded\nUnit=${unit.replace('.timer', '.service')}\nUnitFileState=enabled\nActiveState=active\nNextElapseUSecRealtime=Fri 2026-10-16 13:40:00 UTC\n`
          : `Id=${unit}\nResult=success\nActiveState=inactive\n`,
    })
    const result = evaluateTimers('homelab', await listUserTimers(run), NOW)
    expect(problems(result.detail)).toEqual([])
  })
})
