import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

interface ExecCall {
  file: string
  args: string[]
  env: NodeJS.ProcessEnv | undefined
  // Files under each CLAUDE_CONFIG_DIR entry at the moment of the spawn, relative to that entry.
  configDirFiles: string[][]
  // Their size in bytes, all entries together.
  configDirBytes: number
}

const state = vi.hoisted(() => ({
  inFlight: 0,
  peak: 0,
  calls: [] as ExecCall[],
  failFiles: new Set<string>(),
  failNext: 0,
  stdout: undefined as ((ccusageArgs: string[]) => string) | undefined,
}))

function bytesUnder(directory: string, fs: typeof import('node:fs')): number {
  try {
    return fs
      .readdirSync(directory, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .reduce((sum, entry) => sum + fs.statSync(`${entry.parentPath}/${entry.name}`).size, 0)
  } catch {
    return 0
  }
}

function filesUnder(directory: string, fs: typeof import('node:fs')): string[] {
  try {
    return fs
      .readdirSync(directory, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => `${entry.parentPath.slice(directory.length + 1)}/${entry.name}`)
      .sort()
  } catch {
    // A directory the test made unreadable, or one that is already gone: nothing to list.
    return []
  }
}

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  const fs = await import('node:fs')
  return {
    ...actual,
    execFile: (
      file: string,
      args: string[],
      options: { env?: NodeJS.ProcessEnv },
      callback: (error: Error | null, result?: { stdout: string; stderr: string }) => void,
    ) => {
      const configDirs = (options.env?.CLAUDE_CONFIG_DIR ?? '').split(',').filter((entry) => entry !== '')
      state.calls.push({
        file,
        args,
        env: options.env,
        configDirFiles: configDirs.map((dir) => filesUnder(dir, fs)),
        configDirBytes: configDirs.reduce((sum, dir) => sum + bytesUnder(dir, fs), 0),
      })
      state.inFlight += 1
      state.peak = Math.max(state.peak, state.inFlight)
      setTimeout(() => {
        state.inFlight -= 1
        if (state.failFiles.has(file)) {
          callback(Object.assign(new Error(`spawn ${file} ENOENT`), { code: 'ENOENT' }))
        } else if (state.failNext > 0) {
          state.failNext -= 1
          callback(new Error('ccusage exited 1'))
        } else {
          const ccusageArgs = args.includes(process.execPath) ? args.slice(args.indexOf(process.execPath) + 2) : args.slice(1)
          callback(null, { stdout: state.stdout ? state.stdout(ccusageArgs) : ccusageArgs.join(' '), stderr: '' })
        }
      }, 5)
    },
  }
})

const { dailyWindow } = await import('./daily-usage.js')
const { createCcusageRunner, CCUSAGE_DAILY_CACHE_TTL_MS, CCUSAGE_MAX_UNCHANGED_AGE_MS } = await import('./ccusage.js')

const HOUR_MS = 60 * 60_000
const DAILY = ['--json']
const MONTHLY = ['monthly', '--json']

let sandbox: string
let configDir: string
let scratchDir: string
let clock: number

beforeEach(() => {
  state.inFlight = 0
  state.peak = 0
  state.calls.length = 0
  state.failFiles.clear()
  state.failNext = 0
  state.stdout = undefined
  sandbox = mkdtempSync(path.join(os.tmpdir(), 'ccusage-runner-test-'))
  configDir = path.join(sandbox, 'cfg')
  scratchDir = path.join(sandbox, 'scratch')
  mkdirSync(path.join(configDir, 'projects'), { recursive: true })
  // Fixed, and late in the UTC day, so the tests that advance the virtual clock by hours
  // cross midnight on every run rather than only when CI happens to run in that window.
  clock = Date.parse('2026-06-15T22:11:00Z')
})

afterEach(() => {
  rmSync(sandbox, { recursive: true, force: true })
})

// Writes a transcript last modified at `modifiedAt` (a virtual-clock time).
function transcript(relativePath: string, modifiedAt: number): string {
  const file = path.join(configDir, 'projects', relativePath)
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, '{}\n')
  utimesSync(file, modifiedAt / 1000, modifiedAt / 1000)
  return file
}

function runner(overrides: Partial<NonNullable<Parameters<typeof createCcusageRunner>[0]>> = {}) {
  return createCcusageRunner({
    now: () => clock,
    env: { CLAUDE_CONFIG_DIR: configDir },
    scratchDir,
    ...overrides,
  })
}

