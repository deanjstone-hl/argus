import { execFile } from 'node:child_process'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { createLimiter } from './limit.js'
import { dailyWindow, mergeDailyUsage, parseDailyUsage, serializeDailyUsage, type DailyUsage } from './daily-usage.js'
import { claudeConfigDirs, copyRecentTranscripts, listTranscripts, newestTranscriptMtime, type Transcript } from './transcripts.js'

const execFileAsync = promisify(execFile)
const require = createRequire(import.meta.url)

// ccusage is a real dependency, not an `npx --yes ccusage@<version>` shell-out.
// The version stays pinned for the same reason it always was — an upstream release
// would silently change parsing/state derivation underneath this adapter — but it is
// now pinned in package.json where the lockfile can enforce it.
//
// The adapter polls every 5 minutes, so npx was re-resolving the package ~288 times a
// day on a box that is memory-bound and swapping. Resolving the installed binary once
// and spawning it directly removes that per-poll resolution entirely.
let cachedBin: string | undefined

function resolveCcusageBin(): string {
  if (cachedBin) return cachedBin
  const manifestPath = require.resolve('ccusage/package.json')
  const manifest = require('ccusage/package.json') as { bin?: string | Record<string, string> }
  const entry = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin?.ccusage
  if (!entry) throw new Error('ccusage package.json declares no `ccusage` bin entry')
  cachedBin = path.join(path.dirname(manifestPath), entry)
  return cachedBin
}

// Each run reads every agent's session logs on the host (550 MB on homelab's spinning
// disk, all of it whatever date range is asked for: ccusage --since filters after the
// read, it does not skip files), so two at once (the ai-usage and claude-window
// adapters both ask on a 5-minute interval) double the child's memory for no gain:
// they run one after the other.
const oneAtATime = createLimiter(1)

// The figures only change as fast as a person works, so a scan that read the disk
// recently has nothing new to say. The adapters keep their own 5-minute cadence for
// the remote hosts; the local scan runs at most once per window, per command (argus#872).
//
// The daily report totals every day on record, and its card only goes stale after a
// day, so an hour costs nothing visible (argus#949).
export const CCUSAGE_DAILY_CACHE_TTL_MS = 60 * 60_000

// A window with nothing new is answered from the last output, but only for so long: the
// watch covers Claude Code transcripts, and ccusage reads other agents' logs too. A day
// matches how long the ai-usage card tolerates a stale latest period.
export const CCUSAGE_MAX_UNCHANGED_AGE_MS = 24 * 60 * 60_000

// The daily scan re-reads only the recent transcripts and keeps the closed days from an earlier
// scan (argus#951). That is sound while the earlier scan is current for every closed day, which a
// scan started within the last six hours is: the last closed day ended at least ten hours ago. A
// full scan at least this often also bounds anything the file list cannot see.
export const CCUSAGE_BASELINE_MAX_AGE_MS = 6 * 60 * 60_000
export const CCUSAGE_FULL_SCAN_INTERVAL_MS = 24 * 60 * 60_000

// File times are coarser than the clock the scan start is taken from.
const MTIME_SLACK_MS = 1_000

// Lowest CPU priority and the idle I/O class, so a scan yields the disk to anything
// else that wants it. The idle class takes effect under the bfq scheduler, which
// homelab's disks use.
const PRIORITY_WRAPPER: readonly [string, ...string[]] = ['nice', '-n', '10', 'ionice', '-c', '3']

interface CacheEntry {
  // When the output was last confirmed current: set at a scan and again at each skip.
  at: number
  // When the scan that produced the output started. Carried over by a skip, so "unchanged"
  // always means unchanged since the output was actually read.
  scanStartedAt: number
  output: Promise<string>
}

export interface CcusageRunnerOptions {
  now?: () => number
  // One window for every command, in place of the per-command defaults.
  ttlMs?: number
  env?: NodeJS.ProcessEnv
  // Where the scoped view of the transcripts is built.
  scratchDir?: string
  writeTail?: (source: string, destination: string, cutoffMs: number) => Promise<number>
}

const isPlainDailyCommand = (args: string[]): boolean => args.length === 1 && args[0] === '--json'

// What an incremental daily scan builds on: the daily rows of an earlier scan, the transcripts
// that scan covered and when it was last known to be current.
interface DailyBaseline {
  usage: DailyUsage
  files: Set<string>
  // The start of the last scan, or of the last check that found nothing changed since.
  verifiedAt: number
  fullScanAt: number
}

const transcriptKey = (file: Transcript): string => `${file.sourceIndex}:${file.relativePath}`

// A transcript that vanished takes its days out of a full scan; one that turned up with an old
// date (copied in from another machine) holds days the baseline never saw. Either needs a full scan.
function transcriptsMatchBaseline(baseline: DailyBaseline, listing: Transcript[], scopeFromMs: number): boolean {
  const present = new Set(listing.map(transcriptKey))
  for (const known of baseline.files) if (!present.has(known)) return false
  return listing.every((file) => baseline.files.has(transcriptKey(file)) || file.mtimeMs >= scopeFromMs)
}

