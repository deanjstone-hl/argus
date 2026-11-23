import { describe, expect, it } from 'vitest'

import { AQUILA_THREAD, MINUTE, text, world } from './helpers.js'
import { HOUR, ladderWorld } from './ladder-world.js'

// argus#73: a time-boxed `lift_budget_rung` directives override. While it is live and the week's use is
// under its ceiling, a budget rung of no_new_slots or no_opus no longer stops starts: the effective slot cap
// is the override's, and only the override's worker models may start. gate_only is never lifted.

const MINIMAL = { cadence_minutes: 30, max_slots: 4, repo_holds: [], take_next: [], ordering: [] }
const UNTIL = '2030-01-01T00:00:00+11:00'
const lift = (value: unknown, until = UNTIL) => ({ key: 'lift_budget_rung', value, until, reason: 'Owner: afternoon sprint' })
const SPRINT = { slots: 2, models: ['sonnet', 'haiku'], weekly_ceiling_percent: 70 }

type Direction = Awaited<ReturnType<ReturnType<typeof world>['as']>>

const setDirectives = (aquila: Direction, overrides: unknown[], record: Record<string, unknown> = MINIMAL, expected_version = 0) =>
  aquila.call('directives_set', { record: { ...record, overrides }, reason: 'test', expected_version, caller_thread_id: AQUILA_THREAD })

async function ownerPresent(w: ReturnType<typeof world>) {
  const aquila = await w.as('direction')
  await aquila.ok('owner_turn', { caller_thread_id: AQUILA_THREAD })
  return aquila
}

const A = 'deanjstone/argus#1'
const B = 'deanjstone/argus#2'
const C = 'deanjstone/argus#3'

/** A week at pace 1.3 (65% used, ceiling 70 not reached): the budget rung is no_new_slots. */
const NO_NEW_SLOTS = 1.3

describe('the lift_budget_rung override in the validator', () => {
  it('accepts slots, models and a weekly ceiling, time-boxed like the other overrides', async () => {
    const aquila = await ownerPresent(world())
    const result = await setDirectives(aquila, [lift(SPRINT)])
    expect(result.isError).toBeFalsy()
  })

  it('defaults the models, so a value of slots and a ceiling is valid', async () => {
    const aquila = await ownerPresent(world())
    const result = await setDirectives(aquila, [lift({ slots: 2, weekly_ceiling_percent: 85 })])
    expect(result.isError).toBeFalsy()
  })

  it.each([
    [{ models: ['sonnet'], weekly_ceiling_percent: 85 }, /lift_budget_rung needs slots/],
    [{ slots: 2, models: ['sonnet'] }, /lift_budget_rung needs weekly_ceiling_percent/],
    [{ slots: 0, weekly_ceiling_percent: 85 }, /slots must be a positive integer/],
    [{ slots: 5, weekly_ceiling_percent: 85 }, /slots must be at most max_slots/],
    [{ slots: 2, weekly_ceiling_percent: 101 }, /weekly_ceiling_percent must be above 0 and at most 100/],
    [{ slots: 2, weekly_ceiling_percent: 0 }, /weekly_ceiling_percent must be above 0 and at most 100/],
    [{ slots: 2, weekly_ceiling_percent: 85, models: ['opus'] }, /models must be a non-empty list of sonnet and\/or haiku/],
    [{ slots: 2, weekly_ceiling_percent: 85, models: [] }, /models must be a non-empty list of sonnet and\/or haiku/],
    [{ slots: 2, weekly_ceiling_percent: 85, extra: 1 }, /unknown field: extra/],
    ['2', /lift_budget_rung must be a mapping/],
  ])('refuses the value %j', async (value, problem) => {
    const aquila = await ownerPresent(world())
    const result = await setDirectives(aquila, [lift(value)])
    expect(result.isError).toBe(true)
    expect(text(result)).toMatch(problem)
  })

  it('refuses an until with no offset', async () => {
    const aquila = await ownerPresent(world())
    const result = await setDirectives(aquila, [lift(SPRINT, '2030-01-01T00:00:00')])
    expect(result.isError).toBe(true)
    expect(text(result)).toMatch(/overrides\[0\]: until/)
  })

  it('lists the key among the ones an override may name', async () => {
    const aquila = await ownerPresent(world())
    const result = await setDirectives(aquila, [{ ...lift(SPRINT), key: 'bogus' }])
    expect(text(result)).toMatch(/key must be one of .*lift_budget_rung/)
  })
})

