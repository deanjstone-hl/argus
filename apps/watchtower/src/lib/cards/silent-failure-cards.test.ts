import { readFileSync } from 'node:fs'
import type { ServiceCheck } from '@argus/watchtower-contract'
import { describe, expect, it } from 'vitest'
import { CARD_FORMATTERS, formatCard } from './registry.js'
import type { CardView, DetailRow } from './types.js'

// The silent-failure cards, produced by running the collector's own checks
// on data captured on 2026-10-16 around 13:27 UTC: every --user timer on
// homelab (its syncthing-drift-poller.timer really was stuck) and on WSL2,
// WSL2's real memory-reconcile heartbeat with its one refusal,
// vault-staleness.sh's real output for a clone with commits unpublished
// since 05:00, and the notice board's real repo list with two argus
// messages added unacked and one dead, since none were waiting that day.
const FIXTURES = JSON.parse(
  readFileSync(new URL('./__fixtures__/silent-failure-cards.json', import.meta.url), 'utf8'),
) as ServiceCheck[]

const NOW = Date.parse('2026-10-16T13:30:30Z')

function fixture(serviceKey: string): ServiceCheck {
  const check = FIXTURES.find((candidate) => candidate.service_key === serviceKey)
  if (!check) throw new Error(`no fixture for ${serviceKey}`)
  return structuredClone(check)
}

const card = (check: ServiceCheck): CardView => formatCard(check, NOW)
const pairs = (rows: DetailRow[]) => rows.map((row) => [row.label, row.value])
const section = (view: CardView, title: string) => view.sections.find((candidate) => candidate.title === title)

function allText(view: CardView): string {
  const lines = [view.title, view.summary, view.reason, ...[...view.rows, ...view.sections.flatMap((entry) => [{ label: entry.title, value: entry.empty ?? '' }, ...entry.rows])].flatMap((row) => [row.label, row.value])]
  return lines.filter(Boolean).join('\n')
}

