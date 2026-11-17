import { describe, expect, it } from 'vitest'
import {
  formatAbsoluteTime,
  formatBytes,
  formatClockSkew,
  formatCompactCount,
  formatCurrency,
  formatDuration,
  formatRelativeTime,
  formatUntil,
} from './units.js'

const NOW = Date.parse('2026-10-16T09:42:00Z')

describe('formatDuration', () => {
  it('gives days and hours for long spans', () => {
    expect(formatDuration(638906)).toBe('7d 9h')
  })
  it('gives hours and minutes, then minutes, for shorter ones', () => {
    expect(formatDuration(5400)).toBe('1h 30m')
    expect(formatDuration(240)).toBe('4m')
  })
})

describe('formatCompactCount', () => {
  it('rounds large counts to two decimals with a suffix', () => {
    expect(formatCompactCount(7481534789)).toBe('7.48B')
    expect(formatCompactCount(860319582)).toBe('860.32M')
    expect(formatCompactCount(3000)).toBe('3K')
  })
  it('leaves small counts whole', () => {
    expect(formatCompactCount(412)).toBe('412')
  })
})

describe('formatCurrency', () => {
  it('rounds to whole dollars with separators from $100 up', () => {
    expect(formatCurrency(3708.125205729999)).toBe('$3,708')
  })
  it('keeps cents below $100', () => {
    expect(formatCurrency(4.25)).toBe('$4.25')
    expect(formatCurrency(0)).toBe('$0.00')
  })
})

describe('formatRelativeTime', () => {
  it('reads as an age against the given now', () => {
    expect(formatRelativeTime('2026-10-16T09:41:58Z', NOW)).toBe('just now')
    expect(formatRelativeTime('2026-10-16T09:41:00Z', NOW)).toBe('1m ago')
    expect(formatRelativeTime('2026-10-16T06:42:00Z', NOW)).toBe('3h ago')
    expect(formatRelativeTime('2026-09-24T04:53:01.579Z', NOW)).toBe('22d ago')
  })
  it('treats a timestamp slightly ahead of now as just now', () => {
    expect(formatRelativeTime('2026-10-16T09:42:03Z', NOW)).toBe('just now')
  })
})

describe('formatAbsoluteTime', () => {
  it('gives a full date and time in the given zone', () => {
    expect(formatAbsoluteTime('2026-09-24T04:53:01.579Z', 'UTC')).toBe('24 Sept 2026, 4:53 am')
  })
})

describe('formatClockSkew', () => {
  it('calls a skew within a minute in sync, otherwise says which way', () => {
    expect(formatClockSkew(-20)).toBe('in sync')
    expect(formatClockSkew(7200)).toBe('2h 0m ahead')
    expect(formatClockSkew(-5400)).toBe('1h 30m behind')
  })
})

describe('formatBytes', () => {
  it('uses binary units, labelled as Windows labels them, with one decimal below 10', () => {
    expect(formatBytes(59013263360)).toBe('55 GB')
    expect(formatBytes(4708917248)).toBe('4.4 GB')
    expect(formatBytes(109197166)).toBe('104 MB')
    expect(formatBytes(512)).toBe('512 B')
  })
})

describe('formatUntil', () => {
  it('reads as time to go against the given now', () => {
    expect(formatUntil('2026-10-17T09:00:00Z', NOW)).toBe('in 23h 18m')
    expect(formatUntil('2026-10-16T09:52:00Z', NOW)).toBe('in 10m')
  })

  it('calls a time already past due', () => {
    expect(formatUntil('2026-10-16T09:00:00Z', NOW)).toBe('due')
  })
})