export function createCcusageRunner(options: CcusageRunnerOptions = {}): (args?: string[]) => Promise<string> {
  const now = options.now ?? Date.now
  const env = options.env ?? process.env
  const scratchDir = options.scratchDir ?? path.join(os.homedir(), '.argus', 'watchtower-collector', 'scratch')
  const ttlFor = (): number => options.ttlMs ?? CCUSAGE_DAILY_CACHE_TTL_MS
  const entries = new Map<string, CacheEntry>()
  let wrapperMissing = false
  let dailyBaseline: DailyBaseline | undefined

  async function spawnCcusage(args: string[], childEnv: NodeJS.ProcessEnv): Promise<string> {
    // Spawn through process.execPath rather than the bin shim: the collector runs as a
    // systemd --user unit, where the fnm-managed node is not on the inherited PATH.
    const command = [resolveCcusageBin(), ...args]
    const maxBuffer = 10 * 1024 * 1024
    if (!wrapperMissing) {
      try {
        const { stdout } = await execFileAsync(PRIORITY_WRAPPER[0], [...PRIORITY_WRAPPER.slice(1), process.execPath, ...command], { maxBuffer, env: childEnv })
        return stdout
      } catch (error) {
        // A box without nice or ionice still reports usage, just at normal priority.
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        wrapperMissing = true
        console.warn('[collector] nice/ionice not found, running ccusage at normal priority')
      }
    }
    const { stdout } = await execFileAsync(process.execPath, command, { maxBuffer, env: childEnv })
    return stdout
  }

  // Runs ccusage on a copy of the entries stamped at or after `cutoffMs`, falling back to the full
  // read when the copy cannot be built: slower, but still correct.
  async function scanRecent(args: string[], cutoffMs: number): Promise<{ output: string; scoped: boolean }> {
    let scoped: Awaited<ReturnType<typeof copyRecentTranscripts>>
    try {
      scoped = await copyRecentTranscripts(claudeConfigDirs(env), cutoffMs, { scratchDir, writeTail: options.writeTail, now })
    } catch (error) {
      console.warn(`[collector] could not scope the ccusage ${args[0] ?? ''} scan to recent entries, reading all transcripts: ${error instanceof Error ? error.message : String(error)}`)
      return { output: await spawnCcusage(args, env), scoped: false }
    }
    try {
      return { output: await spawnCcusage(args, { ...env, CLAUDE_CONFIG_DIR: scoped.configDirs.join(',') }), scoped: true }
    } finally {
      await scoped.cleanup()
    }
  }

  async function fullDailyScan(args: string[], startedAt: number, listing: Transcript[] | null): Promise<string> {
    const output = await spawnCcusage(args, env)
    const usage = parseDailyUsage(output)
    dailyBaseline = usage && listing ? { usage, files: new Set(listing.map(transcriptKey)), verifiedAt: startedAt, fullScanAt: startedAt } : undefined
    return output
  }

  // Closed days come from the earlier scan; only the transcripts that can hold an open day are
  // read again. Anything unexpected falls back to the full read.
  async function dailyScan(args: string[]): Promise<string> {
    const startedAt = now()
    let listing: Transcript[] | null = null
    try {
      listing = await listTranscripts(claudeConfigDirs(env))
    } catch (error) {
      console.warn(`[collector] could not list the transcripts, reading all of them: ${error instanceof Error ? error.message : String(error)}`)
    }
    const baseline = dailyBaseline
    const { sinceDay, scopeFromMs } = dailyWindow(startedAt)
    const usable =
      baseline !== undefined &&
      listing !== null &&
      startedAt - baseline.verifiedAt <= CCUSAGE_BASELINE_MAX_AGE_MS &&
      startedAt - baseline.fullScanAt < CCUSAGE_FULL_SCAN_INTERVAL_MS &&
      transcriptsMatchBaseline(baseline, listing, scopeFromMs)
    if (!usable || !baseline || !listing) return fullDailyScan(args, startedAt, listing)

    const { output: scopedOutput } = await scanRecent([...args, '--since', sinceDay], scopeFromMs)
    const scopedUsage = parseDailyUsage(scopedOutput)
    const merged = scopedUsage && mergeDailyUsage(baseline.usage, scopedUsage, sinceDay)
    if (!merged) {
      console.warn('[collector] could not merge the scoped ccusage daily scan, reading all transcripts')
      return fullDailyScan(args, startedAt, listing)
    }
    dailyBaseline = { usage: merged, files: new Set(listing.map(transcriptKey)), verifiedAt: startedAt, fullScanAt: baseline.fullScanAt }
    return serializeDailyUsage(merged)
  }

  async function scan(args: string[]): Promise<string> {
    if (isPlainDailyCommand(args)) return dailyScan(args)
    return spawnCcusage(args, env)
  }

  // True when the last output still stands: no Claude Code transcript was written since that
  // scan started. Any doubt, including a directory that cannot be read, is a reason to scan.
  async function lastOutputStands(cached: CacheEntry): Promise<boolean> {
    if (now() - cached.scanStartedAt >= CCUSAGE_MAX_UNCHANGED_AGE_MS) return false
    try {
      const newest = await newestTranscriptMtime(claudeConfigDirs(env))
      if (newest !== null && newest >= cached.scanStartedAt - MTIME_SLACK_MS) return false
      return true
    } catch (error) {
      console.warn(`[collector] could not check the transcripts for changes, scanning: ${error instanceof Error ? error.message : String(error)}`)
      return false
    }
  }

  return function run(args = ['--json']) {
    const key = args.join('\u0000')
    const cached = entries.get(key)
    if (cached && now() - cached.at < ttlFor()) return cached.output

    const entry: CacheEntry = { at: now(), scanStartedAt: now(), output: Promise.resolve('') }
    entry.output = oneAtATime(async () => {
      if (cached && (await lastOutputStands(cached))) {
        entry.scanStartedAt = cached.scanStartedAt
        // Nothing changed since that scan, so the daily rows it left are still current.
        if (dailyBaseline && isPlainDailyCommand(args)) dailyBaseline.verifiedAt = now()
        return cached.output
      }
      entry.scanStartedAt = now()
      return scan(args)
    })
    entries.set(key, entry)
    // A failed scan is not remembered: the next poll tries again.
    entry.output.catch(() => {
      if (entries.get(key) === entry) entries.delete(key)
    })
    return entry.output
  }
}

export const runLocalCcusage = createCcusageRunner()
