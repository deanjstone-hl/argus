import { describe, expect, it } from 'vitest'

import { AQUILA_THREAD, MINUTE, PROMOTION_TOKEN, text, world } from './helpers.js'
import { ladderWorld } from './ladder-world.js'

// argus-config#1573 added an `ignore_weekly_budget` directives override client-side; this is the
// server half (argus#60): the validator accepts it, and the ladder skips the weekly rung while
// the override is live, whatever weekly figures a tick sends, so no tick can apply the weekly
// ladder by mistake.

const MINIMAL = { cadence_minutes: 30, max_slots: 2, repo_holds: [], take_next: [], ordering: [] }
const UNTIL = '2030-01-01T00:00:00+11:00'
const entry = (value: unknown, until = UNTIL) => ({ key: 'ignore_weekly_budget', value, until, reason: 'Owner: ignore the weekly ladder' })

type Direction = Awaited<ReturnType<ReturnType<typeof world>['as']>>

const setDirectives = (aquila: Direction, overrides: unknown[], expected_version = 0) =>
  aquila.call('directives_set', { record: { ...MINIMAL, overrides }, reason: 'test', expected_version, caller_thread_id: AQUILA_THREAD })

async function ownerPresent(w: ReturnType<typeof world>) {
  const aquila = await w.as('direction')
  await aquila.ok('owner_turn', { caller_thread_id: AQUILA_THREAD })
  return aquila
}

const A = 'deanjstone/argus#1'
const B = 'deanjstone/argus#2'

describe('the ignore_weekly_budget override in the validator', () => {
  it('accepts true, time-boxed like the other overrides', async () => {
    const aquila = await ownerPresent(world())
    const result = await setDirectives(aquila, [entry(true)])
    expect(result.isError).toBeFalsy()
  })

  it.each([false, 'true', 1, null, ['x']])('refuses the value %j: only true is a switch', async (value) => {
    const aquila = await ownerPresent(world())
    const result = await setDirectives(aquila, [entry(value)])
    expect(result.isError).toBe(true)
    expect(text(result)).toMatch(/overrides\[0\]: ignore_weekly_budget must be true/)
  })

  it('refuses an until with no offset', async () => {
    const aquila = await ownerPresent(world())
    const result = await setDirectives(aquila, [entry(true, '2030-01-01T00:00:00')])
    expect(result.isError).toBe(true)
    expect(text(result)).toMatch(/overrides\[0\]: until/)
  })

  it('lists the key among the ones an override may name', async () => {
    const aquila = await ownerPresent(world())
    const result = await setDirectives(aquila, [{ ...entry(true), key: 'bogus' }])
    expect(text(result)).toMatch(/key must be one of .*ignore_weekly_budget/)
  })
})

