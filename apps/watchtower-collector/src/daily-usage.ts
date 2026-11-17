// Pieces of an incremental `ccusage --json` (daily) scan: parsing its output, choosing which days
// stay open to re-reading, and splicing a scoped scan onto the closed days kept from an earlier
// one (argus#951).

export interface DailyRow {
  period: string
  [key: string]: unknown
}

export interface DailyUsage {
  rows: DailyRow[]
  totals: Record<string, unknown>
  // Top-level keys beside `daily` and `totals`, carried through untouched.
  rest: Record<string, unknown>
}

const HOUR_MS = 3_600_000
const DAY_MS = 24 * HOUR_MS

// A day labelled `sinceDay` starts no earlier than 14 hours before that UTC midnight (UTC+14 is the
// farthest-ahead zone), so an entry stamped earlier than that falls on an earlier day in every
// timezone and a scoped scan can leave it out. `sinceDay` is the UTC date of 24 hours ago, so that
// instant is under 62 hours back. A file's modification time is at or after its newest entry, so a
// file last written before it holds no such entry either.
const SCOPE_LEAD_HOURS = 14

export interface DailyWindow {
  // The first day a scoped scan re-reads and replaces (`ccusage --since`).
  sinceDay: string
  // Entries stamped before this cannot fall on or after `sinceDay`, and transcripts last written
  // before it hold none.
  scopeFromMs: number
}

export function dailyWindow(now: number): DailyWindow {
  const sinceDay = new Date(now - DAY_MS).toISOString().slice(0, 10)
  return { sinceDay, scopeFromMs: Date.parse(`${sinceDay}T00:00:00Z`) - SCOPE_LEAD_HOURS * HOUR_MS }
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

export function parseDailyUsage(output: string): DailyUsage | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(output)
  } catch {
    return null
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.daily) || !isRecord(parsed.totals)) return null
  const rows: DailyRow[] = []
  for (const candidate of parsed.daily) {
    if (!isRecord(candidate) || typeof candidate.period !== 'string') return null
    rows.push(candidate as DailyRow)
  }
  const { daily: _daily, totals, ...rest } = parsed
  return { rows, totals: totals as Record<string, unknown>, rest }
}

// Closed days come from `baseline`, open days from `scoped` (which was run with --since). The
// totals are summed from the merged rows; if one of them cannot be, the merge is refused and the
// caller falls back to a full scan.
export function mergeDailyUsage(baseline: DailyUsage, scoped: DailyUsage, sinceDay: string): DailyUsage | null {
  const rows = [...baseline.rows.filter((r) => r.period < sinceDay), ...scoped.rows.filter((r) => r.period >= sinceDay)].sort((a, b) =>
    a.period < b.period ? -1 : a.period > b.period ? 1 : 0,
  )
  const totals: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(scoped.totals)) {
    if (typeof value !== 'number') {
      totals[key] = value
      continue
    }
    let sum = 0
    for (const r of rows) {
      const figure = r[key]
      if (typeof figure !== 'number') return null
      sum += figure
    }
    totals[key] = sum
  }
  return { rows, totals, rest: scoped.rest }
}

export const serializeDailyUsage = (usage: DailyUsage): string => JSON.stringify({ ...usage.rest, daily: usage.rows, totals: usage.totals })
