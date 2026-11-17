import { describe, expect, it } from 'vitest'
import {
  BUDGET_API_CRON_SERVICE,
  BUDGET_API_CRON_TIMER,
  CLOUDFLARED_SERVICE,
  MISSING_SERVICE,
  NOTICE_BOARD_SERVICE,
  TASKVIEW_MIGRATE_SERVICE,
  withProperties,
} from './__fixtures__/systemd.js'
import { readFileSync } from 'node:fs'
import { evaluateUnit, parseProperties, parseSystemdTime, UNIT_PROPERTIES } from './systemd-unit.js'

const props = parseProperties

describe('parseSystemdTime', () => {
  it('reads a TZ=UTC systemd timestamp as ISO', () => {
    expect(parseSystemdTime('Fri 2026-10-16 09:00:11 UTC')).toBe('2026-10-16T09:00:11.000Z')
  })

  it('is null for an empty or n/a value', () => {
    expect(parseSystemdTime('')).toBeNull()
    expect(parseSystemdTime('n/a')).toBeNull()
    expect(parseSystemdTime(undefined)).toBeNull()
  })

  it('refuses a timestamp in any zone but UTC, rather than guess its offset', () => {
    expect(parseSystemdTime('Fri 2026-10-16 20:00:11 AEDT')).toBeNull()
  })
})

describe('UNIT_PROPERTIES', () => {
  it('asks for every property evaluateUnit reads', () => {
    for (const name of ['LoadState', 'ActiveState', 'SubState', 'Result', 'ActiveEnterTimestamp', 'NRestarts', 'Unit', 'LastTriggerUSec', 'NextElapseUSecRealtime', 'NextElapseUSecMonotonic', 'ExecMainStatus', 'ExecMainStartTimestamp', 'ExecMainExitTimestamp']) {
      expect(UNIT_PROPERTIES).toContain(name)
    }
  })
})

describe('evaluateUnit — services', () => {
  it('is healthy while running, with its uptime start and restart count', () => {
    expect(evaluateUnit('user', props(NOTICE_BOARD_SERVICE))).toEqual({
      status: 'healthy',
      detail: {
        scope: 'user',
        loadState: 'loaded',
        activeState: 'active',
        subState: 'running',
        result: 'success',
        activeSince: '2026-10-10T23:58:26.000Z',
        restarts: 2,
      },
    })
  })

  it('records the scope of a system unit', () => {
    expect(evaluateUnit('system', props(CLOUDFLARED_SERVICE)).detail.scope).toBe('system')
  })

  it('is degraded while activating', () => {
    const activating = withProperties(NOTICE_BOARD_SERVICE, { ActiveState: 'activating', SubState: 'auto-restart' })
    expect(evaluateUnit('user', props(activating)).status).toBe('degraded')
  })

  it('is down when failed or stopped', () => {
    expect(evaluateUnit('user', props(TASKVIEW_MIGRATE_SERVICE)).status).toBe('down')
    expect(evaluateUnit('user', props(withProperties(NOTICE_BOARD_SERVICE, { ActiveState: 'inactive', SubState: 'dead' }))).status).toBe('down')
  })

  it('is down when the unit is not installed', () => {
    const result = evaluateUnit('user', props(MISSING_SERVICE))
    expect(result.status).toBe('down')
    expect(result.detail.loadState).toBe('not-found')
  })
})