describe('the ladder while ignore_weekly_budget is live', () => {
  it('the same week that cuts the cap to 1 without it leaves the total cap alone with it', async () => {
    const w = await ladderWorld()
    const aquila = await ownerPresent(w)
    await setDirectives(aquila, [entry(true)]).then((r) => expect(r.isError).toBeFalsy())

    // A tick that still sends the weekly figures (ratio 1.1: no_new_slots on its own).
    await w.afk.ok('status_tick', w.tick(11, { slot_cap: 2 }))
    const { pressure } = await w.afk.ok('status_read')
    expect(pressure).toMatchObject({
      level: 'normal',
      weekly_used_percent: null,
      budget_rung: null,
      effective_slot_cap: 2,
    })
    await w.afk.ok('slot_start', { issue: A, thread_id: 'w1' })
    expect((await w.afk.call('slot_start', { issue: B, thread_id: 'w2' })).isError).toBeFalsy()
  })

  it('does not stop a start at gate_only-grade burn, but the window ladder still does', async () => {
    const w = await ladderWorld()
    const aquila = await ownerPresent(w)
    await setDirectives(aquila, [entry(true)])

    await w.afk.ok('status_tick', w.tick(16, { slot_cap: 2 }))
    expect((await w.afk.call('slot_start', { issue: A, thread_id: 'w1' })).isError).toBeFalsy()

    await w.afk.ok('status_tick', w.tick(16, { slot_cap: 2, window_used_percent: 96 }))
    const refused = await w.afk.call('slot_start', { issue: B, thread_id: 'w2' })
    expect(refused.isError).toBe(true)
    expect(text(refused)).toMatch(/pressure is gate_only/)
  })

  it('takes hold at once on the rung the last tick recorded, with no new tick', async () => {
    const w = await ladderWorld()
    await w.afk.ok('status_tick', w.tick(16, { slot_cap: 2 }))
    expect((await w.afk.call('slot_start', { issue: A, thread_id: 'w1' })).isError).toBe(true)

    const aquila = await ownerPresent(w)
    await setDirectives(aquila, [entry(true)])
    expect((await w.afk.ok('status_read')).pressure).toMatchObject({ level: 'normal', budget_rung: null, effective_slot_cap: 2 })
    expect((await w.afk.call('slot_start', { issue: A, thread_id: 'w1' })).isError).toBeFalsy()
  })

  it('shows no weekly rung on a wake request', async () => {
    const w = await ladderWorld()
    await w.afk.ok('status_tick', w.tick(16, { slot_cap: 2 }))
    const aquila = await ownerPresent(w)
    await setDirectives(aquila, [entry(true)])
    const wake = await w.post('/wake/request', { issue: A }, PROMOTION_TOKEN)
    expect(wake.body).toMatchObject({ recorded: true, budget_rung: null })
  })

  it('still records the weekly readings, so the burn is known when the override ends', async () => {
    const w = await ladderWorld()
    const aquila = await ownerPresent(w)
    await setDirectives(aquila, [entry(true, new Date(w.clock.now() + 30 * MINUTE).toISOString())])
    await w.afk.ok('status_tick', w.tick(16, { slot_cap: 2 }))

    w.clock.advance(31 * MINUTE)
    await w.afk.ok('status_tick', w.tick(16, { slot_cap: 2 }))
    expect((await w.afk.ok('status_read')).pressure).toMatchObject({ level: 'gate_only', budget_rung: 'gate_only' })
    const refused = await w.afk.call('slot_start', { issue: A, thread_id: 'w1' })
    expect(refused.isError).toBe(true)
    expect(text(refused)).toMatch(/pressure is gate_only/)
  })

  it('an entry already past its until is ignored', async () => {
    const w = await ladderWorld()
    const aquila = await ownerPresent(w)
    await setDirectives(aquila, [entry(true, new Date(w.clock.now() - MINUTE).toISOString())])
    await w.afk.ok('status_tick', w.tick(16, { slot_cap: 2 }))
    expect((await w.afk.ok('status_read')).pressure).toMatchObject({ budget_rung: 'gate_only' })
  })

  it('an unrelated override leaves the ladder alone', async () => {
    const w = await ladderWorld()
    const aquila = await ownerPresent(w)
    await setDirectives(aquila, [{ key: 'max_slots', value: 1, until: UNTIL, reason: 'quota' }])
    await w.afk.ok('status_tick', w.tick(16, { slot_cap: 2 }))
    expect((await w.afk.ok('status_read')).pressure).toMatchObject({ budget_rung: 'gate_only' })
  })

  it('a later directives version without the override puts the ladder back', async () => {
    const w = await ladderWorld()
    const aquila = await ownerPresent(w)
    await setDirectives(aquila, [entry(true)])
    await w.afk.ok('status_tick', w.tick(16, { slot_cap: 2 }))
    expect((await w.afk.ok('status_read')).pressure).toMatchObject({ level: 'normal' })

    await setDirectives(aquila, [], 1).then((r) => expect(r.isError).toBeFalsy())
    await w.afk.ok('status_tick', w.tick(16, { slot_cap: 2 }))
    expect((await w.afk.ok('status_read')).pressure).toMatchObject({ level: 'gate_only', budget_rung: 'gate_only' })
  })
})
