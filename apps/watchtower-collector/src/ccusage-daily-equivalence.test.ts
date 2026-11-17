import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createCcusageRunner } from './ccusage.js'

// No mocks: the real ccusage reads real files, and an incremental runner is compared with a fresh
// full scan of the same transcripts after every step (argus#951).

const HOUR_MS = 60 * 60_000
const DAY_MS = 24 * HOUR_MS
// Five hours between scans: past the cache window, inside the six hours a baseline stays usable.
const STEP_MS = 5 * HOUR_MS

interface Entry {
  ts: number
  messageId: string
  requestId: string
  tokens: number
}

interface DailyJson {
  daily: Array<{ period: string; totalTokens: number; totalCost: number }>
  totals: { totalTokens: number; totalCost: number }
}

let sandbox: string
let configDir: string
let scratchDir: string
let homeDir: string
let clock: number
let sequence: number

beforeEach(() => {
  sandbox = mkdtempSync(path.join(os.tmpdir(), 'ccusage-equivalence-'))
  configDir = path.join(sandbox, 'cfg')
  scratchDir = path.join(sandbox, 'scratch')
  homeDir = path.join(sandbox, 'home')
  mkdirSync(homeDir)
  mkdirSync(path.join(configDir, 'projects', 'p'), { recursive: true })
  sequence = 0
  clock = Date.now() - 12 * DAY_MS
})

afterEach(() => {
  rmSync(sandbox, { recursive: true, force: true })
})

const newEntry = (ts: number): Entry => {
  sequence += 1
  return { ts, messageId: `msg_${sequence}`, requestId: `req_${sequence}`, tokens: 10 + (sequence % 7) * 13 }
}