describe('evaluateUnit — timers', () => {
  const timer = props(BUDGET_API_CRON_TIMER)
  const service = props(BUDGET_API_CRON_SERVICE)

  it('is healthy when waiting and the last run succeeded, reporting the last trigger and its result', () => {
    expect(evaluateUnit('user', timer, service)).toEqual({
      status: 'healthy',
      detail: {
        scope: 'user',
        loadState: 'loaded',
        activeState: 'active',
        subState: 'waiting',
        result: 'success',
        activeSince: '2026-10-09T00:13:02.000Z',
        restarts: null,
        timer: {
          service: 'budget-api-cron.service',
          lastTrigger: '2026-10-16T09:00:11.000Z',
          nextTrigger: '2026-10-17T09:00:00.000Z',
          unscheduled: false,
          lastRun: {
            activeState: 'inactive',
            result: 'success',
            exitStatus: 0,
            startedAt: '2026-10-16T09:00:11.000Z',
            exitedAt: '2026-10-16T09:00:49.000Z',
          },
        },
      },
    })
  })

  it('is down when the last run failed', () => {
    const failed = props(withProperties(BUDGET_API_CRON_SERVICE, { Result: 'exit-code', ExecMainStatus: '1', ActiveState: 'failed', SubState: 'failed' }))
    const result = evaluateUnit('user', timer, failed)
    expect(result.status).toBe('down')
    expect(result.detail.timer?.lastRun).toMatchObject({ result: 'exit-code', exitStatus: 1 })
  })

  it('is healthy while the triggered service is running now', () => {
    const running = props(withProperties(BUDGET_API_CRON_SERVICE, { ActiveState: 'activating', SubState: 'start', ExecMainExitTimestamp: '' }))
    expect(evaluateUnit('user', timer, running).status).toBe('healthy')
  })

  it('is degraded when the timer has never fired', () => {
    const fresh = props(withProperties(BUDGET_API_CRON_TIMER, { LastTriggerUSec: '' }))
    const neverRan = props(withProperties(BUDGET_API_CRON_SERVICE, { ExecMainStartTimestamp: '', ExecMainExitTimestamp: '' }))
    const result = evaluateUnit('user', fresh, neverRan)
    expect(result.status).toBe('degraded')
    expect(result.detail.timer?.lastTrigger).toBeNull()
  })

  it('is down when the timer itself is stopped, whatever its last run', () => {
    const stopped = props(withProperties(BUDGET_API_CRON_TIMER, { ActiveState: 'inactive', SubState: 'dead' }))
    expect(evaluateUnit('user', stopped, service).status).toBe('down')
  })

  // homelab's syncthing-drift-poller.timer as captured on 2026-10-16: it last
  // fired on 10-08, then sat `active (elapsed)` with nothing scheduled.
  const homelab = JSON.parse(readFileSync(new URL('./__fixtures__/timers-homelab.json', import.meta.url), 'utf8')) as Record<string, { unit: Record<string, string>; triggers: Record<string, string> }>
  const stalled = homelab['syncthing-drift-poller.timer']!

  it('is degraded when it is active but has no next trigger, and says so', () => {
    const result = evaluateUnit('user', stalled.unit, stalled.triggers)
    expect(result.status).toBe('degraded')
    expect(result.detail.timer).toMatchObject({ nextTrigger: null, unscheduled: true, lastTrigger: '2026-10-08T23:55:01.000Z' })
  })

  it('treats an unset monotonic elapse (empty or 0) as no next trigger too', () => {
    for (const monotonic of ['', '0']) {
      const unit = { ...stalled.unit, NextElapseUSecMonotonic: monotonic }
      expect(evaluateUnit('user', unit, stalled.triggers).status).toBe('degraded')
    }
  })

  it('is healthy when only a monotonic trigger is scheduled', () => {
    const unit = { ...stalled.unit, SubState: 'waiting', NextElapseUSecMonotonic: '3d 4h 12min' }
    const result = evaluateUnit('user', unit, stalled.triggers)
    expect(result.status).toBe('healthy')
    expect(result.detail.timer?.unscheduled).toBe(false)
  })

  it('is healthy with a realtime next trigger whatever the monotonic one says', () => {
    expect(evaluateUnit('user', timer, service).detail.timer?.unscheduled).toBe(false)
  })

  it('does not judge the schedule from a report that lacks the monotonic property', () => {
    const { NextElapseUSecMonotonic: _omitted, ...older } = stalled.unit
    const result = evaluateUnit('user', older, stalled.triggers)
    expect(result.status).toBe('healthy')
    expect(result.detail.timer?.unscheduled).toBeNull()
  })

  it('still reports a failed last run as down rather than unscheduled', () => {
    const failed = { ...stalled.triggers, ActiveState: 'failed', Result: 'exit-code', ExecMainStatus: '1' }
    expect(evaluateUnit('user', stalled.unit, failed).status).toBe('down')
  })

  it('is healthy while its service runs, when systemd has no next elapse yet', () => {
    const running = { ...stalled.triggers, ActiveState: 'activating', SubState: 'start' }
    expect(evaluateUnit('user', stalled.unit, running).status).toBe('healthy')
  })
})
