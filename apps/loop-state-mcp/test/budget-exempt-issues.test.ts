import { describe, expect, it } from 'vitest'

import { AQUILA_THREAD, text, world } from './helpers.js'
import { ladderWorld } from './ladder-world.js'

/**
 * argus#60: the directives key `budget_exempt_issues` names owner-chosen issues whose slot start passes
 * no_new_slots and gate_only, sits outside the caps, and runs one at a time. The server reads the list from
 * the current directives, so no client flag is needed. Burn 13 puts the ladder at no_new_slots, 16 at gate_only.
 */
const MINIMAL = { cadence_minutes: 30, max_slots: 2, repo_holds: [], take_next: [], ordering: [] }
const issue = (n: number) => `deanjstone/argus#${n}`
const LISTED = issue(10)
const OTHER_LISTED = issue(11)
const VERIFIED = 'Verified: verify-claim merged #1 ok; CI run 123 green'

type Direction = Awaited<ReturnType<ReturnType<typeof world>['as']>>

const setDirectives = (aquila: Direction, extra: Record<string, unknown>, expected_version = 0) =>
  aquila.call('directives_set', { record: { ...MINIMAL, ...extra }, reason: 'test', expected_version, caller_thread_id: AQUILA_THREAD })

async function listed(w: Awaited<ReturnType<typeof ladderWorld>>, issues: unknown = [LISTED, OTHER_LISTED]) {
  const aquila = await w.as('direction')
  await aquila.ok('owner_turn', { caller_thread_id: AQUILA_THREAD })
  const result = await setDirectives(aquila, { budget_exempt_issues: issues })
  expect(result.isError).toBeFalsy()
  return aquila
}