describe('starts under no_new_slots while the override is live', () => {
  it('allows starts up to the override cap, then refuses on that cap', async () => {
    const w = await ladderWorld()
    await w.afk.ok('status_tick', w.tick(NO_NEW_SLOTS, { slot_cap: 4 }))
    expect((await w.afk.call('slot_start', { issue: A, thread_id: 'w1' })).isError).toBe(true)

    const aquila = await ownerPresent(w)
    await setDirectives(aquila, [lift(SPRINT)]).then((r) => expect(r.isError).toBeFalsy())

    expect((await w.afk.call('slot_start', { issue: A, thread_id: 'w1' })).isError).toBeFalsy()
    expect((await w.afk.call('slot_start', { issue: B, thread_id: 'w2' })).isError).toBeFalsy()
    const third = await w.afk.call('slot_start', { issue: C, thread_id: 'w3' })
    expect(third.isError).toBe(true)
    expect(text(third)).toMatch(/effective slot cap 2 is reached/)
  })

  it('is bounded by the directives total cap', async () => {
    const w = await ladderWorld()
    await w.afk.ok('status_tick', w.tick(NO_NEW_SLOTS, { slot_cap: 1 }))
    const aquila = await ownerPresent(w)
    await setDirectives(aquila, [lift(SPRINT)])
    expect((await w.afk.call('slot_start', { issue: A, thread_id: 'w1' })).isError).toBeFalsy()
    expect((await w.afk.call('slot_start', { issue: B, thread_id: 'w2' })).isError).toBe(true)
  })

  it('shows the override in status_read: the cap, the deadline, the models and that it is lifting', async () => {
    const w = await ladderWorld()
    await w.afk.ok('status_tick', w.tick(NO_NEW_SLOTS, { slot_cap: 4 }))
    const aquila = await ownerPresent(w)
    await setDirectives(aquila, [lift(SPRINT, '2030-01-01T00:00:00+11:00')])

    expect((await w.afk.ok('status_read')).pressure).toMatchObject({
      level: 'no_opus',
      budget_rung: 'no_new_slots',
      effective_slot_cap: 2,
      budget_override_until: '2029-12-31T13:00:00.000Z',
      budget_override_slots: 2,
      budget_override_models: ['sonnet', 'haiku'],
      budget_override_ceiling_percent: 70,
      budget_override_active: true,
    })
  })

  it('shows no override when none is set', async () => {
    const w = await ladderWorld()
    await w.afk.ok('status_tick', w.tick(NO_NEW_SLOTS, { slot_cap: 4 }))
    expect((await w.afk.ok('status_read')).pressure).toMatchObject({
      level: 'no_new_slots',
      effective_slot_cap: 0,
      budget_override_until: null,
      budget_override_active: false,
    })
  })

  it('lets tick_gate see the lifted level and cap with no new tick: an at-rung tick no longer flips pressure on', async () => {
    const w = await ladderWorld()
    const aquila = await ownerPresent(w)
    await setDirectives(aquila, [lift(SPRINT)])
    await w.afk.ok('status_tick', w.tick(NO_NEW_SLOTS, { slot_cap: 4 }))
    const gate = await w.afk.ok('tick_gate', w.tick(NO_NEW_SLOTS, { slot_cap: 4 }))
    expect(gate.changed).toBe(false)
    expect((await w.afk.ok('status_read')).pressure).toMatchObject({ level: 'no_opus', effective_slot_cap: 2 })
  })

  it('also sets the cap at no_opus, bounded by the directives total cap', async () => {
    const w = await ladderWorld()
    const aquila = await ownerPresent(w)
    await setDirectives(aquila, [lift({ ...SPRINT, slots: 1 })])
    await w.afk.ok('status_tick', w.tick(1.15, { slot_cap: 4 }))
    expect((await w.afk.ok('status_read')).pressure).toMatchObject({ budget_rung: 'no_opus', effective_slot_cap: 1 })
    expect((await w.afk.call('slot_start', { issue: A, thread_id: 'w1' })).isError).toBeFalsy()
    expect((await w.afk.call('slot_start', { issue: B, thread_id: 'w2' })).isError).toBe(true)
  })

  it('leaves the total cap alone at a normal rung, where there is nothing to lift', async () => {
    const w = await ladderWorld()
    const aquila = await ownerPresent(w)
    await setDirectives(aquila, [lift({ ...SPRINT, slots: 1 })])
    await w.afk.ok('status_tick', w.tick(0.5, { slot_cap: 4 }))
    expect((await w.afk.ok('status_read')).pressure).toMatchObject({ budget_rung: 'normal', effective_slot_cap: 4, budget_override_active: false })
  })
})