const line = (entry: Entry): string =>
  JSON.stringify({
    timestamp: new Date(entry.ts).toISOString(),
    type: 'assistant',
    requestId: entry.requestId,
    costUSD: entry.tokens / 1000,
    sessionId: '00000000-0000-4000-8000-000000000007',
    cwd: '/work',
    version: '2.0.0',
    message: {
      id: entry.messageId,
      model: 'claude-sonnet-5-5',
      role: 'assistant',
      type: 'message',
      usage: { input_tokens: 0, output_tokens: entry.tokens, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    },
  })

// Rewrites the whole file (the content a stream of appends would leave) and stamps its mtime as
// the time of its newest entry.
function writeTranscript(name: string, entries: Entry[]): void {
  const file = path.join(configDir, 'projects', 'p', name)
  writeFileSync(file, `${entries.map(line).join('\n')}\n`)
  const modifiedAt = Math.max(...entries.map((entry) => entry.ts)) / 1000
  utimesSync(file, modifiedAt, modifiedAt)
}

// Twelve days of history in one file a day, entries either side of every UTC midnight so that each
// timezone puts some of them on a different day.
function seedHistory(): Map<number, Entry[]> {
  const history = new Map<number, Entry[]>()
  const startOfToday = Math.floor(clock / DAY_MS) * DAY_MS
  for (let daysAgo = 12; daysAgo >= 1; daysAgo -= 1) {
    const midnight = startOfToday - daysAgo * DAY_MS
    const entries = [newEntry(midnight + 30 * 60_000), newEntry(midnight + 12 * HOUR_MS), newEntry(midnight + 23.5 * HOUR_MS)]
    history.set(daysAgo, entries)
    writeTranscript(`day-${daysAgo}.jsonl`, entries)
  }
  return history
}

function dailyByPeriod(output: string): Record<string, number> {
  return Object.fromEntries((JSON.parse(output) as DailyJson).daily.map((day) => [day.period, day.totalTokens]))
}

function expectSameUsage(incremental: string, full: string): void {
  expect(Object.keys(dailyByPeriod(full)).length).toBeGreaterThanOrEqual(12)
  expect(dailyByPeriod(incremental)).toEqual(dailyByPeriod(full))
  const a = (JSON.parse(incremental) as DailyJson).totals
  const b = (JSON.parse(full) as DailyJson).totals
  expect(a.totalTokens).toBe(b.totalTokens)
  expect(a.totalCost).toBeCloseTo(b.totalCost, 9)
  for (const day of (JSON.parse(incremental) as DailyJson).daily) {
    const match = (JSON.parse(full) as DailyJson).daily.find((candidate) => candidate.period === day.period)
    expect(day.totalCost).toBeCloseTo(match?.totalCost ?? Number.NaN, 9)
  }
}

// ccusage reads every agent's logs under the home directory and, on each run, fetches its price list
// from GitHub. Both made a run cost seconds that depended on the host (its disk, its network, what
// else it was running), and on a loaded runner twenty runs a zone outlasted the test's timeout
// (argus#1195). The runner gets an empty home, so only the fixture is read, and a proxy that
// refuses connections, so the price list is never fetched; the fixture's own costUSD is the cost.
const DEAD_PROXY = 'http://127.0.0.1:9'

const isolatedEnv = (timezone: string): NodeJS.ProcessEnv => ({
  PATH: process.env.PATH,
  HOME: homeDir,
  XDG_CONFIG_HOME: path.join(homeDir, '.config'),
  CLAUDE_CONFIG_DIR: configDir,
  TZ: timezone,
  HTTP_PROXY: DEAD_PROXY,
  HTTPS_PROXY: DEAD_PROXY,
  ALL_PROXY: DEAD_PROXY,
})

const runnerFor = (timezone: string) => createCcusageRunner({ now: () => clock, env: isolatedEnv(timezone), scratchDir })

// Sydney is the owner's zone; Kiritimati (UTC+14) and Pago Pago (UTC-11) are the extremes.
describe.each(['Australia/Sydney', 'Pacific/Kiritimati', 'Pacific/Pago_Pago'])('incremental daily scan against a full scan in %s', (timezone) => {
  it('gives the same days and totals after every step, through resumed sessions, midnights and a day-old baseline', async () => {
    seedHistory()
    const incremental = runnerFor(timezone)
    expectSameUsage(await incremental(['--json']), await runnerFor(timezone)(['--json']))

    let live: Entry[] = [newEntry(clock)]
    let liveName = 'live-0.jsonl'
    for (let step = 1; step <= 9; step += 1) {
      clock += STEP_MS
      live = [...live, newEntry(clock - 40 * 60_000), newEntry(clock - 5 * 60_000)]
      if (step % 2 === 0) {
        // A resumed session starts a new file that replays the end of the old one, old dates and all.
        const replayed = live.slice(-3)
        liveName = `live-${step}.jsonl`
        live = [...replayed, newEntry(clock - 2 * 60_000)]
      }
      writeTranscript(liveName, live)
      expectSameUsage(await incremental(['--json']), await runnerFor(timezone)(['--json']))
    }
  }, 60_000)
})

describe('incremental daily scan: what it leaves alone', () => {
  it('serves a closed day from the earlier scan instead of reading its transcript again', async () => {
    const history = seedHistory()
    const run = runnerFor('UTC')
    const first = dailyByPeriod(await run(['--json']))
    const closedDay = new Date(Math.floor(clock / DAY_MS) * DAY_MS - 10 * DAY_MS + 12 * HOUR_MS).toISOString().slice(0, 10)

    // Rewrite a closed day's transcript with other figures; its mtime (the newest entry) is unchanged.
    writeTranscript('day-10.jsonl', (history.get(10) ?? []).map((entry) => ({ ...entry, tokens: entry.tokens + 1_000 })))
    clock += STEP_MS
    writeTranscript('live.jsonl', [newEntry(clock - 60_000)])

    const incremental = dailyByPeriod(await run(['--json']))
    const full = dailyByPeriod(await runnerFor('UTC')(['--json']))
    expect(incremental[closedDay]).toBe(first[closedDay])
    expect(full[closedDay]).toBe((first[closedDay] ?? 0) + 3_000)
  }, 60_000)
})
