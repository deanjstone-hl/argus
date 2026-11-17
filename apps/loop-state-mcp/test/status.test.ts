import { describe, expect, it } from 'vitest'

import { AFK_THREAD, MINUTE, text, world } from './helpers.js'

/** The weekly fields (argus#861) of a tick that sent none. */
const noWeekly = {
  weekly_used_percent: null,
  weekly_resets_at: null,
  weekly_pace: null,
  burn_per_day: null,
  allowance_per_day: null,
  budget_ratio: null,
  budget_rung: null,
  budget_rung_held: false,
  reserve_percent: null,
  budget_exempt_repos: [],
}

const base = { thread_id: AFK_THREAD, directives_version: 'a1b2c3', needs_owner: [] as string[] }

describe('loop status', () => {
  it('reports a loop that has never ticked', async () => {
    const { as } = world()
    const status = await (await as('direction')).ok('status_read')
    expect(status).toMatchObject({ role: 'afk', last_tick_at: null, liveness: { state: 'never', missed_ticks: null } })
  })

  it('reads back what the last tick wrote: directives version, slots used and free, errors, pressure', async () => {
    const { as, clock } = world()
    const afk = await as('afk')
    await afk.ok('slot_start', { issue: 'deanjstone/argus#1', thread_id: 'w1' })
    await afk.ok('slot_start', { issue: 'deanjstone/argus#2', thread_id: 'w2' })
    await afk.ok('slot_start', { issue: 'deanjstone/argus#3', thread_id: 'w3' })
    await afk.ok('slot_park', { issue: 'deanjstone/argus#3' })

    await afk.ok('status_tick', {
      ...base,
      slot_cap: 3,
      errors: ['gh search timed out once'],
      window_used_percent: 72,
    })

    const status = await (await as('direction')).ok('status_read')
    expect(status).toMatchObject({
      role: 'afk',
      thread_id: AFK_THREAD,
      last_tick_at: clock.iso(),
      directives_version: 'a1b2c3',
      errors: ['gh search timed out once'],
      pressure: { level: 'no_opus', window_used_percent: 72 },
      slots: { cap: 3, used: 2, free: 1, parked: 1, ready: 0 },
      liveness: { state: 'alive', missed_ticks: 0 },
    })
  })

  it('counts a parked or ready slot as free capacity, and a running one as used', async () => {
    const { as } = world()
    const afk = await as('afk')
    const aquila = await as('direction')
    await afk.ok('slot_start', { issue: 'deanjstone/argus#1', thread_id: 'w1' })
    await afk.ok('slot_park', { issue: 'deanjstone/argus#1' })
    await aquila.ok('slot_unpark', { issue: 'deanjstone/argus#1' })
    await afk.ok('status_tick', { ...base, slot_cap: 3 })

    expect((await afk.ok('status_read')).slots).toEqual({
      cap: 3,
      used: 0,
      free: 3,
      parked: 0,
      ready: 1,
      awaiting_ci: 0,
      awaiting_ci_cap: 3,
      pending_approvals: {},
      budget_exempt_running: 0,
      hosts: { wsl2: { used: 0, cap: null }, homelab: { used: 0, cap: null } },
    })
  })

  it.each([
    [0, 'normal'],
    [69.9, 'normal'],
    [70, 'no_opus'],
    [85, 'no_new_slots'],
    [95, 'gate_only'],
    [100, 'gate_only'],
  ])('derives the window ladder level from %s%% used', async (percent, level) => {
    const { as } = world()
    const afk = await as('afk')
    await afk.ok('status_tick', { ...base, window_used_percent: percent })
    expect((await afk.ok('status_read')).pressure).toEqual({ ...noWeekly, level, window_used_percent: percent, effective_slot_cap: null })
  })

  it('takes a level directly when no percentage is available, and refuses one that contradicts the percentage', async () => {
    const { as } = world()
    const afk = await as('afk')
    await afk.ok('status_tick', { ...base, pressure: 'no_new_slots' })
    expect((await afk.ok('status_read')).pressure).toEqual({ ...noWeekly, level: 'no_new_slots', window_used_percent: null, effective_slot_cap: null })

    await afk.ok('status_tick', base)
    expect((await afk.ok('status_read')).pressure).toEqual({ ...noWeekly, level: 'unknown', window_used_percent: null, effective_slot_cap: null })

    const contradiction = await afk.call('status_tick', { ...base, pressure: 'normal', window_used_percent: 90 })
    expect(contradiction.isError).toBe(true)
    expect(text(contradiction)).toMatch(/no_new_slots/)
  })

  it('judges liveness from the last tick against the 30-minute cadence', async () => {
    const { as, clock } = world()
    const afk = await as('afk')
    const aquila = await as('direction')
    await afk.ok('status_tick', base)
    const tickedAt = clock.iso()

    clock.advance(30 * MINUTE)
    expect((await aquila.ok('status_read')).liveness).toEqual({
      state: 'alive',
      missed_ticks: 0,
      cadence_minutes: 30,
      next_due_at: tickedAt.replace('00:00:00', '00:30:00'),
    })

    clock.advance(6 * MINUTE)
    expect((await aquila.ok('status_read')).liveness).toMatchObject({ state: 'late', missed_ticks: 1 })

    clock.advance(30 * MINUTE)
    expect((await aquila.ok('status_read')).liveness).toMatchObject({ state: 'stalled', missed_ticks: 2 })

    await afk.ok('status_tick', base)
    expect((await aquila.ok('status_read')).liveness).toMatchObject({ state: 'alive', missed_ticks: 0 })
  })

  it('takes the cadence and grace from the server options', async () => {
    const { as, clock } = world({ cadenceMs: 10 * MINUTE, graceMs: 0 })
    const afk = await as('afk')
    await afk.ok('status_tick', base)
    clock.advance(21 * MINUTE)
    expect((await afk.ok('status_read')).liveness).toMatchObject({ state: 'stalled', missed_ticks: 2, cadence_minutes: 10 })
  })
})
