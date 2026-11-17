import { readFileSync } from 'node:fs'
import type { ServiceCheck } from '@argus/watchtower-contract'
import { describe, expect, it } from 'vitest'
import { CARD_FORMATTERS, formatCard } from './registry.js'
import type { CardView, DetailRow } from './types.js'
import { formatAllowance, formatSeconds } from './units.js'

// The argus#685 cards, produced by running the collector's own adapters on
// data captured live on 2026-10-16 at 12:44 UTC: homelab's /proc/loadavg,
// /proc/meminfo and memory PSI; argus-config's and budget's main runs with
// argus-config's real red Lint run of 2026-10-15 placed newest; argus's
// queued and finished runner jobs; homelab's `tailscale status --json`, with
// lnv-lgn5-wsl taken offline 40 minutes while LNV-LGN5 stays up.
const FIXTURES = JSON.parse(
  readFileSync(new URL('./__fixtures__/ops-cards.json', import.meta.url), 'utf8'),
) as ServiceCheck[]

const NOW = Date.parse('2026-10-16T12:45:00Z')

function fixture(serviceKey: string): ServiceCheck {
  const check = FIXTURES.find((candidate) => candidate.service_key === serviceKey)
  if (!check) throw new Error(`no fixture for ${serviceKey}`)
  return structuredClone(check)
}

const card = (check: ServiceCheck): CardView => formatCard(check, NOW)
const pairs = (rows: DetailRow[]) => rows.map((row) => [row.label, row.value])

function allText(view: CardView): string {
  const lines = [view.title, view.summary, view.reason, ...[...view.rows, ...view.sections.flatMap((section) => [{ label: section.title, value: section.empty ?? '' }, ...section.rows])].flatMap((row) => [row.label, row.value])]
  return lines.filter(Boolean).join('\n')
}

describe('every argus#685 card', () => {
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

  it('gives every non-healthy card a reason, and no healthy one', () => {
    for (const check of FIXTURES) {
      const view = card(check)
      if (check.status === 'healthy') expect(view.reason, check.service_key).toBeNull()
      else expect(view.reason, check.service_key).toBeTruthy()
    }
  })
})

describe('units', () => {
  it('formats short waits in seconds and longer ones as durations', () => {
    expect(formatSeconds(12)).toBe('12s')
    expect(formatSeconds(1699)).toBe('28m')
    expect(formatSeconds(3800)).toBe('1h 3m')
  })

  it('formats an offline allowance in its own unit', () => {
    expect(formatAllowance(3_600_000)).toBe('1h')
    expect(formatAllowance(12 * 3_600_000)).toBe('12h')
    expect(formatAllowance(7 * 86_400_000)).toBe('7d')
    expect(formatAllowance(30 * 60_000)).toBe('30m')
    expect(formatAllowance(90 * 60_000)).toBe('1h 30m')
  })
})

describe('homelab load', () => {
  it('shows the three averages and the CPU count', () => {
    const view = card(fixture('homelab:load'))
    expect(view.title).toBe('Load')
    expect(view.summary).toBe('6.19 · 4.21 · 4.04 on 4 CPUs')
    expect(pairs(view.rows)).toEqual([
      ['1 min', '6.19'],
      ['5 min', '4.21'],
      ['15 min', '4.04'],
      ['CPUs', '4'],
    ])
  })

  it('says why it is degraded', () => {
    const check = fixture('homelab:load')
    check.status = 'degraded'
    check.detail = { ...check.detail, load5: 9.1 }
    expect(card(check).reason).toBe('Load 9.10 over 5 minutes on 4 CPUs')
  })
})

describe('homelab memory', () => {
  it('reads like the WSL2 memory card, titled for homelab', () => {
    const view = card(fixture('homelab:memory'))
    expect(view.title).toBe('Memory')
    expect(view.summary).toBe('5.5 GB of 7.6 GB available')
    expect(pairs(view.rows)).toEqual([
      ['Available', '5.5 GB of 7.6 GB'],
      ['Swap used', '1.5 GB of 4 GB'],
      ['Pressure (1 min)', '1% some · 1% full'],
    ])
  })
})

