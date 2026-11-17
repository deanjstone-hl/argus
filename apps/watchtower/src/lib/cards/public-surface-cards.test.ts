import { readFileSync } from 'node:fs'
import type { ServiceCheck } from '@argus/watchtower-contract'
import { describe, expect, it } from 'vitest'
import { CARD_FORMATTERS, formatCard } from './registry.js'
import type { CardView, DetailRow } from './types.js'

// The public-surface cards, produced by running the collector's own adapters
// on data captured on 2026-10-16 around 15:42 UTC: the real anonymous probes
// of every *.myargus.cc endpoint, the certificates each host presented, and
// the account's real Workers analytics for the hour, read with a token that
// could not read zone analytics.
const FIXTURES = JSON.parse(
  readFileSync(new URL('./__fixtures__/public-surface-cards.json', import.meta.url), 'utf8'),
) as ServiceCheck[]

const NOW = Date.parse('2026-10-16T15:43:00Z')

function fixture(serviceKey: string): ServiceCheck {
  const check = FIXTURES.find((candidate) => candidate.service_key === serviceKey)
  if (!check) throw new Error(`no fixture for ${serviceKey}`)
  return structuredClone(check)
}

const card = (check: ServiceCheck): CardView => formatCard(check, NOW)
const pairs = (rows: DetailRow[]) => rows.map((row) => [row.label, row.value])
const detailOf = (check: ServiceCheck) => check.detail as Record<string, unknown>

function allText(view: CardView): string {
  const lines = [view.title, view.summary, view.reason, ...[...view.rows, ...view.sections.flatMap((entry) => [{ label: entry.title, value: entry.empty ?? '' }, ...entry.rows])].flatMap((row) => [row.label, row.value])]
  return lines.filter(Boolean).join('\n')
}

