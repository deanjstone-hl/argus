import { readFileSync } from 'node:fs'
import type { ServiceCheck } from '@argus/watchtower-contract'
import { describe, expect, it } from 'vitest'
import { CARD_FORMATTERS, STALE_AFTER_MS, formatCard, isStale } from './registry.js'
import type { CardView, DetailRow } from './types.js'

// Real latest rows from D1 `service_checks` on 2026-10-16, plus the real
// degraded/down rows seen that day (syncthing, ai-usage, cloudflare:myargus)
// and the ccbot unit's last row from 2026-09-24.
const FIXTURES = JSON.parse(
  readFileSync(new URL('./__fixtures__/real-checks.json', import.meta.url), 'utf8'),
) as ServiceCheck[]

const NOW = Date.parse('2026-10-16T09:42:00Z')

function fixture(serviceKey: string): ServiceCheck {
  const check = FIXTURES.find((candidate) => candidate.service_key === serviceKey)
  if (!check) throw new Error(`no fixture for ${serviceKey}`)
  return check
}

function card(serviceKey: string, overrides: Partial<ServiceCheck> = {}): CardView {
  return formatCard({ ...fixture(serviceKey), ...overrides }, NOW)
}

const pairs = (rows: DetailRow[]) => rows.map((row) => [row.label, row.value])

// Every string a card renders, outside the raw view.
function allText(view: CardView): string {
  const lines = [view.title, view.summary, view.reason, ...[...view.rows, ...view.sections.flatMap((section) => [{ label: section.title, value: section.empty ?? '' }, ...section.rows])].flatMap((row) => [row.label, row.value])]
  return lines.filter(Boolean).join('\n')
}

