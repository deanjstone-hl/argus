import { readFileSync } from 'node:fs'
import type { ServiceCheck } from '@argus/watchtower-contract'
import { describe, expect, it } from 'vitest'
import { CARD_FORMATTERS, formatCard } from './registry.js'
import type { CardView, DetailRow } from './types.js'

// The argus#682 cards, produced by running the collector's own adapters on
// data captured live on 2026-10-16: homelab `systemctl show` output, GitHub's
// runners API for all 13 runners, the WSL2 usage-shim's GET /host, and the
// Workers API for the five Workers that had no card.
const FIXTURES = JSON.parse(
  readFileSync(new URL('./__fixtures__/new-cards.json', import.meta.url), 'utf8'),
) as ServiceCheck[]

const NOW = Date.parse('2026-10-16T11:42:00Z')

function fixture(serviceKey: string): ServiceCheck {
  const check = FIXTURES.find((candidate) => candidate.service_key === serviceKey)
  if (!check) throw new Error(`no fixture for ${serviceKey}`)
  return structuredClone(check)
}

function card(check: ServiceCheck): CardView {
  return formatCard(check, NOW)
}

const pairs = (rows: DetailRow[]) => rows.map((row) => [row.label, row.value])

function allText(view: CardView): string {
  const lines = [view.title, view.summary, view.reason, ...[...view.rows, ...view.sections.flatMap((section) => [{ label: section.title, value: section.empty ?? '' }, ...section.rows])].flatMap((row) => [row.label, row.value])]
  return lines.filter(Boolean).join('\n')
}