describe('every public-surface card', () => {
  it('has a dedicated formatter', () => {
    for (const check of FIXTURES) {
      expect(CARD_FORMATTERS.some((formatter) => formatter.matches(check)), check.service_key).toBe(true)
    }
  })

  it('renders no raw JSON, ISO timestamps or raw counts outside the raw view', () => {
    for (const check of FIXTURES) {
      const text = allText(card(check))
      expect(text, check.service_key).not.toMatch(/[{[]"/)
      expect(text, check.service_key).not.toMatch(/\d{4}-\d{2}-\d{2}T/)
      expect(text, check.service_key).not.toMatch(/\d{7,}/)
    }
  })

  it('titles each card by its host or Worker', () => {
    expect(FIXTURES.map((check) => card(check).title)).toEqual([
      'api.myargus.cc', 'memory.myargus.cc', 'vault.myargus.cc', 'mail.myargus.cc', 'mcp.myargus.cc', 'watchtower.myargus.cc',
      'api certificate', 'memory certificate', 'vault certificate', 'mail certificate', 'mcp certificate', 'watchtower certificate',
      'reader-api', 'argus-memory-mcp', 'argus-agent-email', 'argus-agent-email-mcp', 'argus-email', 'argus-vault-agent-relay', 'argus-watchtower-api',
    ])
  })
})

describe('endpoint probes', () => {
  it('shows a 401 from an API as up, with its latency', () => {
    const view = card(fixture('endpoint:api.myargus.cc'))
    expect(view.summary).toBe('401, wants a token · 234 ms')
    expect(view.reason).toBeNull()
    expect(pairs(view.rows)).toEqual([
      ['Probes', '/watchtower/checks'],
      ['Answer', '401'],
      ['Expected', '401'],
      ['Latency', '234 ms'],
    ])
  })

  it('shows mail’s redirect to the Access login', () => {
    const view = card(fixture('endpoint:mail.myargus.cc'))
    expect(view.summary).toBe('302 to Cloudflare Access · 185 ms')
    expect(pairs(view.rows)).toContainEqual(['Redirects to', 'team.cloudflareaccess.com'])
  })

  it('shows a plain 200 plainly', () => {
    expect(card(fixture('endpoint:watchtower.myargus.cc')).summary).toBe('200 · 201 ms')
  })

  it('leads a 5xx with the answer', () => {
    const check = fixture('endpoint:memory.myargus.cc')
    check.status = 'down'
    detailOf(check).statusCode = 502
    expect(card(check).reason).toBe('Answered 502')
  })

  it('says what it expected when the answer is wrong', () => {
    const check = fixture('endpoint:api.myargus.cc')
    check.status = 'degraded'
    detailOf(check).statusCode = 200
    expect(card(check).reason).toBe('Answered 200, expected 401')
  })

  it('says where a redirect went when it is not Access', () => {
    const check = fixture('endpoint:mail.myargus.cc')
    check.status = 'degraded'
    detailOf(check).redirectHost = 'example.com'
    expect(card(check).reason).toBe('Redirected to example.com, not Cloudflare Access')
  })

  it('says a right answer was slow', () => {
    const check = fixture('endpoint:vault.myargus.cc')
    check.status = 'degraded'
    detailOf(check).latencyMs = 3500
    expect(card(check).reason).toBe('Slow: 3.5 s, over 3 s')
  })
})

describe('TLS certificates', () => {
  it('shows days to expiry and the issuer', () => {
    const view = card(fixture('tls:vault.myargus.cc'))
    expect(view.summary).toBe('expires in 56 days · Google Trust Services WE1')
    expect(pairs(view.rows)).toEqual([
      ['Expires', 'in 56 days'],
      ['Issuer', 'Google Trust Services WE1'],
      ['Covers', 'myargus.cc, vault.myargus.cc, *.vault.myargus.cc'],
    ])
    expect(view.rows[0]?.title).toContain('2026')
  })

  it('says a renewal is overdue inside three weeks', () => {
    const check = fixture('tls:vault.myargus.cc')
    check.status = 'degraded'
    detailOf(check).daysLeft = 17
    expect(card(check).reason).toBe('Certificate expires in 17 days; Cloudflare should have renewed it by now')
  })

  it('says when a certificate has expired', () => {
    const check = fixture('tls:vault.myargus.cc')
    check.status = 'down'
    detailOf(check).daysLeft = -8
    expect(card(check).reason).toBe('Certificate expired 8 days ago')
    expect(pairs(card(check).rows)).toContainEqual(['Expires', '8 days ago'])
  })

  it('says one day, not one days', () => {
    const check = fixture('tls:vault.myargus.cc')
    check.status = 'down'
    detailOf(check).daysLeft = 1
    expect(card(check).reason).toBe('Certificate expires in 1 day')
  })
})

describe('Worker traffic', () => {
  it('shows the hour’s invocations, and that HTTP status needs a token scope', () => {
    const view = card(fixture('worker-traffic:argus-watchtower-api'))
    expect(view.summary).toBe('452 requests in the last hour · no errors')
    expect(pairs(view.rows)).toEqual([
      ['Route', 'api.myargus.cc/watchtower/*'],
      ['Invocations', '452'],
      ['Exceptions', '0'],
      ['HTTP 4xx/5xx', 'needs Zone Analytics: Read'],
    ])
    expect(view.rows[3]?.title).toMatch(/cannot read zone analytics/)
  })

  it('says a Worker with no HTTP route has none', () => {
    const view = card(fixture('worker-traffic:argus-agent-email'))
    expect(view.summary).toBe('no requests in the last hour')
    expect(pairs(view.rows)).toContainEqual(['HTTP 4xx/5xx', 'not routed over HTTP'])
    expect(pairs(view.rows).map(([label]) => label)).not.toContain('Route')
  })

  it('leads with the 4xx rate on an API Worker refusing its clients', () => {
    const check = fixture('worker-traffic:argus-watchtower-api')
    check.status = 'degraded'
    Object.assign(detailOf(check), { http: { requests: 510, clientErrors: 58, serverErrors: 0 }, httpUnavailable: null })
    const view = card(check)
    expect(view.reason).toBe('58 of 510 requests got a 4xx (11%) in the last hour; clients are being refused')
    expect(view.summary).toBe('510 requests in the last hour · 58 4xx (11%)')
    expect(pairs(view.rows)).toContainEqual(['HTTP 4xx', '58 (11%)'])
    expect(pairs(view.rows)).toContainEqual(['HTTP 5xx', '0'])
  })

  it('leads with the 5xx rate when requests fail', () => {
    const check = fixture('worker-traffic:argus-memory-mcp')
    check.status = 'down'
    Object.assign(detailOf(check), { http: { requests: 100, clientErrors: 0, serverErrors: 20 }, httpUnavailable: null })
    expect(card(check).reason).toBe('20 of 100 requests got a 5xx (20%) in the last hour')
  })

  it('leads with exceptions when only Workers analytics is readable', () => {
    const check = fixture('worker-traffic:argus-memory-mcp')
    check.status = 'down'
    detailOf(check).invocations = { requests: 100, errors: 30, byStatus: { success: 70, scriptThrewException: 30 } }
    const view = card(check)
    expect(view.reason).toBe('30 of 100 invocations threw (30%) in the last hour')
    expect(view.sections).toEqual([
      { title: 'Invocations by outcome', rows: [{ label: 'success', value: '70' }, { label: 'scriptThrewException', value: '30' }] },
    ])
  })

  it('says one request, not one requests', () => {
    expect(card(fixture('worker-traffic:reader-api')).summary).toBe('1 request in the last hour · no errors')
  })

  it('lists outcomes only when something other than success happened', () => {
    expect(card(fixture('worker-traffic:argus-watchtower-api')).sections).toEqual([])
  })
})