describe('createCcusageRunner: one scan at a time', () => {
  it('runs one ccusage at a time, however many adapters ask together', async () => {
    // ai-usage and claude-window both read ccusage; each run parses every
    // session log on the host, so two at once doubles the child's memory.
    const run = runner()
    const outputs = await Promise.all([run(DAILY), run(MONTHLY), run()])
    expect(outputs).toEqual(['--json', 'monthly --json', '--json'])
    expect(state.peak).toBe(1)
  })

  it('shares one scan between callers that ask while it is running', async () => {
    const run = runner()
    await Promise.all([run(DAILY), run(DAILY), run()])
    expect(state.calls).toHaveLength(1)
  })
})

describe('createCcusageRunner: cache window', () => {
  it('serves the daily scan from the cache for an hour', async () => {
    transcript('p/a.jsonl', clock)
    const run = runner()
    const first = await run(DAILY)
    clock += CCUSAGE_DAILY_CACHE_TTL_MS - 1
    transcript('p/a.jsonl', clock)
    expect(await run(DAILY)).toBe(first)
    expect(state.calls).toHaveLength(1)
  })

  it('gives every command the daily window, since nothing else has a card that watches it', async () => {
    transcript('p/a.jsonl', clock)
    const run = runner()
    const first = await run(MONTHLY)
    clock += CCUSAGE_DAILY_CACHE_TTL_MS - 1
    transcript('p/a.jsonl', clock)
    expect(await run(MONTHLY)).toBe(first)
    expect(state.calls).toHaveLength(1)
  })

  it('no longer special-cases a blocks command: the daily window, and a plain read of everything', async () => {
    const blocks = ['blocks', '--active', '--json']
    transcript('p/a.jsonl', clock - HOUR_MS)
    const run = runner()
    const first = await run(blocks)
    clock += CCUSAGE_DAILY_CACHE_TTL_MS - 1
    expect(await run(blocks)).toBe(first)
    expect(state.calls).toHaveLength(1)
    expect(state.calls[0]?.env?.CLAUDE_CONFIG_DIR).toBe(configDir)
    transcript('p/a.jsonl', clock + 1_000)
    clock += 1
    await run(blocks)
    expect(state.calls).toHaveLength(2)
    expect(state.calls[1]?.env?.CLAUDE_CONFIG_DIR).toBe(configDir)
  })

  it('keeps the daily window at an hour', () => {
    expect(CCUSAGE_DAILY_CACHE_TTL_MS).toBe(60 * 60_000)
  })

  it('scans the daily report again once its window has passed and a transcript changed', async () => {
    transcript('p/a.jsonl', clock)
    const run = runner()
    await run(DAILY)
    clock += CCUSAGE_DAILY_CACHE_TTL_MS
    transcript('p/a.jsonl', clock)
    await run(DAILY)
    expect(state.calls).toHaveLength(2)
  })

  it('keeps a separate entry per command, so the two adapters never read each other figures', async () => {
    const run = runner({ ttlMs: 60_000 })
    const daily = await run(DAILY)
    const monthly = await run(MONTHLY)
    expect(state.calls).toHaveLength(2)
    expect(daily).toBe('--json')
    expect(monthly).toBe('monthly --json')
    expect(await run(DAILY)).toBe(daily)
    expect(state.calls).toHaveLength(2)
  })

  it('does not cache a failed scan', async () => {
    const run = runner()
    state.failNext = 1
    await expect(run(DAILY)).rejects.toThrow('ccusage exited 1')
    await expect(run(DAILY)).resolves.toBe('--json')
    expect(state.calls).toHaveLength(2)
  })
})

