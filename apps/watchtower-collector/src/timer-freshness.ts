import type { HostReport, TimerFreshnessDetail, TimerProblem, TimersDetail } from '@argus/watchtower-contract'
import type { Adapter } from './adapter.js'
import { createLimiter } from './limit.js'
import { hasNextTrigger, parseProperties, parseSystemdTime, UNIT_PROPERTIES } from './systemd-unit.js'

// The timer-freshness card: every --user timer on a host, judged on whether
// it will run on time. The per-unit systemd cards cover a chosen few; this one
// covers the timers nobody chose to watch, which is where a stuck one hides.
// Shared by homelab (read here) and WSL2 (read by the usage-shim, whose list
// of properties must stay in step with this one).

type Timers = NonNullable<HostReport['timers']>
type RunSystemctl = (args: string[]) => Promise<string>

export const TIMER_PROPERTIES = [...UNIT_PROPERTIES, 'UnitFileState', 'FragmentPath']

// States a timer starts from at boot. `linked` alone is a unit file made
// available but never enabled.
const ENABLED_STATES = new Set(['enabled', 'enabled-runtime', 'static', 'indirect', 'generated', 'transient', 'alias'])
// A package's own timer (systemd-tmpfiles-clean, launchpadlib-cache-clean).
const VENDOR_PATH = /^\/(?:usr\/)?lib\//
// A realtime timer is due at its next elapse; allow it time to start.
const OVERDUE_GRACE_MS = 5 * 60_000

export interface TimersResult {
  status: 'healthy' | 'degraded'
  detail: TimersDetail
}

async function show(run: RunSystemctl, unit: string): Promise<Record<string, string>> {
  return parseProperties(await run(['--user', 'show', unit, `--property=${TIMER_PROPERTIES.join(',')}`]))
}

function timerNames(listing: string): string[] {
  return listing
    .split('\n')
    .map((line) => line.trim().split(/\s+/)[0] ?? '')
    .filter((name) => name.endsWith('.timer'))
}

const SYSTEMCTL_CONCURRENCY = 4

// A template (`loop-wake@.timer`) is not a unit: `systemctl show` refuses its name.
const isTemplate = (name: string) => name.includes('@.')

// A timer whose `show` failed is reported as a unit that did not load, so the
// card names it instead of failing for every other timer on the host.
async function readTimer(run: RunSystemctl, name: string): Promise<Timers[string]> {
  try {
    const unit = await show(run, name)
    return unit.Unit ? { unit, triggers: await show(run, unit.Unit) } : { unit }
  } catch (error) {
    console.warn(`[timers] systemctl show ${name} failed:`, error instanceof Error ? error.message : error)
    return { unit: { Id: name, LoadState: 'error' } }
  }
}

// list-unit-files, not list-timers: it names disabled timers too. It names a
// template but never its instances, so those (`loop-wake@afk.timer`) come from
// list-units, and the template itself is skipped.
export async function listUserTimers(run: RunSystemctl): Promise<Timers> {
  const files = await run(['--user', 'list-unit-files', '--type=timer', '--no-legend', '--plain'])
  const loaded = await run(['--user', 'list-units', '--type=timer', '--all', '--no-legend', '--plain'])
  const instances = timerNames(loaded).filter((name) => name.includes('@'))
  const names = [...new Set([...timerNames(files), ...instances])].filter((name) => !isTemplate(name))
  // Two systemctl processes a timer: let a few run at a time, not all of them.
  const limit = createLimiter(SYSTEMCTL_CONCURRENCY)
  const entries = await Promise.all(names.map((name) => limit(async () => [name, await readTimer(run, name)] as const)))
  return Object.fromEntries(entries)
}

function optionalNumber(value: string | undefined): number | null {
  if (value === undefined || value === '') return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function judge(entry: Timers[string], name: string, now: number): TimerFreshnessDetail {
  const { unit } = entry
  const service = entry.triggers ?? {}
  const unitFileState = unit.UnitFileState || 'unknown'
  const activeState = unit.ActiveState || 'unknown'
  const vendor = VENDOR_PATH.test(unit.FragmentPath ?? '')
  const lastRun = {
    activeState: service.ActiveState || 'unknown',
    result: service.Result || null,
    exitStatus: optionalNumber(service.ExecMainStatus),
    startedAt: parseSystemdTime(service.ExecMainStartTimestamp),
    exitedAt: parseSystemdTime(service.ExecMainExitTimestamp),
  }
  const running = lastRun.activeState === 'activating' || lastRun.activeState === 'active'
  const finishedWell = !running && lastRun.result === 'success' && lastRun.activeState !== 'failed'
  const nextTrigger = parseSystemdTime(unit.NextElapseUSecRealtime)

  let problem: TimerProblem | null = null
  if ((unit.LoadState ?? 'unknown') !== 'loaded') problem = 'not-loaded'
  else if (!ENABLED_STATES.has(unitFileState)) problem = vendor ? null : 'disabled'
  else if (activeState !== 'active') problem = 'inactive'
  else if (hasNextTrigger(unit) !== true) problem = 'unscheduled'
  else if (nextTrigger !== null && now - Date.parse(nextTrigger) > OVERDUE_GRACE_MS) problem = 'overdue'
  else if (!running && lastRun.startedAt !== null && !finishedWell) problem = 'failed'

  return {
    timer: name,
    service: unit.Unit ?? '',
    unitFileState,
    activeState,
    vendor,
    lastTrigger: parseSystemdTime(unit.LastTriggerUSec),
    nextTrigger,
    lastRun,
    lastSuccessAt: finishedWell ? (lastRun.exitedAt ?? lastRun.startedAt) : null,
    problem,
  }
}

export function evaluateTimers(host: string, timers: Timers, now: number): TimersResult {
  const judged = Object.keys(timers)
    .sort()
    .map((name) => judge(timers[name] as Timers[string], name, now))
  const detail: TimersDetail = { host, timers: judged }
  // No timers at all means the listing itself went wrong: every host here has some.
  const status = judged.length === 0 || judged.some((timer) => timer.problem !== null) ? 'degraded' : 'healthy'
  return { status, detail }
}

export function createTimersAdapter(host: string, read: () => Promise<Timers>, failureStatus?: Adapter['failureStatus']): Adapter {
  return {
    key: `${host}:timers`,
    host,
    intervalMs: 60_000,
    ...(failureStatus ? { failureStatus } : {}),
    check: async () => evaluateTimers(host, await read(), Date.now()),
  }
}