describe('every silent-failure card', () => {
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

describe('timer freshness', () => {
  it('names homelab’s stuck timer and when it last fired', () => {
    const view = card(fixture('homelab:timers'))
    expect(view.title).toBe('Timers')
    expect(view.reason).toBe('syncthing-drift-poller has nothing scheduled: it last fired 8d ago and will not fire again')
    expect(pairs(section(view, 'Needs attention')?.rows ?? [])).toEqual([['syncthing-drift-poller', 'nothing scheduled']])
  })

  it('lists the timers that are fine with their last and next run', () => {
    const onTime = section(card(fixture('homelab:timers')), 'On time')?.rows ?? []
    expect(onTime).toHaveLength(16)
    expect(pairs(onTime)).toContainEqual(['budget-api-cron', 'ran 5h ago · next in 19h 29m'])
    // Weekly, enabled two hours before: run by hand, not yet by its timer.
    expect(pairs(onTime)).toContainEqual(['secret-scan', 'ran 2h ago · next in 1d 4h'])
    expect(pairs(onTime)).toContainEqual(['systemd-tmpfiles-clean', 'disabled (package default)'])
    expect(pairs(onTime)).toContainEqual(['github-collector', 'ran 15m ago · due now'])
  })

  it('sums up a healthy host', () => {
    const view = card(fixture('lnv-lgn5:timers'))
    expect(view.summary).toBe('all 6 timers on time')
    expect(section(view, 'Needs attention')).toBeUndefined()
  })

  it('says why each kind of problem will stop a timer', () => {
    const check = fixture('lnv-lgn5:timers')
    const timers = (check.detail as { timers: Array<Record<string, unknown>> }).timers
    const set = (name: string, change: Record<string, unknown>) => Object.assign(timers.find((timer) => timer.timer === name)!, change)
    set('memory-reconcile.timer', { problem: 'disabled', unitFileState: 'disabled' })
    set('vault-sync.timer', { problem: 'failed', lastRun: { activeState: 'failed', result: 'exit-code', exitStatus: 1, startedAt: '2026-10-16T13:15:06.000Z', exitedAt: '2026-10-16T13:15:09.000Z' } })
    set('t3-auto-update.timer', { problem: 'overdue', nextTrigger: '2026-10-16T13:15:00.000Z' })
    check.status = 'degraded'
    const view = card(check)
    expect(view.summary).toBe('3 of 6 timers will not run on time')
    expect(view.reason).toBe('memory-reconcile is disabled; t3-auto-update is overdue: due 16m ago; vault-sync last run failed: exit-code (exit status 1)')
  })
})

describe('memory-reconcile', () => {
  it('leads with the refusal waiting for the owner', () => {
    const view = card(fixture('lnv-lgn5:memory-reconcile'))
    expect(view.title).toBe('memory-reconcile')
    expect(view.reason).toBe('1 refusal to settle (hash-mismatch); each one’s detail is in ~/.argus/memory-reconcile-heartbeat.json')
    expect(view.summary).toBe('last ran 3m ago · 1 refusal')
    expect(pairs(view.rows)).toEqual([
      ['Last run', '3m ago'],
      ['Result', 'ok'],
      ['Written', '0'],
      ['Deleted', '0'],
    ])
    expect(pairs(section(view, 'Refusals')?.rows ?? [])).toEqual([['project-linux-server', 'hash-mismatch · first seen 18d ago']])
  })

  it('says a stopped reconciler stopped, and a failed one why', () => {
    const stale = fixture('lnv-lgn5:memory-reconcile')
    Object.assign(stale.detail as object, { lastRunAt: '2026-10-16T10:00:00.000Z', refusals: [] })
    expect(card(stale).reason).toBe('Last ran 4h ago; it should run every 20m')
    const failed = fixture('lnv-lgn5:memory-reconcile')
    Object.assign(failed.detail as object, { ok: false, lastError: 'vault lock held', refusals: [] })
    failed.status = 'down'
    expect(card(failed).reason).toBe('Last run failed: vault lock held')
  })
})

describe('vault sync', () => {
  it('shows the session-start hook’s own words when publishing has stopped', () => {
    const view = card(fixture('lnv-lgn5:vault:CONTEXT'))
    expect(view.title).toBe('CONTEXT sync')
    expect(view.reason).toBe("CONTEXT has 3 unpublished commit(s), oldest 8h — publishing has stopped. Check the vault sync timer's journal.")
  })

  it('reads as in step when the hook is silent', () => {
    const view = card(fixture('homelab:vault:CONTEXT'))
    expect(view.summary).toBe('published and fetching')
    expect(pairs(view.rows)).toEqual([['Path', '~/CONTEXT']])
  })

  it('says when the vault is not a checkout', () => {
    const check = fixture('lnv-lgn5:vault:CORTEX')
    Object.assign(check.detail as object, { checkout: false })
    check.status = 'degraded'
    expect(card(check).reason).toBe('~/CORTEX is not a git checkout')
  })
})

describe('notice board', () => {
  it('leads with the oldest unacked message and the recent dead one', () => {
    const view = card(fixture('notice-board:queue'))
    expect(view.title).toBe('Notice board')
    expect(view.reason).toBe('A message has waited unacked for 1d; 1 message went dead this week, never acked after 5 deliveries')
    expect(view.summary).toBe('2 unacked · oldest 1d ago')
    expect(pairs(view.rows)).toEqual([
      ['Unacked', '2'],
      ['Oldest', '1d ago'],
      ['Dead', '1 (1 this week)'],
    ])
    expect(pairs(section(view, 'Repos')?.rows ?? [])).toEqual([['argus', '1 queued · 1 claimed · 1 dead · oldest 1d ago']])
  })

  it('reads an empty queue plainly', () => {
    const check = fixture('notice-board:queue')
    Object.assign(check.detail as object, { unacked: 0, oldestUnackedAt: null, dead: 0, recentDead: 0, repos: [] })
    check.status = 'healthy'
    const view = card(check)
    expect(view.summary).toBe('nothing waiting')
    expect(section(view, 'Repos')).toBeUndefined()
  })
})