describe('createCcusageRunner: skip a scan when no transcript changed', () => {
  it('serves the last daily output without a spawn when nothing changed since that scan started', async () => {
    transcript('p/a.jsonl', clock - 5 * HOUR_MS)
    const run = runner()
    const first = await run(DAILY)
    clock += CCUSAGE_DAILY_CACHE_TTL_MS
    expect(await run(DAILY)).toBe(first)
    expect(state.calls).toHaveLength(1)
  })

  it('does not walk the transcripts again until the extended window ends', async () => {
    transcript('p/a.jsonl', clock - 5 * HOUR_MS)
    const run = runner()
    await run(DAILY)
    clock += CCUSAGE_DAILY_CACHE_TTL_MS
    await run(DAILY)
    // A change arriving after the skip is not looked for inside the new window ...
    transcript('p/a.jsonl', clock + 1)
    clock += CCUSAGE_DAILY_CACHE_TTL_MS - 1
    await run(DAILY)
    expect(state.calls).toHaveLength(1)
    // ... and is found when it ends.
    clock += 1
    await run(DAILY)
    expect(state.calls).toHaveLength(2)
  })

  it('scans when a transcript changed after the last scan started', async () => {
    transcript('p/a.jsonl', clock - 5 * HOUR_MS)
    const run = runner()
    await run(DAILY)
    clock += CCUSAGE_DAILY_CACHE_TTL_MS
    transcript('p/new-session.jsonl', clock - 10 * 60_000)
    await run(DAILY)
    expect(state.calls).toHaveLength(2)
  })

  it('scans when a transcript was written during the last scan', async () => {
    const run = runner()
    transcript('p/a.jsonl', clock - 5 * HOUR_MS)
    const pending = run(DAILY)
    // The scan started at `clock`; this write lands after it.
    transcript('p/a.jsonl', clock + 2_000)
    await pending
    clock += CCUSAGE_DAILY_CACHE_TTL_MS
    await run(DAILY)
    expect(state.calls).toHaveLength(2)
  })

  it('treats a host with no transcripts at all as unchanged', async () => {
    const run = runner()
    await run(DAILY)
    clock += CCUSAGE_DAILY_CACHE_TTL_MS
    await run(DAILY)
    expect(state.calls).toHaveLength(1)
  })

  it('scans anyway once the last real scan is a day old, in case an agent it does not watch changed', async () => {
    transcript('p/a.jsonl', clock - 50 * HOUR_MS)
    const run = runner()
    await run(DAILY)
    for (let elapsed = 0; elapsed + CCUSAGE_DAILY_CACHE_TTL_MS < CCUSAGE_MAX_UNCHANGED_AGE_MS; elapsed += CCUSAGE_DAILY_CACHE_TTL_MS) {
      clock += CCUSAGE_DAILY_CACHE_TTL_MS
      await run(DAILY)
    }
    expect(state.calls).toHaveLength(1)
    clock += CCUSAGE_MAX_UNCHANGED_AGE_MS
    await run(DAILY)
    expect(state.calls).toHaveLength(2)
  })

  it('scans when the transcripts cannot be read, rather than trusting a partial list', async () => {
    transcript('locked/a.jsonl', clock - 5 * HOUR_MS)
    const run = runner()
    await run(DAILY)
    const locked = path.join(configDir, 'projects', 'locked')
    chmodSync(locked, 0o000)
    try {
      clock += CCUSAGE_DAILY_CACHE_TTL_MS
      await run(DAILY)
      expect(state.calls).toHaveLength(2)
    } finally {
      chmodSync(locked, 0o700)
    }
  })

})