describe('the worker model limit', () => {
  it('refuses a start that names a model outside the override while it lifts the rung', async () => {
    const w = await ladderWorld()
    await w.afk.ok('status_tick', w.tick(NO_NEW_SLOTS, { slot_cap: 4 }))
    const aquila = await ownerPresent(w)
    await setDirectives(aquila, [lift(SPRINT)])

    const opus = await w.afk.call('slot_start', { issue: A, thread_id: 'w1', model: 'claude-opus-5-5' })
    expect(opus.isError).toBe(true)
    expect(text(opus)).toMatch(/budget override allows only sonnet, haiku/)
    expect((await w.afk.call('slot_start', { issue: A, thread_id: 'w1', model: 'claude-sonnet-5-5' })).isError).toBeFalsy()
    expect((await w.afk.call('slot_start', { issue: B, thread_id: 'w2', model: 'Haiku' })).isError).toBeFalsy()
  })

  it('does not restrict the model when the override is not what lets the start through', async () => {
    const w = await ladderWorld()
    await w.afk.ok('status_tick', w.tick(0.5, { slot_cap: 4 }))
    const aquila = await ownerPresent(w)
    await setDirectives(aquila, [lift(SPRINT)])
    expect((await w.afk.call('slot_start', { issue: A, thread_id: 'w1', model: 'claude-opus-5-5' })).isError).toBeFalsy()
  })
})

