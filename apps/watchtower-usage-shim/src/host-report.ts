import { execFile } from 'node:child_process'
import { readdir, readFile, stat, statfs } from 'node:fs/promises'
import { promisify } from 'node:util'
import type { HostDumpDirReport, HostPressure, HostReport, MemoryReconcileReport, T3StaleReport, VaultSyncReport } from '@argus/watchtower-contract'

const execFileAsync = promisify(execFile)

// GET /host: raw facts about this machine for the collector, which decides
// the status. Each part fails on its own, so one unreadable source still
// leaves the rest of the report.

// The properties the collector's evaluateUnit reads (watchtower-collector
// src/systemd-unit.ts); keep the two lists in step.
const UNIT_PROPERTIES = [
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

// The timer-freshness card's properties (watchtower-collector
// src/timer-freshness.ts TIMER_PROPERTIES); keep the two lists in step.
const TIMER_PROPERTIES = [...UNIT_PROPERTIES, 'UnitFileState', 'FragmentPath']

// vault-staleness.sh asks the remote with `git ls-remote`, so it is not run
// on every poll: the collector reads /host every minute, the vault cards
// every five.
const VAULT_CACHE_MS = 4 * 60_000

// t3-stale.py may call gh for the release feed, so it shares that cache
// window: under the dashboard's 15-minute stale allowance, over the 5-minute poll.
const T3_CACHE_MS = 4 * 60_000

export interface HostDeps {
  statfs: (path: string) => Promise<{ bsize: number; blocks: number; bavail: number }>
  readdir: (path: string) => Promise<string[]>
  stat: (path: string) => Promise<{ size: number; mtimeMs: number }>
  readFile: (path: string) => Promise<string>
  systemctl: (args: string[]) => Promise<string>
  isCheckout: (dir: string) => Promise<boolean>
  // argus-config's hooks/vault-staleness.sh for one vault: what it prints.
  runVaultHook: (hookPath: string, dir: string) => Promise<string>
  // argus-config's hooks/t3-stale.py --no-state for one host: what it prints.
  runT3Stale: (hookPath: string, host: string) => Promise<string>
  now: () => number
}

export interface HostConfig {
  // The Windows system drive as mounted in WSL2.
  diskPath: string
  // %LOCALAPPDATA% as a WSL path, e.g. /mnt/c/Users/<user>/AppData/Local.
  localAppData: string
  units: string[]
  // memory-mcp's reconciler heartbeat.
  heartbeatPath: string
  vaultHookPath: string
  vaults: Array<{ name: string; path: string }>
  t3StaleHookPath: string
  // The host name the hook reports under: wsl2 or homelab.
  t3Host: string
}

export const defaultHostDeps: HostDeps = {
  statfs: (path) => statfs(path),
  readdir: (path) => readdir(path),
  stat: (path) => stat(path),
  readFile: (path) => readFile(path, 'utf8'),
  // TZ=UTC: the collector reads systemd times only when they are in UTC.
  systemctl: async (args) => (await execFileAsync('systemctl', args, { env: { ...process.env, TZ: 'UTC' } })).stdout,
  isCheckout: async (dir) => {
    try {
      return (await stat(`${dir}/.git`)).isDirectory()
    } catch {
      return false
    }
  },
  // One vault per run, so each card hears only about its own.
  runVaultHook: async (hookPath, dir) =>
    (await execFileAsync('bash', [hookPath], { env: { ...process.env, VAULT_STALENESS_DIRS: dir }, timeout: 30_000 })).stdout,
  // --no-state: no message, no record. Two gh calls when the release feed is
  // not cached, each up to 60 s.
  runT3Stale: async (hookPath, host) =>
    (
      await execFileAsync('python3', ['-I', hookPath, '--no-state', '--host', host], {
        env: { ...process.env, LOOP_WAKE_HOST: host },
        timeout: 150_000,
      })
    ).stdout,
  now: Date.now,
}

const KIB = 1024

export function parseMeminfo(text: string): Omit<HostReport['memory'], 'pressure'> {
  const values = new Map<string, number>()
  for (const line of text.split('\n')) {
    const match = /^(\w+):\s+(\d+) kB$/.exec(line.trim())
    if (match) values.set(match[1] as string, Number(match[2]) * KIB)
  }
  const value = (key: string) => values.get(key) ?? 0
  return {
    totalBytes: value('MemTotal'),
    availableBytes: value('MemAvailable'),
    swapTotalBytes: value('SwapTotal'),
    swapFreeBytes: value('SwapFree'),
  }
}

export function parsePressure(text: string): { some: HostPressure; full: HostPressure } | null {
  const lines = new Map<string, HostPressure>()
  for (const line of text.split('\n')) {
    const match = /^(some|full) avg10=([\d.]+) avg60=([\d.]+) avg300=([\d.]+)/.exec(line.trim())
    if (match) lines.set(match[1] as string, { avg10: Number(match[2]), avg60: Number(match[3]), avg300: Number(match[4]) })
  }
  const some = lines.get('some')
  const full = lines.get('full')
  return some && full ? { some, full } : null
}

function parseProperties(output: string): Record<string, string> {
  const properties: Record<string, string> = {}
  for (const line of output.trim().split('\n')) {
    const [key, ...rest] = line.split('=')
    if (key) properties[key] = rest.join('=')
  }
  return properties
}

async function disk(config: HostConfig, deps: HostDeps): Promise<HostReport['disk']> {
  try {
    const stats = await deps.statfs(config.diskPath)
    return { path: config.diskPath, totalBytes: stats.blocks * stats.bsize, freeBytes: stats.bavail * stats.bsize }
  } catch (error) {
    console.warn(`[usage-shim] statfs ${config.diskPath} failed:`, error instanceof Error ? error.message : error)
    return null
  }
}

async function dumpDir(path: string, deps: HostDeps): Promise<HostDumpDirReport | null> {
  let names: string[]
  try {
    names = await deps.readdir(path)
  } catch (error) {
    // No folder: nothing has ever crashed there.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { path, count: 0, totalBytes: 0, newestAt: null }
    console.warn(`[usage-shim] reading ${path} failed:`, error instanceof Error ? error.message : error)
    return null
  }
  const dumps = await Promise.all(names.filter((name) => name.endsWith('.dmp')).map((name) => deps.stat(`${path}/${name}`)))
  const newest = dumps.reduce<number | null>((latest, dump) => (latest === null || dump.mtimeMs > latest ? dump.mtimeMs : latest), null)
  return {
    path,
    count: dumps.length,
    totalBytes: dumps.reduce((total, dump) => total + dump.size, 0),
    newestAt: newest === null ? null : new Date(newest).toISOString(),
  }
}

async function memory(deps: HostDeps): Promise<HostReport['memory']> {
  const meminfo = parseMeminfo(await deps.readFile('/proc/meminfo'))
  let pressure: HostReport['memory']['pressure'] = null
  try {
    pressure = parsePressure(await deps.readFile('/proc/pressure/memory'))
  } catch {
    // A kernel built without PSI has no /proc/pressure; report memory alone.
    pressure = null
  }
  return { ...meminfo, pressure }
}

async function show(unit: string, deps: HostDeps, properties = UNIT_PROPERTIES): Promise<Record<string, string>> {
  try {
    return parseProperties(await deps.systemctl(['--user', 'show', unit, `--property=${properties.join(',')}`]))
  } catch (error) {
    return { Id: unit, LoadState: 'error', error: error instanceof Error ? error.message : String(error) }
  }
}

async function units(config: HostConfig, deps: HostDeps): Promise<HostReport['units']> {
  const entries = await Promise.all(
    config.units.map(async (name) => {
      const unit = await show(name, deps)
      const triggers = name.endsWith('.timer') && unit.Unit ? await show(unit.Unit, deps) : undefined
      return [name, triggers ? { unit, triggers } : { unit }] as const
    }),
  )
  return Object.fromEntries(entries)
}

function timerNames(listing: string): string[] {
  return listing
    .split('\n')
    .map((line) => line.trim().split(/\s+/)[0] ?? '')
    .filter((name) => name.endsWith('.timer'))
}

// A template (`loop-wake@.timer`) is not a unit: `systemctl show` refuses its name.
const isTemplate = (name: string) => name.includes('@.')

// Every --user timer, disabled ones included (list-unit-files, not
// list-timers). list-unit-files names a template but never its instances, so
// those (`loop-wake@afk.timer`) come from list-units and the template itself
// is skipped, as in the collector's listUserTimers. Absent when systemctl
// cannot list them, so the card says the listing failed rather than that
// there are no timers. A timer whose `show` fails is reported as not loaded
// (see show) instead of failing the report.
async function timers(deps: HostDeps): Promise<HostReport['timers']> {
  let names: string[]
  try {
    const files = await deps.systemctl(['--user', 'list-unit-files', '--type=timer', '--no-legend', '--plain'])
    const loaded = await deps.systemctl(['--user', 'list-units', '--type=timer', '--all', '--no-legend', '--plain'])
    const instances = timerNames(loaded).filter((name) => name.includes('@'))
    names = [...new Set([...timerNames(files), ...instances])].filter((name) => !isTemplate(name))
  } catch (error) {
    console.warn('[usage-shim] listing timers failed:', error instanceof Error ? error.message : error)
    return undefined
  }
  const entries = await Promise.all(
    names.map(async (name) => {
      const unit = await show(name, deps, TIMER_PROPERTIES)
      return [name, unit.Unit ? { unit, triggers: await show(unit.Unit, deps, TIMER_PROPERTIES) } : { unit }] as const
    }),
  )
  return Object.fromEntries(entries)
}

async function memoryReconcile(config: HostConfig, deps: HostDeps): Promise<MemoryReconcileReport> {
  const path = config.heartbeatPath
  let text: string
  try {
    text = await deps.readFile(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { path, heartbeat: null, error: null }
    return { path, heartbeat: null, error: error instanceof Error ? error.message : String(error) }
  }
  try {
    return { path, heartbeat: JSON.parse(text) as unknown, error: null }
  } catch (error) {
    return { path, heartbeat: null, error: error instanceof Error ? error.message : String(error) }
  }
}

async function vault(config: HostConfig, entry: { name: string; path: string }, deps: HostDeps): Promise<VaultSyncReport> {
  const base = { name: entry.name, path: entry.path }
  if (!(await deps.isCheckout(entry.path))) return { ...base, checkout: false, lines: [], error: null }
  try {
    const output = await deps.runVaultHook(config.vaultHookPath, entry.path)
    return { ...base, checkout: true, lines: output.split('\n').map((line) => line.trim()).filter(Boolean), error: null }
  } catch (error) {
    return { ...base, checkout: true, lines: [], error: error instanceof Error ? error.message : String(error) }
  }
}

// Run in turn, not together: two ls-remotes at once gain nothing.
async function vaults(config: HostConfig, deps: HostDeps): Promise<VaultSyncReport[]> {
  const reports: VaultSyncReport[] = []
  for (const entry of config.vaults) reports.push(await vault(config, entry, deps))
  return reports
}

async function t3Stale(config: HostConfig, deps: HostDeps): Promise<T3StaleReport> {
  let output: string
  try {
    output = await deps.runT3Stale(config.t3StaleHookPath, config.t3Host)
  } catch (error) {
    return { reading: null, error: error instanceof Error ? error.message : String(error) }
  }
  try {
    return { reading: JSON.parse(output) as unknown, error: null }
  } catch {
    return { reading: null, error: `output was not JSON: ${output.trim().slice(0, 200) || 'empty'}` }
  }
}

async function collect(
  config: HostConfig,
  deps: HostDeps,
  readVaults: () => Promise<VaultSyncReport[]>,
  readT3Stale: () => Promise<T3StaleReport>,
): Promise<HostReport> {
  const [diskReport, wsl, windows, memoryReport, unitReports, timerReports, heartbeat, vaultReports, t3Report] = await Promise.all([
    disk(config, deps),
    dumpDir(`${config.localAppData}/Temp/wsl-crashes`, deps),
    dumpDir(`${config.localAppData}/CrashDumps`, deps),
    memory(deps),
    units(config, deps),
    timers(deps),
    memoryReconcile(config, deps),
    readVaults(),
    readT3Stale(),
  ])
  return {
    reportedAt: new Date(deps.now()).toISOString(),
    disk: diskReport,
    crashDumps: { wsl, windows },
    memory: memoryReport,
    units: unitReports,
    ...(timerReports === undefined ? {} : { timers: timerReports }),
    memoryReconcile: heartbeat,
    vaults: vaultReports,
    t3Stale: t3Report,
  }
}

export async function collectHostReport(config: HostConfig, deps: HostDeps = defaultHostDeps): Promise<HostReport> {
  return collect(config, deps, () => vaults(config, deps), () => t3Stale(config, deps))
}

// What GET /host serves: a fresh report every time, but the vault check only
// every VAULT_CACHE_MS and the T3 check every T3_CACHE_MS.
export function createHostReporter(config: HostConfig, deps: HostDeps = defaultHostDeps): () => Promise<HostReport> {
  let cached: { at: number; reports: Promise<VaultSyncReport[]> } | null = null
  const readVaults = () => {
    if (cached && deps.now() - cached.at < VAULT_CACHE_MS) return cached.reports
    const entry = { at: deps.now(), reports: vaults(config, deps) }
    cached = entry
    return entry.reports
  }
  let cachedT3: { at: number; report: Promise<T3StaleReport> } | null = null
  const readT3Stale = () => {
    if (cachedT3 && deps.now() - cachedT3.at < T3_CACHE_MS) return cachedT3.report
    const entry = { at: deps.now(), report: t3Stale(config, deps) }
    cachedT3 = entry
    return entry.report
  }
  return () => collect(config, deps, readVaults, readT3Stale)
}
