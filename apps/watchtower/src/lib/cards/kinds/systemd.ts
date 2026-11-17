import type { CheckDetail, SystemdTimerDetail } from '@argus/watchtower-contract'
import { num, record, row, rows, text, timeRow } from '../fields'
import type { CardContent, CardFormatter } from '../types'
import { formatAbsoluteTime, formatDuration, formatRelativeTime, formatUntil } from '../units'

// systemd units on homelab (`systemd:<unit>`) and on LNV-LGN5's WSL2
// (`lnv-lgn5:systemd:<unit>`). Rows recorded before the richer unit detail carry only
// activeState and subState, and still render.
const KEY = /^(?:[\w-]+:)?systemd:(.+)$/

function stateText(detail: CheckDetail): string | null {
  const activeState = text(detail, 'activeState')
  const subState = text(detail, 'subState')
  return activeState === null ? null : subState === null ? activeState : `${activeState} (${subState})`
}

function runResult(run: SystemdTimerDetail['lastRun']): string | null {
  if (run.result === null) return null
  return run.exitStatus !== null && run.exitStatus !== 0 ? `${run.result} (exit status ${run.exitStatus})` : run.result
}

function seconds(fromIso: string | null, toIso: string | null): number | null {
  if (fromIso === null || toIso === null) return null
  return Math.round((Date.parse(toIso) - Date.parse(fromIso)) / 1000)
}

function tookText(run: SystemdTimerDetail['lastRun']): string | null {
  const took = seconds(run.startedAt, run.exitedAt)
  if (took === null || took < 0) return null
  return took < 60 ? `${took}s` : formatDuration(took)
}

function formatTimer(detail: CheckDetail, timer: SystemdTimerDetail, now: number): CardContent {
  const { lastRun } = timer
  const lastAt = lastRun.startedAt ?? timer.lastTrigger
  const running = lastRun.activeState === 'activating' || lastRun.activeState === 'active'
  const result = runResult(lastRun)
  const ranAgo = lastAt === null ? null : `last ran ${formatRelativeTime(lastAt, now)}`

  // Rows recorded before the collector read the schedule carry no flag.
  const unscheduled = timer.unscheduled === true
  const failed = lastRun.activeState === 'failed' || (lastRun.result !== null && lastRun.result !== 'success')

  const timerActive = text(detail, 'activeState') === 'active' && text(detail, 'loadState') !== 'not-found'
  let reason: string | null
  if (text(detail, 'loadState') === 'not-found') reason = 'Not installed'
  else if (!timerActive) reason = `Timer ${stateText(detail) ?? 'not active'}`
  else if (lastAt === null) reason = 'Never triggered'
  else if (unscheduled && !failed) reason = `No next run scheduled (timer ${text(detail, 'subState') ?? 'active'}) · ${ranAgo}`
  else {
    const exit = lastRun.exitStatus !== null && lastRun.exitStatus !== 0 ? `, exit status ${lastRun.exitStatus}` : ''
    reason = `Last run ${formatRelativeTime(lastAt, now)} failed: ${lastRun.result ?? lastRun.activeState}${exit}`
  }

  return {
    summary: running ? `running now${ranAgo ? ` · ${ranAgo.replace('last ran', 'started')}` : ''}` : [ranAgo, result].filter(Boolean).join(' · ') || null,
    reason,
    rows: rows(
      timeRow('Last run', lastAt, now),
      row('Result', running ? 'running now' : result),
      running ? null : row('Took', tookText(lastRun)),
      timer.nextTrigger !== null
        ? row('Next run', formatUntil(timer.nextTrigger, now), { title: formatAbsoluteTime(timer.nextTrigger) })
        : unscheduled ? row('Next run', 'none scheduled') : null,
      row('Runs', timer.service || null),
      text(detail, 'scope') === 'system' ? row('Scope', 'system') : null,
    ),
  }
}

function formatService(detail: CheckDetail, now: number): CardContent {
  const state = stateText(detail)
  const activeSince = text(detail, 'activeSince')
  const upFor = activeSince === null ? null : formatDuration(Math.max(0, Math.round((now - Date.parse(activeSince)) / 1000)))
  const subState = text(detail, 'subState')
  const result = text(detail, 'result')
  const restarts = num(detail, 'restarts')
  const notInstalled = text(detail, 'loadState') === 'not-found'

  return {
    summary: notInstalled ? 'not installed' : upFor !== null && text(detail, 'activeState') === 'active' ? `${subState ?? 'active'} · up ${upFor}` : state,
    reason: notInstalled ? 'Not installed' : state === null ? null : result !== null && result !== 'success' ? `${state}: ${result}` : state,
    rows: rows(
      row('State', state),
      upFor === null ? null : row('Up for', upFor, { title: formatAbsoluteTime(activeSince as string) }),
      row('Restarts', restarts === null ? null : String(restarts)),
      text(detail, 'scope') === 'system' ? row('Scope', 'system') : null,
    ),
  }
}

export const systemdFormatter: CardFormatter = {
  id: 'systemd',
  matches: (check) => KEY.test(check.service_key),
  format: (check, detail, now) => {
    const timer = record(detail, 'timer') as SystemdTimerDetail | null
    return {
      title: KEY.exec(check.service_key)?.[1] ?? check.service_key,
      ...(timer !== null && record(timer, 'lastRun') !== null ? formatTimer(detail, timer, now) : formatService(detail, now)),
    }
  },
}
