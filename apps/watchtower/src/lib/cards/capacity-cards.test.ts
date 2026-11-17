import { readFileSync } from 'node:fs'
import type { ServiceCheck } from '@argus/watchtower-contract'
import { describe, expect, it } from 'vitest'
import { CARD_FORMATTERS, formatCard } from './registry.js'
import type { CardView, DetailRow } from './types.js'
import { formatStorage } from './units.js'

// The capacity cards, produced by running the collector's own adapters on
// data captured on 2026-10-16 around 16:36 UTC: argus-watchtower's real
// storage analytics and row counts, both Supabase projects' real sizes and
// plan, and WSL2's real ccusage window with homelab idle. The second D1 card
// is the same database read with today's token, which cannot query D1.
const FIXTURES = JSON.parse(readFileSync(new URL('./__fixtures__/capacity-cards.json', import.meta.url), 'utf8')) as {
  cards: ServiceCheck[]
  d1WithoutQueryScope: ServiceCheck
}

const NOW = Date.parse('2026-10-16T16:37:00Z')

function fixture(serviceKey: string): ServiceCheck {
  const check = FIXTURES.cards.find((candidate) => candidate.service_key === serviceKey)
  if (!check) throw new Error(`no fixture for ${serviceKey}`)
  return structuredClone(check)
}

const card = (check: ServiceCheck): CardView => formatCard(check, NOW)
const pairs = (rows: DetailRow[]) => rows.map((row) => [row.label, row.value])
const detailOf = (check: ServiceCheck) => check.detail as Record<string, unknown>
const ALL = () => [...FIXTURES.cards, FIXTURES.d1WithoutQueryScope]

function allText(view: CardView): string {
  const lines = [view.title, view.summary, view.reason, ...[...view.rows, ...view.sections.flatMap((entry) => [{ label: entry.title, value: entry.empty ?? '' }, ...entry.rows])].flatMap((row) => [row.label, row.value])]
  return lines.filter(Boolean).join('\n')
}

