import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { evaluateMemory, parseMeminfo, parsePressure } from './memory.js'

// /proc/meminfo and /proc/pressure/memory captured on homelab, 2026-10-16
// 12:44 UTC: 8 GB, about 6 GB available, PSI under 1%.
const MEMINFO = readFileSync(new URL('./__fixtures__/homelab-meminfo.txt', import.meta.url), 'utf8')
const PRESSURE = readFileSync(new URL('./__fixtures__/homelab-pressure-memory.txt', import.meta.url), 'utf8')
const GB = 1024 ** 3

describe('parseMeminfo', () => {
  it('reads total, available and swap in bytes', () => {
    const memory = parseMeminfo(MEMINFO)
    expect(memory.totalBytes).toBe(8021120 * 1024)
    expect(memory.availableBytes).toBeGreaterThan(5 * GB)
    expect(memory.swapTotalBytes).toBeGreaterThan(0)
  })
})

describe('parsePressure', () => {
  it('reads some and full', () => {
    expect(parsePressure(PRESSURE)).toEqual({
      some: { avg10: 0.14, avg60: 1.05, avg300: 1.8 },
      full: { avg10: 0.12, avg60: 0.59, avg300: 1.34 },
    })
  })

  it('is null without both lines', () => {
    expect(parsePressure('')).toBeNull()
  })
})

describe('evaluateMemory', () => {
  const real = { ...parseMeminfo(MEMINFO), pressure: parsePressure(PRESSURE) }
  const stalled = (some: number, full: number) => ({
    ...real,
    pressure: { some: { avg10: 0, avg60: some, avg300: 0 }, full: { avg10: 0, avg60: full, avg300: 0 } },
  })

  it('is healthy on the real homelab reading', () => {
    expect(evaluateMemory(real).status).toBe('healthy')
  })

  it('is degraded when some task stalled 10% of the last minute', () => {
    expect(evaluateMemory(stalled(10, 0)).status).toBe('degraded')
  })

  it('is down when every task stalled 10% of the last minute', () => {
    expect(evaluateMemory(stalled(12, 10)).status).toBe('down')
  })

  it('is degraded under 10% available', () => {
    expect(evaluateMemory({ ...real, availableBytes: real.totalBytes * 0.09 }).status).toBe('degraded')
  })

  it('judges by availability alone without PSI', () => {
    expect(evaluateMemory({ ...real, pressure: null }).status).toBe('healthy')
  })
})
