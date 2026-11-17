import type { TimerFreshnessDetail } from '@argus/watchtower-contract'
import { list } from '../fields'
import type { CardFormatter, DetailRow } from '../types'
import { formatAbsoluteTime, formatRelativeTime, formatUntil, pluralise } from '../units'

// Every --user timer on a host (`<host>:timers`), judged on whether it will
// run on time. The collector names the problem; this says it in words.
const KEY = /^[\w-]+:timers$/

const shortName = (timer: TimerFreshnessDetail) => timer.timer.replace(/\.timer$/, '')

// When the service last started, else when the timer last fired: systemd
// forgets a finished service's times once it unloads it.
function lastRanAt(timer: TimerFreshnessDetail): string | null {
  return timer.lastRun.startedAt ?? timer.lastTrigger
}

function failure(timer: TimerFreshnessDetail): string {
  const { result, exitStatus, activeState } = timer.lastRun
  return `${result ?? activeState}${exitStatus !== null && exitStatus !== 0 ? ` (exit status ${exitStatus})` : ''}`
}

function problemText(timer: TimerFreshnessDetail, now: number): string {
  const fired = timer.lastTrigger === null ? null : formatRelativeTime(timer.lastTrigger, now)
  switch (timer.problem) {
    case 'not-loaded':
      return 'is not installed'
    case 'disabled':
      return 'is disabled'
    case 'inactive':
      return `is not active (${timer.activeState})`
    case 'unscheduled':
      return `has nothing scheduled: ${fired === null ? 'it has never fired' : `it last fired ${fired}`} and will not fire again`
    case 'overdue':
      return `is overdue: due ${timer.nextTrigger === null ? 'already' : formatRelativeTime(timer.nextTrigger, now)}`
    case 'failed':
      return `last run failed: ${failure(timer)}`
    default:
      return 'is fine'
  }
}

// The short form, for the timer's own row; the reason has the rest, and
// the row's hover text the time it last ran.
function problemRow(timer: TimerFreshnessDetail): string {
  switch (timer.problem) {
    case 'unscheduled':
      return 'nothing scheduled'
    case 'failed':
      return `failed: ${timer.lastRun.result ?? timer.lastRun.activeState}`
    case 'inactive':
      return 'not active'
    case 'not-loaded':
      return 'not installed'
    default:
      return timer.problem ?? ''
  }
}

function onTimeRow(timer: TimerFreshnessDetail, now: number): string {
  if (timer.unitFileState === 'disabled' || timer.activeState !== 'active') return `${timer.unitFileState} (package default)`
  const running = timer.lastRun.activeState === 'activating' || timer.lastRun.activeState === 'active'
  const ranAt = lastRanAt(timer)
  const ran = running ? 'running now' : ranAt === null ? 'waiting for its first run' : `ran ${formatRelativeTime(ranAt, now)}`
  if (timer.nextTrigger === null) return ran
  const next = formatUntil(timer.nextTrigger, now)
  return `${ran} · ${next === 'due' ? 'due now' : `next ${next}`}`
}

function timerRow(timer: TimerFreshnessDetail, value: string): DetailRow {
  const ranAt = lastRanAt(timer)
  return { label: shortName(timer), value, ...(ranAt === null ? {} : { title: `Last ran ${formatAbsoluteTime(ranAt)}` }) }
}

export const timersFormatter: CardFormatter = {
  id: 'timers',
  matches: (check) => KEY.test(check.service_key),
  format: (_check, detail, now) => {
    const timers = list<TimerFreshnessDetail>(detail, 'timers')
    const failing = timers.filter((timer) => timer.problem !== null)
    const fine = timers.filter((timer) => timer.problem === null)
    return {
      title: 'Timers',
      summary:
        timers.length === 0
          ? 'no timers reported'
          : failing.length === 0
            ? `all ${pluralise(timers.length, 'timer')} on time`
            : `${failing.length} of ${pluralise(timers.length, 'timer')} will not run on time`,
      reason:
        timers.length === 0
          ? 'No timers reported: the listing failed'
          : failing.map((timer) => `${shortName(timer)} ${problemText(timer, now)}`).join('; ') || null,
      sections: [
        { title: 'Needs attention', rows: failing.map((timer) => timerRow(timer, problemRow(timer))) },
        { title: 'On time', rows: fine.map((timer) => timerRow(timer, onTimeRow(timer, now))) },
      ],
    }
  },
}