describe('budget_exempt_issues in the validator', () => {
  it.each([
    ['not a list', 'deanjstone/atto#10', /budget_exempt_issues must be a list/],
    ['a repo with no number', ['deanjstone/atto'], /budget_exempt_issues\[0\]: must be owner\/repo#N/],
    ['number zero', ['deanjstone/atto#0'], /budget_exempt_issues\[0\]: must be owner\/repo#N/],
    ['a non-string', [10], /budget_exempt_issues\[0\]: must be owner\/repo#N/],
  ])('refuses %s', async (_name, value, problem) => {
    const aquila = await world().as('direction')
    await aquila.ok('owner_turn', { caller_thread_id: AQUILA_THREAD })
    const result = await setDirectives(aquila, { budget_exempt_issues: value })
    expect(result.isError).toBe(true)
    expect(text(result)).toMatch(problem)
  })

  it('accepts a list of owner/repo#N, and an empty one', async () => {
    const aquila = await world().as('direction')
    await aquila.ok('owner_turn', { caller_thread_id: AQUILA_THREAD })
    expect((await setDirectives(aquila, { budget_exempt_issues: ['deanjstone/atto#10'] })).isError).toBeFalsy()
    expect((await setDirectives(aquila, { budget_exempt_issues: [] }, 1)).isError).toBeFalsy()
  })
})

describe('slot_start for a budget_exempt_issues issue', () => {
  it('starts at gate_only, with no client flag', async () => {
    const w = await ladderWorld()
    await listed(w)
    await w.afk.ok('status_tick', w.tick(16, { total_cap: 3 }))
    const started = await w.afk.ok('slot_start', { issue: LISTED, thread_id: 'w1' })
    expect(started.slot).toMatchObject({ issue: LISTED, state: 'running' })
  })

  it('also starts at no_new_slots', async () => {
    const w = await ladderWorld()
    await listed(w)
    await w.afk.ok('status_tick', w.tick(13, { total_cap: 3 }))
    expect((await w.afk.call('slot_start', { issue: LISTED, thread_id: 'w1' })).isError).toBeFalsy()
  })

  it('refuses an unlisted issue at gate_only and no_new_slots', async () => {
    const w = await ladderWorld()
    await listed(w)
    await w.afk.ok('status_tick', w.tick(16, { total_cap: 3 }))
    expect(text(await w.afk.call('slot_start', { issue: issue(1), thread_id: 'w1' }))).toMatch(/pressure is gate_only/)
    await w.afk.ok('status_tick', w.tick(13, { total_cap: 3 }))
    expect(text(await w.afk.call('slot_start', { issue: issue(1), thread_id: 'w1' }))).toMatch(/pressure is no_new_slots/)
    expect((await w.afk.ok('slot_list')).slots).toHaveLength(0)
  })

  it('refuses a second listed issue while one runs, and allows it once the first closes', async () => {
    const w = await ladderWorld()
    await listed(w)
    await w.afk.ok('status_tick', w.tick(16, { total_cap: 3 }))
    await w.afk.ok('slot_start', { issue: LISTED, thread_id: 'w1' })
    const refused = await w.afk.call('slot_start', { issue: OTHER_LISTED, thread_id: 'w2' })
    expect(refused.isError).toBe(true)
    expect(text(refused)).toMatch(/deanjstone\/argus#10 already runs a budget-exempt issue: only one runs at a time/)
    await w.afk.ok('slot_close', { issue: LISTED, verified: VERIFIED })
    expect((await w.afk.call('slot_start', { issue: OTHER_LISTED, thread_id: 'w2' })).isError).toBeFalsy()
  })

  it('sits outside the caps: starts when the cap is full, and does not fill it', async () => {
    const w = await ladderWorld()
    await listed(w)
    await w.afk.ok('status_tick', w.tick(0, { total_cap: 1, host_caps: { wsl2: 1, homelab: 1 } }))
    await w.afk.ok('slot_start', { issue: issue(1), thread_id: 'w1' })
    expect((await w.afk.call('slot_start', { issue: LISTED, thread_id: 'w2' })).isError).toBeFalsy()
    await w.afk.ok('slot_close', { issue: issue(1), verified: VERIFIED })
    expect((await w.afk.call('slot_start', { issue: issue(2), thread_id: 'w3' })).isError).toBeFalsy()
    const refused = await w.afk.call('slot_start', { issue: issue(3), thread_id: 'w4' })
    expect(text(refused)).toMatch(/effective slot cap 1 is reached \(1 running\)/)
  })

  it('is not held to the ladder\'s cut of the total cap to 1', async () => {
    const w = await ladderWorld()
    await listed(w)
    await w.afk.ok('status_tick', w.tick(10.5, { total_cap: 1 }))
    await w.afk.ok('slot_start', { issue: issue(1), thread_id: 'w1' })
    expect((await w.afk.call('slot_start', { issue: LISTED, thread_id: 'w2' })).isError).toBeFalsy()
  })

  it('leaves the efficiency:orchestrator exempt slot its own one-at-a-time', async () => {
    const w = await ladderWorld()
    await listed(w)
    await w.afk.ok('status_tick', w.tick(13, { total_cap: 3 }))
    await w.afk.ok('slot_start', { issue: LISTED, thread_id: 'w1' })
    expect((await w.afk.call('slot_start', { issue: issue(2), thread_id: 'w2', budget_exempt: true })).isError).toBeFalsy()
  })

  it('stops passing once a later directives version drops the issue', async () => {
    const w = await ladderWorld()
    const aquila = await listed(w)
    await setDirectives(aquila, { budget_exempt_issues: [] }, 1)
    await w.afk.ok('status_tick', w.tick(16, { total_cap: 3 }))
    expect(text(await w.afk.call('slot_start', { issue: LISTED, thread_id: 'w1' }))).toMatch(/pressure is gate_only/)
  })
})

describe('status_read and budget_exempt_issues', () => {
  it('reports the listed issues, and none before any are set', async () => {
    const w = await ladderWorld()
    await w.afk.ok('status_tick', w.tick(0, { total_cap: 3 }))
    expect((await w.afk.ok('status_read')).pressure.budget_exempt_issues).toEqual([])
    await listed(w, [OTHER_LISTED, LISTED])
    expect((await w.afk.ok('status_read')).pressure.budget_exempt_issues).toEqual([LISTED, OTHER_LISTED])
  })
})