describe('every real card', () => {
  it('renders no raw JSON, deployment ids or script tags outside the raw view', () => {
    for (const check of FIXTURES) {
      const text = allText(formatCard(check, NOW))
      expect(text, check.service_key).not.toMatch(/[{[]"/)
      expect(text, check.service_key).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}/)
      expect(text, check.service_key).not.toMatch(/[0-9a-f]{32}/)
    }
  })

  it('keeps the untouched detail for the raw view', () => {
    const check = fixture('cloudflare:reader-api')
    expect(formatCard(check, NOW).raw).toBe(JSON.stringify(check.detail, null, 2))
  })

  it('gives every non-healthy card a reason, and no healthy fresh card one', () => {
    for (const check of FIXTURES) {
      const view = formatCard(check, NOW)
      if (check.status === 'healthy') expect(view.reason, check.service_key).toBeNull()
      else expect(view.reason, check.service_key).toBeTruthy()
    }
  })

  it('matches a dedicated formatter for every real service key', () => {
    for (const check of FIXTURES) {
      expect(
        CARD_FORMATTERS.some((formatter) => formatter.matches(check)),
        check.service_key,
      ).toBe(true)
    }
  })
})

describe('stale cards', () => {
  it('uses three of the slowest collector interval (5 min) as the threshold', () => {
    expect(STALE_AFTER_MS).toBe(15 * 60_000)
  })

  it('flags a check older than the threshold and nothing newer', () => {
    expect(isStale('2026-10-16T09:26:59Z', NOW)).toBe(true)
    expect(isStale('2026-10-16T09:27:01Z', NOW)).toBe(false)
  })

  it('marks the ccbot card stale with its age and the absolute time', () => {
    const view = card('systemd:ccbot.service')
    expect(view.stale).toEqual({ age: '22d ago', at: expect.stringContaining('2026') })
    expect(card('printer').stale).toBeNull()
  })
})

describe('ai-usage', () => {
  it('rounds the totals and names the unreachable host as the reason', () => {
    const view = card('ai-usage')
    expect(view.title).toBe('AI usage')
    expect(view.reason).toBe('wsl2 unreachable: fetch failed')
    expect(view.summary).toBe('860.32M tokens · $542')
    expect(pairs(view.sections[0]!.rows)).toEqual([
      ['homelab', '860.32M tokens · $542'],
      ['wsl2', 'unreachable · fetch failed'],
    ])
    expect(view.sections[0]!.rows[1]!.tone).toBe('warn')
  })

  it('reads 7.48B tokens and $3,708 for the healthy two-host total', () => {
    const view = card('ai-usage', {
      status: 'healthy',
      detail: { totalTokens: 7481534789, totalCost: 3708.125205729999, hosts: [] },
    })
    expect(view.summary).toBe('7.48B tokens · $3,708')
    expect(view.reason).toBeNull()
  })
})

describe('cloudflare', () => {
  it('shows a Worker as its environment and deploy age, never the script object', () => {
    const view = card('cloudflare:reader-api')
    expect(view.title).toBe('reader-api')
    expect(view.summary).toBe('production · deployed 8d ago')
    const deployed = view.rows.find((row) => row.label === 'Deployed')
    expect(deployed?.value).toBe('8d ago')
    expect(deployed?.title).toContain('2026')
    expect(pairs(view.rows).map(([label]) => label)).toEqual(['Environment', 'Deployed'])
  })

  it('reads a Worker whose defaultEnvironment is already a plain string', () => {
    const view = card('cloudflare:reader-api', {
      detail: { defaultEnvironment: 'production', modifiedOn: '2026-10-08T00:47:30.508843Z' },
    })
    expect(view.summary).toBe('production · deployed 8d ago')
  })

  it('shows a Pages project as environment and stage, hiding the deployment id', () => {
    const view = card('cloudflare:knowledge')
    expect(view.title).toBe('knowledge')
    expect(pairs(view.rows)).toEqual([
      ['Environment', 'production'],
      ['Stage', 'success'],
    ])
    expect(view.summary).toBe('production · success')
  })

  it('adds the deploy time when the collector reports one', () => {
    const view = card('cloudflare:knowledge', {
      detail: { ...fixture('cloudflare:knowledge').detail, deployedOn: '2026-10-15T09:42:00Z' },
    })
    expect(view.summary).toBe('production · deployed 1d ago')
    expect(view.rows.find((row) => row.label === 'Deployed')?.value).toBe('1d ago')
  })

  it('says why a Pages project is down', () => {
    expect(card('cloudflare:myargus').reason).toBe('Latest deployment (preview) is active, not success')
  })
})

describe('syncthing', () => {
  it('leads with what is out of sync and lists folders by state', () => {
    const view = card('syncthing')
    expect(view.reason).toBe('2 items out of sync: claude-sessions-wsl2 syncing')
    expect(pairs(view.sections[0]!.rows)).toEqual([
      ['CONTEXT', 'idle'],
      ['CORTEX', 'idle'],
      ['claude-sessions-wsl2', 'syncing · 2 pending'],
    ])
    expect(view.sections[0]!.rows[2]!.tone).toBe('warn')
  })

  it('names folder errors when there are any', () => {
    const view = card('syncthing', {
      detail: {
        folders: [{ id: 'CORTEX', state: 'error', errors: 3, needTotalItems: 0 }],
        totalErrors: 3,
        totalOutOfSync: 0,
      },
    })
    expect(view.reason).toBe('3 folder errors: CORTEX')
  })
})

describe('homelab basics', () => {
  it('shows uptime as days and hours', () => {
    expect(card('homelab:uptime').summary).toBe('up 7d 9h')
  })

  it('shows disk use as a percentage of the path', () => {
    const view = card('homelab:disk:/')
    expect(view.title).toBe('Disk /')
    expect(view.summary).toBe('75% used')
    expect(card('homelab:disk:/', { status: 'degraded', detail: { path: '/', pctUsed: 93 } }).reason).toBe('93% used')
  })

  it('gives a second mount its own disk card, titled by its path', () => {
    const backups = { service_key: 'homelab:disk:/mnt/backups', status: 'degraded' as const, detail: { path: '/mnt/backups', pctUsed: 92 } }
    const view = card('homelab:disk:/', backups)
    expect(view.title).toBe('Disk /mnt/backups')
    expect(view.reason).toBe('92% used')
    expect(card('homelab:disk:/', { ...backups, detail: {} }).title).toBe('Disk /mnt/backups')
  })

  it('shows a systemd unit by name and state, with the state as the reason when down', () => {
    expect(card('systemd:agent-engine.service').title).toBe('agent-engine.service')
    expect(card('systemd:agent-engine.service').summary).toBe('active (running)')
    expect(card('systemd:ccbot.service').reason).toBe('inactive (dead)')
  })

  it('names a Supabase project instead of its ref', () => {
    const view = card('supabase:iyqhnvandyalaujyqbtj')
    expect(view.title).toBe('myargus')
    expect(view.summary).toBe('active healthy · ap-southeast-2')
  })
})

describe('printer and scanner', () => {
  it('summarises the printer by state and lowest ink', () => {
    const view = card('printer')
    expect(view.summary).toBe('idle · lowest ink 17%')
    expect(pairs(view.rows)).toEqual([
      ['Model', 'EPSON WF-3820 Series'],
      ['Printer clock', '9h 0m ahead'],
    ])
    expect(view.sections.map((section) => section.title)).toEqual(['Ink', 'Queue', 'Recent jobs'])
    expect(view.sections[0]!.rows[0]).toMatchObject({ label: 'Black ink', value: '17%', swatch: '#000000' })
    expect(view.sections[2]!.rows[0]!.value).toBe('LNV-LGN5\\deanj · 1 page · completed · 7d ago')
  })

  it('gives the printer message, then its reasons, as the reason', () => {
    const stopped = { ...fixture('printer').detail, state: 'stopped', reasons: ['media-jam-error'], message: 'Paper jam' }
    expect(card('printer', { status: 'down', detail: stopped }).reason).toBe('Paper jam')
    expect(card('printer', { status: 'down', detail: { ...stopped, message: null } }).reason).toBe('media-jam-error')
  })

  it('lists scans by age, not by job id', () => {
    const view = card('scanner')
    expect(view.summary).toBe('idle · feeder empty')
    expect(pairs(view.sections[0]!.rows)).toEqual([
      ['7d ago', '1 page · completed'],
      ['7d ago', '3 pages · completed'],
    ])
  })

  it('names a feeder jam as the reason', () => {
    const jammed = { ...fixture('scanner').detail, adfState: 'jam' }
    expect(card('scanner', { status: 'degraded', detail: jammed }).reason).toBe('Feeder: jam')
  })
})

describe('failed checks and unknown kinds', () => {
  it('uses the poller error as the reason for any kind', () => {
    const view = card('cloudflare:reader-api', { status: 'unreachable', detail: { error: 'fetch failed' } })
    expect(view.reason).toBe('fetch failed')
    expect(view.rows).toEqual([])
  })

  it('falls back to labelled flat fields for a kind with no formatter', () => {
    const view = formatCard(
      { service_key: 'duplicati', host: 'lnv-lgn5', status: 'degraded', checked_at: '2026-10-16T09:40:00Z', detail: { error: 'no backup jobs configured', jobs: [], lastRunSeconds: 5400 } },
      NOW,
    )
    expect(view.title).toBe('duplicati')
    expect(view.reason).toBe('no backup jobs configured')
    expect(pairs(view.rows)).toEqual([['Last run seconds', '5400']])
  })

  it('says no reason was reported rather than leaving a non-healthy card blank', () => {
    const view = formatCard(
      { service_key: 'mystery', host: 'x', status: 'down', checked_at: '2026-10-16T09:40:00Z', detail: null },
      NOW,
    )
    expect(view.reason).toBe('No reason reported')
  })
})
