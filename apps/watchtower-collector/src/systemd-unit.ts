import type { HealthStatus, SystemdTimerDetail, SystemdUnitDetail } from '@argus/watchtower-contract'

// How a systemd unit's `systemctl show` properties become a check. Shared by
// the homelab systemd adapter and the LNV-LGN5 host report, whose shim
// returns the same properties read on WSL2.

export const UNIT_PROPERTIES = [
  'Id',
  'LoadState',
  'ActiveState',
  'SubState',
  'Result',
  'ActiveEnterTimestamp',
  'NRestarts',
  'ExecMainStatus',
  'ExecMainStartTimestamp',
  'ExecMainExitTimestamp',
  'Unit',
  'LastTriggerUSec',
  'NextElapseUSecRealtime',
  'NextElapseUSecMonotonic',
]

export type UnitScope = SystemdUnitDetail['scope']

export interface UnitResult {
  status: HealthStatus
  detail: SystemdUnitDetail
}

export function parseProperties(output: string): Record<string, string> {
  const properties: Record<string, string> = {}
  for (const line of output.trim().split('\n')) {
    const [key, ...rest] = line.split('=')
    if (key) properties[key] = rest.join('=')
  }
  return properties
}

// systemctl prints times in the local zone, timer times included (they
// ignore --timestamp=unix), so it is run with TZ=UTC and anything else is
// refused rather than read with a guessed offset.
const UTC_TIMESTAMP = /(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) UTC$/

export function parseSystemdTime(value: string | undefined): string | null {
  const match = value === undefined ? null : UTC_TIMESTAMP.exec(value.trim())
  return match ? new Date(`${match[1]}T${match[2]}Z`).toISOString() : null
}

function optionalText(value: string | undefined): string | null {
  return value === undefined || value === '' ? null : value
}

function optionalNumber(value: string | undefined): number | null {
  if (value === undefined || value === '') return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

// Whether a timer has a next trigger at all. systemd prints an unset
// monotonic elapse as empty, 0 or infinity. Null when a realtime trigger is
// unset and the report has no monotonic property to settle it, as from a
// host-report shim older than this check.
export function hasNextTrigger(unit: Record<string, string>): boolean | null {
  if (parseSystemdTime(unit.NextElapseUSecRealtime) !== null) return true
  const monotonic = unit.NextElapseUSecMonotonic
  if (monotonic === undefined) return null
  return !['', '0', 'infinity'].includes(monotonic)
}

function timerDetail(timer: Record<string, string>, service: Record<string, string>): SystemdTimerDetail {
  return {
    service: timer.Unit ?? '',
    lastTrigger: parseSystemdTime(timer.LastTriggerUSec),
    nextTrigger: parseSystemdTime(timer.NextElapseUSecRealtime),
    unscheduled: unscheduled(timer),
    lastRun: {
      activeState: service.ActiveState ?? 'unknown',
      result: optionalText(service.Result),
      exitStatus: optionalNumber(service.ExecMainStatus),
      startedAt: parseSystemdTime(service.ExecMainStartTimestamp),
      exitedAt: parseSystemdTime(service.ExecMainExitTimestamp),
    },
  }
}

function unscheduled(timer: Record<string, string>): boolean | null {
  const next = hasNextTrigger(timer)
  return next === null ? null : !next
}

function serviceStatus(activeState: string, loadState: string): HealthStatus {
  if (loadState !== 'loaded') return 'down'
  if (activeState === 'active') return 'healthy'
  if (activeState === 'activating' || activeState === 'reloading') return 'degraded'
  return 'down'
}

// A timer is judged by the run it last triggered: the timer itself only
// says it is waiting. A run in progress counts as healthy, since its result
// is not in yet. An active timer with nothing scheduled will never fire
// again, however well its last run went: `active (elapsed)` looks waiting.
function timerStatus(detail: SystemdUnitDetail, timer: SystemdTimerDetail): HealthStatus {
  if (detail.loadState !== 'loaded' || detail.activeState !== 'active') return 'down'
  const { lastRun } = timer
  if (lastRun.activeState === 'activating' || lastRun.activeState === 'active') return 'healthy'
  if (timer.lastTrigger === null && lastRun.startedAt === null) return 'degraded'
  if (lastRun.activeState === 'failed' || (lastRun.result !== null && lastRun.result !== 'success')) return 'down'
  if (timer.unscheduled === true) return 'degraded'
  return 'healthy'
}

export function evaluateUnit(
  scope: UnitScope,
  unit: Record<string, string>,
  triggers?: Record<string, string>,
): UnitResult {
  const isTimer = (unit.Id ?? '').endsWith('.timer')
  const detail: SystemdUnitDetail = {
    scope,
    loadState: unit.LoadState ?? 'unknown',
    activeState: unit.ActiveState ?? 'unknown',
    subState: unit.SubState ?? 'unknown',
    result: optionalText(unit.Result),
    activeSince: parseSystemdTime(unit.ActiveEnterTimestamp),
    // A timer has no restart counter of its own.
    restarts: isTimer ? null : optionalNumber(unit.NRestarts),
  }

  if (isTimer) {
    const timer = timerDetail(unit, triggers ?? {})
    return { status: timerStatus(detail, timer), detail: { ...detail, timer } }
  }
  return { status: serviceStatus(detail.activeState, detail.loadState), detail }
}
