import { describe, expect, it } from 'vitest'
import { dailyWindow, mergeDailyUsage, parseDailyUsage } from './daily-usage.js'

const row = (period: string, totalTokens: number, totalCost: number) => ({ period, inputTokens: totalTokens, totalTokens, totalCost })
const report = (rows: Array<ReturnType<typeof row>>, extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    daily: rows,
    totals: {
      inputTokens: rows.reduce((sum, r) => sum + r.inputTokens, 0),
      totalTokens: rows.reduce((sum, r) => sum + r.totalTokens, 0),
      totalCost: rows.reduce((sum, r) => sum + r.totalCost, 0),
    },
    ...extra,
  })

describe('parseDailyUsage', () => {
  it('reads the rows and the top-level keys beside them', () => {
    const parsed = parseDailyUsage(report([row('2026-10-01', 10, 1)], { schemaVersion: 2 }))
    expect(parsed?.rows).toEqual([row('2026-10-01', 10, 1)])
    expect(parsed?.rest).toEqual({ schemaVersion: 2 })
  })

  it.each([
    ['not JSON', 'nope'],
    ['no daily array', JSON.stringify({ totals: {} })],
    ['no totals', JSON.stringify({ daily: [] })],
    ['a row without a period', JSON.stringify({ daily: [{ totalTokens: 1 }], totals: {} })],
  ])('returns null for %s', (_name, output) => {
    expect(parseDailyUsage(output)).toBeNull()
  })
})

describe('dailyWindow', () => {
  it('starts the open days at yesterday (UTC) and reads entries from 14 hours before that midnight', () => {
    const now = Date.parse('2026-10-30T05:00:00Z')
    expect(dailyWindow(now)).toEqual({ sinceDay: '2026-10-29', scopeFromMs: Date.parse('2026-10-28T10:00:00Z') })
  })

  it('reaches back exactly as far as the earliest instant a day labelled sinceDay can start (UTC+14)', () => {
    for (const hour of [0, 5, 11, 23]) {
      const now = Date.parse(`2026-10-30T${String(hour).padStart(2, '0')}:30:00Z`)
      const { sinceDay, scopeFromMs } = dailyWindow(now)
      expect(scopeFromMs).toBe(Date.parse(`${sinceDay}T00:00:00Z`) - 14 * 3_600_000)
    }
  })

  it('never reaches back more than 62 hours', () => {
    for (const hour of [0, 5, 11, 23]) {
      const now = Date.parse(`2026-10-30T${String(hour).padStart(2, '0')}:59:59Z`)
      expect(now - dailyWindow(now).scopeFromMs).toBeLessThanOrEqual(62 * 3_600_000)
    }
  })
})

describe('mergeDailyUsage', () => {
  const baseline = parseDailyUsage(report([row('2026-10-01', 100, 1), row('2026-10-02', 200, 2), row('2026-10-03', 300, 3)]))!

  it('keeps the closed days, replaces the open ones and re-sums the totals', () => {
    const scoped = parseDailyUsage(report([row('2026-10-03', 350, 3.5), row('2026-10-04', 40, 0.4)]))!
    const merged = mergeDailyUsage(baseline, scoped, '2026-10-03')
    expect(merged?.rows.map((r) => [r.period, r.totalTokens])).toEqual([
      ['2026-10-01', 100],
      ['2026-10-02', 200],
      ['2026-10-03', 350],
      ['2026-10-04', 40],
    ])
    expect(merged?.totals).toMatchObject({ inputTokens: 690, totalTokens: 690 })
    expect(merged?.totals.totalCost).toBeCloseTo(6.9, 10)
  })

  it('drops a baseline open day the scoped scan no longer has', () => {
    const scoped = parseDailyUsage(report([]))!
    const merged = mergeDailyUsage(baseline, scoped, '2026-10-03')
    expect(merged?.rows.map((r) => r.period)).toEqual(['2026-10-01', '2026-10-02'])
  })

  it('ignores a scoped row dated before the open days', () => {
    const scoped = parseDailyUsage(report([row('2026-10-02', 999, 9), row('2026-10-03', 300, 3)]))!
    const merged = mergeDailyUsage(baseline, scoped, '2026-10-03')
    expect(merged?.rows.find((r) => r.period === '2026-10-02')?.totalTokens).toBe(200)
  })

  it('carries the scoped scan\'s other top-level keys', () => {
    const scoped = parseDailyUsage(report([row('2026-10-03', 300, 3)], { schemaVersion: 2 }))!
    expect(mergeDailyUsage(baseline, scoped, '2026-10-03')?.rest).toEqual({ schemaVersion: 2 })
  })

  it('returns null when a totals figure cannot be rebuilt from the rows', () => {
    const scoped = parseDailyUsage(JSON.stringify({ daily: [row('2026-10-03', 1, 1)], totals: { totalTokens: 1, mysteryFigure: 7 } }))!
    expect(mergeDailyUsage(baseline, scoped, '2026-10-03')).toBeNull()
  })
})