describe('createCcusageRunner: incremental daily scan', () => {
  const CLOSED = ['2020-01-01', '2020-01-02']
  const dailyReport = (days: Array<[string, number]>) =>
    JSON.stringify({
      daily: days.map(([period, totalTokens]) => ({ period, totalTokens, totalCost: totalTokens / 100 })),
      totals: { totalTokens: days.reduce((sum, [, tokens]) => sum + tokens, 0), totalCost: days.reduce((sum, [, tokens]) => sum + tokens / 100, 0) },
    })
  const today = (): string => new Date(clock).toISOString().slice(0, 10)
  let fullDays: Array<[string, number]>
  let scopedDays: Array<[string, number]>

  beforeEach(() => {
    fullDays = [[CLOSED[0] ?? '', 100], [CLOSED[1] ?? '', 200], [today(), 300]]
    scopedDays = [[today(), 350]]
    state.stdout = (ccusageArgs) => dailyReport(ccusageArgs.includes('--since') ? scopedDays : fullDays)
  })

  const spawned = () => state.calls.map((call) => (call.env?.CLAUDE_CONFIG_DIR === configDir ? 'full' : 'scoped'))
  const tokensByDay = (output: string) => Object.fromEntries((JSON.parse(output) as { daily: Array<{ period: string; totalTokens: number }> }).daily.map((d) => [d.period, d.totalTokens]))

  it('does not scope the first daily scan, which totals every day', async () => {
    transcript('p/old.jsonl', clock - 300 * HOUR_MS)
    await runner()(DAILY)
    expect(state.calls[0]?.env?.CLAUDE_CONFIG_DIR).toBe(configDir)
  })

  it('reads everything the first time', async () => {
    transcript('p/old.jsonl', clock - 300 * HOUR_MS)
    const output = await runner()(DAILY)
    expect(spawned()).toEqual(['full'])
    expect(state.calls[0]?.env?.CLAUDE_CONFIG_DIR).toBe(configDir)
    expect(tokensByDay(output)).toEqual({ [CLOSED[0] ?? '']: 100, [CLOSED[1] ?? '']: 200, [today()]: 300 })
  })

  it('then reads only the recent transcripts, from the first open day, and keeps the closed days', async () => {
    transcript('p/old.jsonl', clock - 300 * HOUR_MS)
    transcript('p/inside-window.jsonl', clock - 30 * HOUR_MS)
    transcript('p/outside-window.jsonl', clock - 80 * HOUR_MS)
    const run = runner()
    await run(DAILY)
    transcript('p/live.jsonl', clock + 1_000)
    clock += CCUSAGE_DAILY_CACHE_TTL_MS
    const output = await run(DAILY)

    expect(spawned()).toEqual(['full', 'scoped'])
    const scoped = state.calls[1]
    expect(scoped?.args.slice(-3)).toEqual(['--json', '--since', dailyWindow(clock).sinceDay])
    expect(scoped?.configDirFiles).toEqual([['projects/p/inside-window.jsonl', 'projects/p/live.jsonl']])
    expect(tokensByDay(output)).toEqual({ [CLOSED[0] ?? '']: 100, [CLOSED[1] ?? '']: 200, [today()]: 350 })
    expect((JSON.parse(output) as { totals: { totalTokens: number } }).totals.totalTokens).toBe(650)
    expect(readdirSync(scratchDir)).toEqual([])
  })

  it('builds the next scan on the merged result, not on the first full scan', async () => {
    transcript('p/a.jsonl', clock - HOUR_MS)
    const run = runner()
    await run(DAILY)
    transcript('p/a.jsonl', clock + 1_000)
    clock += CCUSAGE_DAILY_CACHE_TTL_MS
    await run(DAILY)
    const scannedDay = today()
    scopedDays = [[scannedDay, 400]]
    transcript('p/a.jsonl', clock + 1_000)
    clock += CCUSAGE_DAILY_CACHE_TTL_MS
    const output = await run(DAILY)
    expect(spawned()).toEqual(['full', 'scoped', 'scoped'])
    expect(tokensByDay(output)[scannedDay]).toBe(400)
  })

  it('does not scope a daily command with other arguments', async () => {
    transcript('p/a.jsonl', clock - HOUR_MS)
    const run = runner()
    await run(['--json', '--since', '20200101'])
    transcript('p/a.jsonl', clock + 1_000)
    clock += CCUSAGE_DAILY_CACHE_TTL_MS
    await run(['--json', '--since', '20200101'])
    expect(spawned()).toEqual(['full', 'full'])
  })

  it('scans everything again when the last scan is more than six hours old', async () => {
    transcript('p/a.jsonl', clock - HOUR_MS)
    const run = runner()
    await run(DAILY)
    transcript('p/a.jsonl', clock + 1_000)
    clock += 7 * HOUR_MS
    await run(DAILY)
    expect(spawned()).toEqual(['full', 'full'])
  })

  it('counts a skipped scan as a check, so a long idle night does not force a full scan', async () => {
    transcript('p/a.jsonl', clock - HOUR_MS)
    const run = runner()
    await run(DAILY)
    clock += 5 * HOUR_MS
    await run(DAILY)
    expect(spawned()).toEqual(['full'])
    clock += 5 * HOUR_MS
    transcript('p/a.jsonl', clock)
    await run(DAILY)
    expect(spawned()).toEqual(['full', 'scoped'])
  })

  it('scans everything again once the last full scan is a day old', async () => {
    transcript('p/a.jsonl', clock - HOUR_MS)
    const run = runner()
    await run(DAILY)
    for (let hours = 5; hours <= 20; hours += 5) {
      clock += 5 * HOUR_MS
      transcript('p/a.jsonl', clock)
      await run(DAILY)
    }
    expect(spawned()).toEqual(['full', 'scoped', 'scoped', 'scoped', 'scoped'])
    clock += 5 * HOUR_MS
    transcript('p/a.jsonl', clock)
    await run(DAILY)
    expect(spawned().at(-1)).toBe('full')
  })

  it('scans everything again when a transcript disappeared, since its days leave a full scan', async () => {
    transcript('p/old.jsonl', clock - 300 * HOUR_MS)
    const live = transcript('p/live.jsonl', clock - HOUR_MS)
    const run = runner()
    await run(DAILY)
    rmSync(path.join(configDir, 'projects', 'p', 'old.jsonl'))
    transcript('p/live.jsonl', clock + 1_000)
    clock += CCUSAGE_DAILY_CACHE_TTL_MS
    await run(DAILY)
    expect(existsSync(live)).toBe(true)
    expect(spawned()).toEqual(['full', 'full'])
  })

  it('scans everything again when a transcript turns up that is older than the scoped window', async () => {
    transcript('p/live.jsonl', clock - HOUR_MS)
    const run = runner()
    await run(DAILY)
    transcript('synced/from-elsewhere.jsonl', clock - 400 * HOUR_MS)
    transcript('p/live.jsonl', clock + 1_000)
    clock += CCUSAGE_DAILY_CACHE_TTL_MS
    await run(DAILY)
    expect(spawned()).toEqual(['full', 'full'])
  })

  it('stays incremental when a new transcript is inside the scoped window', async () => {
    transcript('p/live.jsonl', clock - HOUR_MS)
    const run = runner()
    await run(DAILY)
    transcript('p/new-session.jsonl', clock + 1_000)
    clock += CCUSAGE_DAILY_CACHE_TTL_MS
    await run(DAILY)
    expect(spawned()).toEqual(['full', 'scoped'])
  })

  it('scans everything when the scoped output cannot be merged', async () => {
    transcript('p/a.jsonl', clock - HOUR_MS)
    const run = runner()
    await run(DAILY)
    state.stdout = (ccusageArgs) => (ccusageArgs.includes('--since') ? 'not json' : dailyReport(fullDays))
    transcript('p/a.jsonl', clock + 1_000)
    clock += CCUSAGE_DAILY_CACHE_TTL_MS
    const output = await run(DAILY)
    expect(spawned()).toEqual(['full', 'scoped', 'full'])
    expect(tokensByDay(output)[today()]).toBe(300)
  })

  it('reads every transcript, from the first open day, when the transcripts cannot be copied', async () => {
    transcript('p/a.jsonl', clock - HOUR_MS)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      const run = runner({
        writeTail: async () => {
          throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' })
        },
      })
      await run(DAILY)
      transcript('p/a.jsonl', clock + 1_000)
      clock += CCUSAGE_DAILY_CACHE_TTL_MS
      const output = await run(DAILY)
      expect(spawned()).toEqual(['full', 'full'])
      expect(state.calls[1]?.args.slice(-2)).toEqual(['--since', dailyWindow(clock).sinceDay])
      expect(tokensByDay(output)).toEqual({ [CLOSED[0] ?? '']: 100, [CLOSED[1] ?? '']: 200, [today()]: 350 })
    } finally {
      warn.mockRestore()
    }
  })

  it('keeps the earlier baseline when a scoped scan fails', async () => {
    transcript('p/a.jsonl', clock - HOUR_MS)
    const run = runner()
    await run(DAILY)
    transcript('p/a.jsonl', clock + 1_000)
    clock += CCUSAGE_DAILY_CACHE_TTL_MS
    state.failNext = 1
    await expect(run(DAILY)).rejects.toThrow('ccusage exited 1')
    const output = await run(DAILY)
    expect(spawned()).toEqual(['full', 'scoped', 'scoped'])
    expect(tokensByDay(output)).toEqual({ [CLOSED[0] ?? '']: 100, [CLOSED[1] ?? '']: 200, [today()]: 350 })
  })
})

describe('createCcusageRunner: priority', () => {
  it('runs the scan at idle disk priority and low CPU priority', async () => {
    await runner()(DAILY)
    const call = state.calls[0]
    if (!call) throw new Error('no ccusage spawn recorded')
    expect(call.file).toBe('nice')
    expect(call.args.slice(0, 5)).toEqual(['-n', '10', 'ionice', '-c', '3'])
    expect(call.args[5]).toBe(process.execPath)
    expect(call.args.slice(-1)).toEqual(['--json'])
  })

  it('falls back to running ccusage directly when nice or ionice is missing', async () => {
    state.failFiles.add('nice')
    const run = runner()
    await expect(run(DAILY)).resolves.toBe('--json')
    expect(state.calls.map((call) => call.file)).toEqual(['nice', process.execPath])
    await run(MONTHLY)
    expect(state.calls.map((call) => call.file)).toEqual(['nice', process.execPath, process.execPath])
  })
})
