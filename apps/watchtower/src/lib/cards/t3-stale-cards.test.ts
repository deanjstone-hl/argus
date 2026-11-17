import type { ServiceCheck } from '@argus/watchtower-contract'
import { describe, expect, it } from 'vitest'
import { CARD_FORMATTERS, formatCard } from './registry.js'

// `<host>:t3-stale`, built by the collector from argus-config's hooks/t3-stale.py
// (argus#1175). Versions are the ones the hook printed on WSL2 on 2026-11-11.
const NOW = Date.parse('2026-11-11T02:00:30Z')

function check(overrides: Partial<ServiceCheck> = {}, detail: Record<string, unknown> = {}): ServiceCheck {
  return {
    service_key: 'lnv-lgn5:t3-stale',
    host: 'lnv-lgn5',
    status: 'degraded',
    checked_at: '2026-11-11T02:00:00.000Z',
    detail: {
      host: 'wsl2',
      channel: 'nightly',
      active: '0.1.8-nightly.20261106.1',
      newest: '0.1.8-nightly.20261107.1',
      behindDays: 4,
      thresholdDays: 3,
      ...detail,
    },
    ...overrides,
  } as ServiceCheck
}

const pairs = (view: ReturnType<typeof formatCard>) => view.rows.map((row) => [row.label, row.value])

describe('T3 staleness card', () => {
  it('has a dedicated formatter for each host’s key, and not for the timers card', () => {
    for (const key of ['lnv-lgn5:t3-stale', 'homelab:t3-stale']) {
      expect(CARD_FORMATTERS.some((formatter) => formatter.matches(check({ service_key: key }))), key).toBe(true)
    }
    const timers = check({ service_key: 'homelab:timers' })
    expect(CARD_FORMATTERS.find((formatter) => formatter.matches(timers))?.id).not.toBe('t3-stale')
  })

  it('leads with the reason: the host, the days behind, and which versions', () => {
    const view = formatCard(check(), NOW)
    expect(view.title).toBe('T3 on wsl2')
    expect(view.reason).toBe('wsl2 4 days behind: running 0.1.8-nightly.20261106.1, newest is 0.1.8-nightly.20261107.1 (flagged at 3 days)')
    expect(view.stale).toBeNull()
  })

  it('says 1 day, not 1 days', () => {
    const view = formatCard(check({}, { behindDays: 1, thresholdDays: 1 }), NOW)
    expect(view.reason).toBe('wsl2 1 day behind: running 0.1.8-nightly.20261106.1, newest is 0.1.8-nightly.20261107.1 (flagged at 1 day)')
  })

  it('shows the versions and days in rows', () => {
    expect(pairs(formatCard(check(), NOW))).toEqual([
      ['Running', '0.1.8-nightly.20261106.1'],
      ['Newest', '0.1.8-nightly.20261107.1'],
      ['Behind', '4 days'],
      ['Channel', 'nightly'],
      ['Flagged at', '3 days behind'],
    ])
  })

  it('is healthy and has no reason at 0 days behind', () => {
    const view = formatCard(check({ status: 'healthy' }, { newest: '0.1.8-nightly.20261106.1', behindDays: 0 }), NOW)
    expect(view.reason).toBeNull()
    expect(view.summary).toBe('0.1.8-nightly.20261106.1 · up to date')
  })

  it('stays healthy under the threshold and says how far behind it is', () => {
    const view = formatCard(check({ status: 'healthy' }, { active: '0.1.8-nightly.20261109.4399', newest: '0.1.9', behindDays: 1 }), NOW)
    expect(view.reason).toBeNull()
    expect(view.summary).toBe('0.1.8-nightly.20261109.4399 · 1 day behind')
  })

  it('marks a reading older than the usual allowance as stale', () => {
    const view = formatCard(check({ checked_at: '2026-11-11T01:00:00.000Z' }), NOW)
    expect(view.stale).toEqual({ age: '1h ago', at: expect.any(String) })
  })

  it('shows the hook’s own error when it could not measure', () => {
    const failed = formatCard({ ...check(), detail: { error: 't3 stale: no readable activeVersion in /home/deanj/.t3/runtime/service-state.json' } } as ServiceCheck, NOW)
    expect(failed.reason).toBe('t3 stale: no readable activeVersion in /home/deanj/.t3/runtime/service-state.json')
    expect(failed.rows).toEqual([])
  })
})