describe('every capacity card', () => {
  it('has a dedicated formatter', () => {
    for (const check of ALL()) {
      expect(CARD_FORMATTERS.some((formatter) => formatter.matches(check)), check.service_key).toBe(true)
    }
  })

  it('renders no raw JSON, ISO timestamps or raw byte counts outside the raw view', () => {
    for (const check of ALL()) {
      const text = allText(card(check))
      expect(text, check.service_key).not.toMatch(/[{[]"/)
      expect(text, check.service_key).not.toMatch(/\d{4}-\d{2}-\d{2}T/)
      expect(text, check.service_key).not.toMatch(/\d{7,}/)
    }
  })

  it('titles each card by what it measures', () => {
    expect(FIXTURES.cards.map((check) => card(check).title)).toEqual(['argus-watchtower', 'myargus database', 'claude-memory database', 'Claude window'])
  })
})

describe('formatStorage', () => {
  it('uses the decimal units plan limits are quoted in', () => {
    expect([formatStorage(36_880_384), formatStorage(500_000_000), formatStorage(5_000_000_000), formatStorage(950), formatStorage(332_271_600)]).toEqual([
      '36.9 MB',
      '500 MB',
      '5 GB',
      '950 B',
      '332 MB',
    ])
  })
})

describe('D1 card', () => {
  it('shows size against the limit and the rows in each table', () => {
    const view = card(fixture('d1:argus-watchtower'))
    expect(view.summary).toBe('36.9 MB of 500 MB (7%) · 59,539 rows')
    expect(view.reason).toBeNull()
    expect(pairs(view.rows)).toEqual([
      ['Size', '36.9 MB'],
      ['Limit', '500 MB'],
      ['Rows counted', '30s ago'],
    ])
    expect(view.sections).toEqual([
      {
        title: 'Tables',
        rows: [
          { label: 'service_checks', value: '59,525' },
          { label: 'service_checks_latest', value: '14' },
        ],
        empty: undefined,
      },
    ])
  })

  it('says why there are no row counts, and that the size is the day’s peak, without D1 Read', () => {
    const view = card(structuredClone(FIXTURES.d1WithoutQueryScope))
    expect(view.summary).toBe('332 MB of 500 MB (66%)')
    const size = view.rows.find((row) => row.label === 'Peak size today')
    expect(size?.value).toBe('332 MB')
    expect(size?.title).toMatch(/lags/)
    expect(view.sections).toEqual([{ title: 'Tables', rows: [], empty: 'The Cloudflare token cannot query D1 (needs Account > D1: Read)' }])
  })

  it('leads a degraded card with how full it is', () => {
    const check = fixture('d1:argus-watchtower')
    check.status = 'degraded'
    detailOf(check).sizeBytes = 420_000_000
    expect(card(check).reason).toBe('At 84% of its 500 MB limit')
  })
})

describe('Supabase usage card', () => {
  it('shows database size against the plan and says egress is not reported', () => {
    const view = card(fixture('supabase-usage:iyqhnvandyalaujyqbtj'))
    expect(view.summary).toBe('108 MB of 500 MB (22%) · free plan')
    expect(view.reason).toBeNull()
    expect(pairs(view.rows)).toEqual([
      ['Plan', 'free'],
      ['Database', '108 MB of 500 MB'],
      ['Egress', 'Not reported · limit 5 GB a cycle'],
    ])
    expect(view.rows.find((row) => row.label === 'Egress')?.title).toBe('The Management API does not report egress')
  })

  it('leads a degraded card with how full the database is', () => {
    const check = fixture('supabase-usage:centbxttgyenxtkknepx')
    check.status = 'down'
    detailOf(check).dbSizeBytes = 480_000_000
    expect(card(check).reason).toBe('Database at 96% of the free plan’s 500 MB')
  })

  it('shows size alone on a plan with no known limit', () => {
    const check = fixture('supabase-usage:centbxttgyenxtkknepx')
    Object.assign(detailOf(check), { plan: 'enterprise', dbLimitBytes: null, egressLimitBytes: null })
    const view = card(check)
    expect(view.summary).toBe('32.4 MB · enterprise plan')
    expect(pairs(view.rows)).toContainEqual(['Database', '32.4 MB'])
    expect(pairs(view.rows)).toContainEqual(['Egress', 'Not reported'])
  })
})

describe('Claude window card, from the OAuth usage endpoint', () => {
  const oauthCheck = (detail: Record<string, unknown>, status: ServiceCheck['status'] = 'healthy'): ServiceCheck => ({
    ...fixture('claude-window'),
    status,
    detail,
  })

  it('shows usage against the cap, with each window’s reset', () => {
    const view = card(
      oauthCheck({
        source: 'oauth-usage',
        fiveHour: { utilization: 42, resetsAt: '2026-10-16T18:00:00+00:00' },
        sevenDay: { utilization: 63.25, resetsAt: '2026-10-19T00:00:00+00:00' },
      }),
    )
    expect(view.title).toBe('Claude window')
    expect(view.summary).toBe('42% of 5-hour · resets in 1h 23m · week 63.3%')
    expect(view.reason).toBeNull()
    expect(pairs(view.rows)).toEqual([
      ['5-hour', '42% · resets in 1h 23m'],
      ['Week', '63.3% · resets in 2d 7h'],
    ])
    expect(view.sections).toEqual([])
  })

  it('shows the five-hour window alone when the weekly one is missing', () => {
    const view = card(oauthCheck({ source: 'oauth-usage', fiveHour: { utilization: 5, resetsAt: null }, sevenDay: null }))
    expect(view.summary).toBe('5% of 5-hour')
    expect(pairs(view.rows)).toEqual([['5-hour', '5%']])
  })

  it('leads with the reason when the usage could not be read', () => {
    const view = card(oauthCheck({ source: 'oauth-usage', fiveHour: null, sevenDay: null, error: 'no OAuth credentials (ENOENT)' }, 'degraded'))
    expect(view.summary).toBe('Usage unavailable')
    expect(view.reason).toBe('no OAuth credentials (ENOENT)')
    expect(view.rows).toEqual([])
  })
})

describe('Claude window card, from a row recorded from ccusage blocks', () => {
  it('shows the open window’s usage and when it ends, per host', () => {
    const view = card(fixture('claude-window'))
    expect(view.summary).toBe('70.55M tokens · $29.87 · ends in 1h 23m')
    expect(view.reason).toBeNull()
    expect(pairs(view.rows)).toEqual([
      ['Ends', 'in 1h 23m'],
      ['Projected cost', '$41.49'],
    ])
    expect(view.sections).toEqual([
      {
        title: 'Hosts',
        rows: [
          { label: 'homelab', value: 'idle' },
          { label: 'wsl2', value: '70.55M tokens · $29.87 · opened 3h 37m ago' },
        ],
        empty: undefined,
      },
    ])
  })

  it('says plainly when no window is open', () => {
    const check = fixture('claude-window')
    const detail = detailOf(check) as { hosts: Array<Record<string, unknown>> }
    detail.hosts = detail.hosts.map((host) => ({ ...host, status: 'idle', startTime: null, endTime: null, totalTokens: 0, costUSD: 0, projectedCost: null }))
    Object.assign(detail, { totalTokens: 0, costUSD: 0, projectedCost: null, endsAt: null })
    const view = card(check)
    expect(view.summary).toBe('No window open')
    expect(view.rows).toEqual([])
  })

  it('leads with a host whose shim cannot report the window', () => {
    const check = fixture('claude-window')
    check.status = 'degraded'
    const detail = detailOf(check) as { hosts: Array<Record<string, unknown>> }
    detail.hosts[0] = { ...detail.hosts[0], name: 'windows', status: 'unsupported', error: 'Its usage shim does not serve GET /blocks yet' }
    const view = card(check)
    expect(view.reason).toBe('windows: Its usage shim does not serve GET /blocks yet')
    expect(view.sections[0]?.rows[0]).toEqual({ label: 'windows', value: 'Its usage shim does not serve GET /blocks yet', tone: 'warn' })
  })
})