describe('every new card', () => {
  it('has a dedicated formatter', () => {
    for (const check of FIXTURES) {
      expect(CARD_FORMATTERS.some((formatter) => formatter.matches(check)), check.service_key).toBe(true)
    }
  })

  it('renders no raw JSON, ISO timestamps or byte counts outside the raw view', () => {
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

describe('systemd services', () => {
  it('shows a running service with its uptime and restarts', () => {
    const view = card(fixture('systemd:notice-board.service'))
    expect(view.title).toBe('notice-board.service')
    expect(view.summary).toBe('running · up 5d 11h')
    expect(pairs(view.rows)).toEqual([
      ['State', 'active (running)'],
      ['Up for', '5d 11h'],
      ['Restarts', '2'],
    ])
  })

  it('labels a system unit', () => {
    expect(pairs(card(fixture('systemd:cloudflared.service')).rows)).toContainEqual(['Scope', 'system'])
  })

  it('says a unit that is not installed is not installed', () => {
    const check = fixture('systemd:notice-board.service')
    check.status = 'down'
    check.detail = { ...check.detail, loadState: 'not-found', activeState: 'inactive', subState: 'dead', activeSince: null }
    expect(card(check).reason).toBe('Not installed')
  })

  it('leads a stopped service with its state', () => {
    const check = fixture('systemd:notice-board.service')
    check.status = 'down'
    check.detail = { ...check.detail, activeState: 'failed', subState: 'failed', result: 'exit-code', activeSince: null }
    expect(card(check).reason).toBe('failed (failed): exit-code')
  })

  it('still renders a row recorded before the richer detail', () => {
    const view = card({ service_key: 'systemd:ccbot.service', host: 'homelab', status: 'down', detail: { activeState: 'inactive', subState: 'dead' }, checked_at: '2026-10-16T11:40:00Z' })
    expect(view.reason).toBe('inactive (dead)')
  })
})

describe('systemd timers', () => {
  it('reports the last trigger, its result and the next one', () => {
    const view = card(fixture('systemd:budget-api-cron.timer'))
    expect(view.title).toBe('budget-api-cron.timer')
    expect(view.summary).toBe('last ran 3h ago · success')
    expect(pairs(view.rows)).toEqual([
      ['Last run', '3h ago'],
      ['Result', 'success'],
      ['Took', '38s'],
      ['Next run', 'in 21h 18m'],
      ['Runs', 'budget-api-cron.service'],
    ])
    expect(view.rows[0]?.title).toContain('2026')
  })

  it('leads a failed run with its result and exit status', () => {
    const check = fixture('systemd:budget-api-cron.timer')
    check.status = 'down'
    const detail = check.detail as { timer: { lastRun: Record<string, unknown> } }
    detail.timer.lastRun = { ...detail.timer.lastRun, activeState: 'failed', result: 'exit-code', exitStatus: 1 }
    const view = card(check)
    expect(view.reason).toBe('Last run 3h ago failed: exit-code, exit status 1')
    expect(pairs(view.rows)).toContainEqual(['Result', 'exit-code (exit status 1)'])
  })

  it('says a timer that has never fired has never run', () => {
    const check = fixture('systemd:budget-api-cron.timer')
    check.status = 'degraded'
    const detail = check.detail as { timer: Record<string, unknown> & { lastRun: Record<string, unknown> } }
    detail.timer.lastTrigger = null
    detail.timer.lastRun = { ...detail.timer.lastRun, startedAt: null, exitedAt: null }
    expect(card(check).reason).toBe('Never triggered')
  })

  it('says an active timer with nothing scheduled will not run again', () => {
    const check = fixture('systemd:budget-api-cron.timer')
    check.status = 'degraded'
    check.detail = { ...check.detail, subState: 'elapsed' }
    const detail = check.detail as { timer: Record<string, unknown> }
    detail.timer.nextTrigger = null
    detail.timer.unscheduled = true
    const view = card(check)
    expect(view.reason).toBe('No next run scheduled (timer elapsed) · last ran 3h ago')
    expect(pairs(view.rows)).toContainEqual(['Next run', 'none scheduled'])
  })

  it('leads with the failure when a failed timer is also unscheduled', () => {
    const check = fixture('systemd:budget-api-cron.timer')
    check.status = 'down'
    const detail = check.detail as { timer: Record<string, unknown> & { lastRun: Record<string, unknown> } }
    detail.timer.unscheduled = true
    detail.timer.lastRun = { ...detail.timer.lastRun, activeState: 'failed', result: 'exit-code', exitStatus: 1 }
    expect(card(check).reason).toBe('Last run 3h ago failed: exit-code, exit status 1')
  })

  it('says a stopped timer is stopped', () => {
    const check = fixture('systemd:budget-api-cron.timer')
    check.status = 'down'
    check.detail = { ...check.detail, activeState: 'inactive', subState: 'dead' }
    expect(card(check).reason).toBe('Timer inactive (dead)')
  })

  it('says a run is in progress', () => {
    const check = fixture('systemd:session-tasks.timer')
    const detail = check.detail as { timer: { lastRun: Record<string, unknown> } }
    detail.timer.lastRun = { ...detail.timer.lastRun, activeState: 'activating', exitedAt: null }
    expect(card(check).summary).toMatch(/^running now/)
  })

  it('formats the WSL2 memory-reconcile timer the same way', () => {
    const view = card(fixture('lnv-lgn5:systemd:memory-reconcile.timer'))
    expect(view.title).toBe('memory-reconcile.timer')
    expect(view.summary).toBe('last ran 15m ago · success')
  })
})

describe('GitHub runners', () => {
  it('shows a busy runner as busy, with its repo', () => {
    const view = card(fixture('github-runner:argus/homelab'))
    expect(view.title).toBe('homelab')
    expect(view.summary).toBe('busy · argus')
    expect(pairs(view.rows)).toEqual([
      ['State', 'online, busy'],
      ['Repo', 'argus'],
      ['Labels', 'homelab'],
      ['Version', '2.337.0'],
    ])
  })

  it('shows an idle runner as idle', () => {
    expect(card(fixture('github-runner:budget/homelab-budget')).summary).toBe('idle · budget')
  })

  it('says an offline runner is offline', () => {
    const check = fixture('github-runner:budget/homelab-budget')
    check.status = 'down'
    check.detail = { ...check.detail, online: false, busy: false }
    expect(card(check).reason).toBe('Offline on GitHub')
  })

  it('uses the poller error for a runner GitHub no longer lists', () => {
    const view = card({ ...fixture('github-runner:argus/homelab-2'), status: 'down', detail: { error: 'runner homelab-2 is not registered on deanjstone/argus' } })
    expect(view.title).toBe('github-runner:argus/homelab-2')
    expect(view.reason).toBe('runner homelab-2 is not registered on deanjstone/argus')
  })
})

describe('LNV-LGN5 C:', () => {
  it('shows free space against the size', () => {
    const view = card(fixture('lnv-lgn5:disk:C:'))
    expect(view.title).toBe('C:')
    expect(view.summary).toBe('55 GB free of 476 GB')
    expect(pairs(view.rows)).toEqual([
      ['Free', '55 GB'],
      ['Used', '88%'],
      ['Size', '476 GB'],
    ])
  })

  it('leads a short disk with what is left', () => {
    const check = fixture('lnv-lgn5:disk:C:')
    check.status = 'down'
    check.detail = { path: 'C:', totalBytes: 500 * 1024 ** 3, freeBytes: 8 * 1024 ** 3, pctUsed: 98 }
    expect(card(check).reason).toBe('Only 8 GB free on C: (98% used)')
  })
})

describe('LNV-LGN5 crash dumps', () => {
  it('leads the real day with the two fresh WSL dumps', () => {
    const view = card(fixture('lnv-lgn5:crash-dumps'))
    expect(view.title).toBe('Crash dumps')
    expect(view.reason).toBe('2 WSL crash dumps (4.4 GB), newest 3h ago')
    expect(view.sections.map((section) => [section.title, pairs(section.rows)])).toEqual([
      ['WSL', [['Dumps', '2 · 4.4 GB'], ['Newest', '3h ago']]],
      ['Windows apps', [['Dumps', '6 · 104 MB'], ['Newest', '187d ago']]],
    ])
  })

  it('says there are none when the WSL folder is empty', () => {
    const check = fixture('lnv-lgn5:crash-dumps')
    check.status = 'healthy'
    check.detail = { ...check.detail, wsl: { path: 'x', count: 0, totalBytes: 0, newestAt: null } }
    const view = card(check)
    expect(view.summary).toBe('no WSL crash dumps')
    expect(view.sections[0]?.empty).toBe('None')
  })
})

describe('LNV-LGN5 memory', () => {
  it('shows available memory, swap and pressure', () => {
    const view = card(fixture('lnv-lgn5:memory'))
    expect(view.title).toBe('WSL2 memory')
    expect(view.summary).toBe('3 GB of 5.8 GB available')
    expect(pairs(view.rows)).toEqual([
      ['Available', '3 GB of 5.8 GB'],
      ['Swap used', '1.5 GB of 2 GB'],
      ['Pressure (1 min)', '0% some · 0% full'],
    ])
  })

  it('leads stalled memory with the pressure', () => {
    const check = fixture('lnv-lgn5:memory')
    check.status = 'degraded'
    check.detail = { ...check.detail, pressure: { some: { avg10: 20, avg60: 12.4, avg300: 4 }, full: { avg10: 2, avg60: 1, avg300: 0.5 } } }
    expect(card(check).reason).toBe('Tasks stalled on memory 12% of the last minute')
  })

  it('leads low memory with what is left', () => {
    const check = fixture('lnv-lgn5:memory')
    check.status = 'degraded'
    check.detail = { ...check.detail, availableBytes: 0.3 * 1024 ** 3 }
    expect(card(check).reason).toBe('Only 307 MB of 5.8 GB available')
  })
})

describe('the newly covered Workers', () => {
  it('render through the Cloudflare formatter', () => {
    const view = card(fixture('cloudflare:argus-email'))
    expect(view.title).toBe('argus-email')
    expect(view.summary).toBe('production · deployed 4d ago')
  })
})