describe('where the override stops', () => {
  it('refuses starts again after its until, with no new tick', async () => {
    const w = await ladderWorld()
    await w.afk.ok('status_tick', w.tick(NO_NEW_SLOTS, { slot_cap: 4 }))
    const aquila = await ownerPresent(w)
    await setDirectives(aquila, [lift(SPRINT, new Date(w.clock.now() + 30 * MINUTE).toISOString())])
    expect((await w.afk.call('slot_start', { issue: A, thread_id: 'w1' })).isError).toBeFalsy()

    w.clock.advance(31 * MINUTE)
    const refused = await w.afk.call('slot_start', { issue: B, thread_id: 'w2' })
    expect(refused.isError).toBe(true)
    expect(text(refused)).toMatch(/pressure is no_new_slots/)
    expect((await w.afk.ok('status_read')).pressure).toMatchObject({ level: 'no_new_slots', effective_slot_cap: 0, budget_override_active: false })
  })

  it('an entry already past its until is ignored', async () => {
    const w = await ladderWorld()
    await w.afk.ok('status_tick', w.tick(NO_NEW_SLOTS, { slot_cap: 4 }))
    const aquila = await ownerPresent(w)
    await setDirectives(aquila, [lift(SPRINT, new Date(w.clock.now() - MINUTE).toISOString())])
    expect((await w.afk.call('slot_start', { issue: A, thread_id: 'w1' })).isError).toBe(true)
  })

  it('refuses starts once the week used reaches the ceiling, and says so', async () => {
    const w = await ladderWorld()
    const aquila = await ownerPresent(w)
    await setDirectives(aquila, [lift(SPRINT)])

    await w.afk.ok('status_tick', w.tick(NO_NEW_SLOTS, { slot_cap: 4 }))
    expect((await w.afk.call('slot_start', { issue: A, thread_id: 'w1' })).isError).toBeFalsy()

    // 72% used is pace 1.44: still no_new_slots on its own, but at or past the 70% ceiling.
    await w.afk.ok('status_tick', w.tick(1.44, { slot_cap: 4 }))
    expect((await w.afk.ok('status_read')).pressure).toMatchObject({ budget_rung: 'no_new_slots', effective_slot_cap: 0, budget_override_active: false })
    const refused = await w.afk.call('slot_start', { issue: B, thread_id: 'w2' })
    expect(refused.isError).toBe(true)
    expect(text(refused)).toMatch(/pressure is no_new_slots/)
    expect(text(refused)).toMatch(/budget override ended: the week used 72% reached its 70% ceiling/)
  })

  it('stops at exactly the ceiling', async () => {
    const w = await ladderWorld()
    const aquila = await ownerPresent(w)
    await setDirectives(aquila, [lift(SPRINT)])
    await w.afk.ok('status_tick', w.tick(1.4, { slot_cap: 4 })) // 70% used
    expect((await w.afk.call('slot_start', { issue: A, thread_id: 'w1' })).isError).toBe(true)
  })

  it('never lifts gate_only: the weekly rung', async () => {
    const w = await ladderWorld()
    const aquila = await ownerPresent(w)
    await setDirectives(aquila, [lift({ ...SPRINT, weekly_ceiling_percent: 95 })])
    await w.afk.ok('status_tick', w.tick(1.6, { slot_cap: 4 })) // 80% used: pace 1.6 is gate_only
    expect((await w.afk.ok('status_read')).pressure).toMatchObject({ level: 'gate_only', effective_slot_cap: 0 })
    const refused = await w.afk.call('slot_start', { issue: A, thread_id: 'w1' })
    expect(refused.isError).toBe(true)
    expect(text(refused)).toMatch(/pressure is gate_only/)
  })

  it('never lifts gate_only: the window ladder', async () => {
    const w = await ladderWorld()
    const aquila = await ownerPresent(w)
    await setDirectives(aquila, [lift(SPRINT)])
    await w.afk.ok('status_tick', w.tick(NO_NEW_SLOTS, { slot_cap: 4, window_used_percent: 96 }))
    const refused = await w.afk.call('slot_start', { issue: A, thread_id: 'w1' })
    expect(refused.isError).toBe(true)
    expect(text(refused)).toMatch(/pressure is gate_only/)
  })

  it('does not lift a window level of no_new_slots: it lifts the budget rung only', async () => {
    const w = await ladderWorld()
    const aquila = await ownerPresent(w)
    await setDirectives(aquila, [lift(SPRINT)])
    await w.afk.ok('status_tick', w.tick(NO_NEW_SLOTS, { slot_cap: 4, window_used_percent: 88 }))
    const refused = await w.afk.call('slot_start', { issue: A, thread_id: 'w1' })
    expect(refused.isError).toBe(true)
    expect(text(refused)).toMatch(/pressure is no_new_slots/)
  })

  it('a later directives version without the override puts the rung back', async () => {
    const w = await ladderWorld()
    const aquila = await ownerPresent(w)
    await setDirectives(aquila, [lift(SPRINT)])
    await w.afk.ok('status_tick', w.tick(NO_NEW_SLOTS, { slot_cap: 4 }))
    expect((await w.afk.ok('status_read')).pressure).toMatchObject({ effective_slot_cap: 2 })

    await setDirectives(aquila, [], MINIMAL, 1).then((r) => expect(r.isError).toBeFalsy())
    expect((await w.afk.ok('status_read')).pressure).toMatchObject({ level: 'no_new_slots', effective_slot_cap: 0 })
    expect((await w.afk.call('slot_start', { issue: A, thread_id: 'w1' })).isError).toBe(true)
  })

  it('an unrelated override leaves the rung alone', async () => {
    const w = await ladderWorld()
    await w.afk.ok('status_tick', w.tick(NO_NEW_SLOTS, { slot_cap: 4 }))
    const aquila = await ownerPresent(w)
    await setDirectives(aquila, [{ key: 'max_slots', value: 2, until: UNTIL, reason: 'quota' }])
    expect((await w.afk.call('slot_start', { issue: A, thread_id: 'w1' })).isError).toBe(true)
  })

  it('a week that has reset drops the rung, and with it nothing is left to lift', async () => {
    const w = await ladderWorld()
    const aquila = await ownerPresent(w)
    await setDirectives(aquila, [lift(SPRINT)])
    await w.afk.ok('status_tick', w.tick(NO_NEW_SLOTS, { slot_cap: 4 }))
    w.clock.advance(4 * 24 * HOUR)
    expect((await w.afk.ok('status_read')).pressure).toMatchObject({ budget_override_active: false })
  })
})

describe('with ignore_weekly_budget also live', () => {
  it('ignore_weekly_budget wins: no weekly rung, so no cap to set', async () => {
    const w = await ladderWorld()
    const aquila = await ownerPresent(w)
    await setDirectives(aquila, [lift(SPRINT), { key: 'ignore_weekly_budget', value: true, until: UNTIL, reason: 'Owner' }])
    await w.afk.ok('status_tick', w.tick(NO_NEW_SLOTS, { slot_cap: 4 }))
    expect((await w.afk.ok('status_read')).pressure).toMatchObject({ level: 'normal', budget_rung: null, effective_slot_cap: 4, budget_override_active: false })
  })
})