describe('main CI', () => {
  it('names the failed workflow and its failed jobs', () => {
    const view = card(fixture('github-ci:argus-config'))
    expect(view.title).toBe('argus-config')
    expect(view.summary).toBe('failing · Lint')
    expect(view.reason).toBe('Lint failed: Bats tests')
    expect(view.sections).toEqual([
      { title: 'Workflows', rows: [{ label: 'Lint', value: 'failed 1d ago', tone: 'warn', title: expect.any(String) }], empty: 'No workflow runs on main' },
    ])
  })

  it('lists each passing workflow', () => {
    const view = card(fixture('github-ci:budget'))
    expect(view.summary).toBe('passing · 4 workflows')
    expect(view.reason).toBeNull()
    expect(pairs(view.sections[0]?.rows ?? [])).toEqual([
      ['CI', 'passed 14h ago'],
      ['Notify on failure', 'passed 1d ago'],
      ['Release', 'passed 14h ago'],
      ['Secret Scanning', 'passed 14h ago'],
    ])
  })

  it('says when a repo has no runs on main', () => {
    const view = card(fixture('github-ci:ledger-spa'))
    expect(view.summary).toBe('no runs on main')
    expect(view.sections).toEqual([{ title: 'Workflows', rows: [], empty: 'No workflow runs on main' }])
  })

  it('shows a workflow running now beside its last result', () => {
    const check = fixture('github-ci:budget')
    const detail = check.detail as { workflows: Array<Record<string, unknown>> }
    detail.workflows[0] = { ...detail.workflows[0], running: true }
    detail.workflows[1] = { ...detail.workflows[1], conclusion: null, completedAt: null, running: true }
    expect(pairs(card(check).sections[0]?.rows ?? []).slice(0, 2)).toEqual([
      ['CI', 'passed 14h ago · running'],
      ['Notify on failure', 'running'],
    ])
  })

  it('words a timeout and a failure to start', () => {
    const check = fixture('github-ci:argus-config')
    const detail = check.detail as { workflows: Array<Record<string, unknown>> }
    detail.workflows = [
      { ...detail.workflows[0], name: 'A', conclusion: 'timed_out', failedJobs: [] },
      { ...detail.workflows[0], name: 'B', conclusion: 'startup_failure', failedJobs: [] },
    ]
    const view = card(check)
    expect(view.reason).toBe('A timed out; B failed to start')
    expect(pairs(view.sections[0]?.rows ?? [])).toEqual([
      ['A', 'timed out 1d ago'],
      ['B', 'failed to start 1d ago'],
    ])
  })
})

describe('runner queue', () => {
  it('leads with the worse of the oldest wait and the slowest repo’s p90', () => {
    const view = card(fixture('github-runners:queue'))
    expect(view.title).toBe('Runner queue')
    expect(view.summary).toBe('8 waiting · oldest 13m')
    expect(view.reason).toBe('argus jobs waited 1h 3m for a runner (p90, last 24h)')
    expect(pairs(view.rows)).toEqual([
      ['Waiting now', '8 jobs'],
      ['Oldest waiting', 'Build (wiki) · CI · argus, 13m'],
    ])
    expect(view.sections.map((section) => [section.title, pairs(section.rows), section.empty])).toEqual([
      ['argus', [['Waiting now', '8'], ['Median wait', '28m'], ['p90 wait', '1h 3m'], ['Longest wait', '1h 13m'], ['Jobs taken (24h)', '27']], 'No jobs in the last 24h'],
      ['pkm-vault', [], 'No jobs in the last 24h'],
    ])
  })

  it('leads with a job stuck in the queue when that is worse', () => {
    const check = fixture('github-runners:queue')
    check.status = 'down'
    expect(formatCard(check, Date.parse('2026-10-16T14:45:00Z')).reason).toBe('Build (wiki) on argus queued for 2h 13m')
  })

  it('says nothing is waiting', () => {
    const check = fixture('github-runners:queue')
    check.detail = { ...check.detail, waiting: 0, oldestWaiting: null }
    expect(card(check).summary).toBe('none waiting')
    expect(pairs(card(check).rows)).toEqual([['Waiting now', 'none']])
  })
})

describe('tailscale', () => {
  it('flags WSL2 gone while its Windows host is up', () => {
    const view = card(fixture('tailscale:lnv-lgn5-wsl'))
    expect(view.title).toBe('lnv-lgn5-wsl')
    expect(view.summary).toBe('offline · last seen 40m ago')
    expect(view.reason).toBe('Offline 40m while LNV-LGN5 is online')
    expect(pairs(view.rows)).toEqual([
      ['State', 'offline'],
      ['Last seen', '40m ago'],
      ['OS', 'linux'],
      ['Address', '100.64.0.1'],
      ['Allowed offline', '12h'],
      ['Alongside', 'LNV-LGN5'],
    ])
  })

  it('shows a phone inside its allowance as offline but healthy', () => {
    const view = card(fixture('tailscale:DJ15'))
    expect(view.summary).toBe('offline · last seen 2h ago')
    expect(view.reason).toBeNull()
  })

  it('says how long past its allowance a device is', () => {
    const check = fixture('tailscale:DJ15')
    check.status = 'degraded'
    check.detail = { ...check.detail, offlineAfterMs: 3_600_000 }
    expect(card(check).reason).toBe('Last seen 2h ago, longer than the 1h allowed')
  })

  it('marks homelab as this host and shows key expiry', () => {
    expect(card(fixture('tailscale:homelab')).summary).toBe('online · this host')
    expect(pairs(card(fixture('tailscale:aperture')).rows)).toContainEqual(['Key expires', 'in 130d 8h'])
  })
})
