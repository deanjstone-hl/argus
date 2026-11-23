import { describe, expect, it } from 'vitest'

import { AFK_THREAD, AQUILA_THREAD, MINUTE, TOKENS, text, world } from './helpers.js'
import { DAY, HOUR, WEEK, base, ladderWorld } from './ladder-world.js'

// argus#64 (owner, 22 Nov 2026): "Max slots to 3 when pace is less than x1.00", enforced by the server. A directives
// key `pace_slot_bonus: { below_pace, total_cap }` sets the total cap to `total_cap` while the week's pace is below
// `below_pace`, and to the tick's total cap (the directives max_slots) otherwise. The budget rung still applies on top
// and host_caps still bound each host.

const MINIMAL = { cadence_minutes: 30, max_slots: 2, repo_holds: [], take_next: [], ordering: [] }
const BONUS = { below_pace: 1.0, total_cap: 3 }
const UNTIL = '2030-01-01T00:00:00+11:00'

type Direction = Awaited<ReturnType<ReturnType<typeof world>['as']>>

const setDirectives = (aquila: Direction, record: Record<string, unknown>, expected_version = 0) =>
  aquila.call('directives_set', { record, reason: 'test', expected_version, caller_thread_id: AQUILA_THREAD })

async function ownerPresent(w: ReturnType<typeof world>) {
  const aquila = await w.as('direction')
  await aquila.ok('owner_turn', { caller_thread_id: AQUILA_THREAD })
  return aquila
}

const issue = (n: number) => `deanjstone/argus#${n}`

/** A half-elapsed week with the bonus set; the tick's total cap is the directives max_slots, 2. */
async function bonusWorld(record: Record<string, unknown> = { ...MINIMAL, pace_slot_bonus: BONUS }) {
  const w = await ladderWorld()
  const aquila = await ownerPresent(w)
  const result = await setDirectives(aquila, record)
  expect(result.isError).toBeFalsy()
  return { ...w, aquila }
}

const startN = async (afk: Direction, count: number) => {
  const results = []
  for (let n = 1; n <= count; n += 1) results.push(await afk.call('slot_start', { issue: issue(n), thread_id: `w${n}` }))
  return results
}

describe('pace_slot_bonus in the validator', () => {
  it('accepts below_pace and total_cap, and the record carries them', async () => {
    const aquila = await ownerPresent(world())
    const result = await setDirectives(aquila, { ...MINIMAL, pace_slot_bonus: BONUS })
    expect(result.isError).toBeFalsy()
    const read = await aquila.ok('directives_read')
    expect(read.directives.record).toMatchObject({ pace_slot_bonus: { below_pace: 1, total_cap: 3 } })
  })

  it.each([
    [{ total_cap: 3 }, /pace_slot_bonus needs below_pace/],
    [{ below_pace: 1 }, /pace_slot_bonus needs total_cap/],
    [{ below_pace: 0, total_cap: 3 }, /below_pace must be a positive number/],
    [{ below_pace: -1, total_cap: 3 }, /below_pace must be a positive number/],
    [{ below_pace: '1', total_cap: 3 }, /below_pace must be a positive number/],
    [{ below_pace: 1, total_cap: 2.5 }, /total_cap must be a positive integer/],
    [{ below_pace: 1, total_cap: 0 }, /total_cap must be a positive integer/],
    [{ below_pace: 1, total_cap: 1 }, /total_cap must be at least max_slots/],
    [{ below_pace: 1, total_cap: 3, extra: 1 }, /unknown field: extra/],
    ['3', /pace_slot_bonus must be a mapping/],
  ])('refuses the value %j', async (value, problem) => {
    const aquila = await ownerPresent(world())
    const result = await setDirectives(aquila, { ...MINIMAL, pace_slot_bonus: value })
    expect(result.isError).toBe(true)
    expect(text(result)).toMatch(problem)
  })
})

describe('the cap while the week runs below the bonus pace', () => {
  it('allows a third slot at pace 0.8 and refuses a fourth on the cap', async () => {
    const w = await bonusWorld()
    await w.afk.ok('status_tick', w.tick(0.8, { total_cap: 2 }))
    const results = await startN(w.afk, 4)
    for (const started of results.slice(0, 3)) expect(started.isError).toBeFalsy()
    expect(results[3]?.isError).toBe(true)
    expect(text(results[3] as never)).toMatch(/effective slot cap 3 is reached/)
  })

  it('keeps the tick total cap at pace 1.00: the bonus needs the pace strictly below', async () => {
    const w = await bonusWorld()
    await w.afk.ok('status_tick', w.tick(1.0, { total_cap: 2 }))
    const results = await startN(w.afk, 3)
    expect(results[1]?.isError).toBeFalsy()
    expect(results[2]?.isError).toBe(true)
    expect(text(results[2] as never)).toMatch(/effective slot cap 2 is reached/)
  })

  it('keeps the tick total cap at pace 1.05, a level the ladder leaves at normal', async () => {
    const w = await bonusWorld()
    await w.afk.ok('status_tick', w.tick(1.05, { total_cap: 2 }))
    expect((await w.afk.ok('status_read')).pressure).toMatchObject({ budget_rung: 'normal', effective_slot_cap: 2 })
  })

  it('does not lift the cap without the key', async () => {
    const w = await bonusWorld({ ...MINIMAL })
    await w.afk.ok('status_tick', w.tick(0.8, { total_cap: 2 }))
    expect((await w.afk.ok('status_read')).pressure).toMatchObject({ effective_slot_cap: 2, pace_slot_bonus: null })
  })

  it('never lowers a tick total cap that already carries the bonus', async () => {
    const w = await bonusWorld()
    await w.afk.ok('status_tick', w.tick(0.8, { total_cap: 3 }))
    expect((await w.afk.ok('status_read')).pressure.effective_slot_cap).toBe(3)
    await w.afk.ok('status_tick', w.tick(1.05, { total_cap: 3 }))
    expect((await w.afk.ok('status_read')).pressure.effective_slot_cap).toBe(3)
  })

  it('counts a week with no weekly figure as below: the pace is unknown', async () => {
    const w = world()
    const afk = await w.as('afk')
    const aquila = await ownerPresent(w)
    await setDirectives(aquila, { ...MINIMAL, pace_slot_bonus: BONUS })
    await afk.ok('status_tick', { ...base, total_cap: 2 })
    expect((await afk.ok('status_read')).pressure).toMatchObject({ weekly_pace: null, effective_slot_cap: 3 })
  })

  it('counts the first hour of the week, where pace is null, as below', async () => {
    const w = world()
    const afk = await w.as('afk')
    const aquila = await ownerPresent(w)
    await setDirectives(aquila, { ...MINIMAL, pace_slot_bonus: BONUS })
    const resets = new Date(w.clock.now() + WEEK - 30 * MINUTE).toISOString()
    await afk.ok('status_tick', { ...base, total_cap: 2, weekly_used_percent: 5, weekly_resets_at: resets })
    expect((await afk.ok('status_read')).pressure).toMatchObject({ weekly_pace: null, effective_slot_cap: 3 })
  })

  it('reads no pace in the first day, as the ladder does: a few early points do not take the third slot away', async () => {
    const w = world()
    const afk = await w.as('afk')
    const aquila = await ownerPresent(w)
    await setDirectives(aquila, { ...MINIMAL, pace_slot_bonus: BONUS })
    // 12h into the week, 10% used: pace 1.4, but the week is too young to read.
    const resets = new Date(w.clock.now() + WEEK - 12 * HOUR).toISOString()
    await afk.ok('status_tick', { ...base, total_cap: 2, weekly_used_percent: 10, weekly_resets_at: resets })
    expect((await afk.ok('status_read')).pressure).toMatchObject({ budget_rung: 'normal', effective_slot_cap: 3, slot_cap_reason: expect.stringMatching(/first day/) })
    // A day in, the same pace counts.
    w.clock.advance(12 * HOUR)
    await afk.ok('status_tick', { ...base, total_cap: 2, weekly_used_percent: 20, weekly_resets_at: resets })
    expect((await afk.ok('status_read')).pressure.effective_slot_cap).toBe(0)
  })

  it('follows the clock between ticks: the same use is a lower pace later in the week', async () => {
    const w = await bonusWorld()
    // 50 / (3.5 / 7 * 100) = 1.0 exactly: not below. A day later it is 50 / (4.5 / 7 * 100) = 0.78.
    await w.afk.ok('status_tick', w.tick(1.0, { total_cap: 2 }))
    expect((await w.afk.ok('status_read')).pressure.effective_slot_cap).toBe(2)
    w.clock.advance(DAY)
    expect((await w.afk.ok('status_read')).pressure.effective_slot_cap).toBe(3)
  })

  it('counts a week that has reset since the last tick as below', async () => {
    const w = await bonusWorld()
    await w.afk.ok('status_tick', w.tick(1.05, { total_cap: 2 }))
    w.clock.advance(4 * DAY)
    expect((await w.afk.ok('status_read')).pressure.effective_slot_cap).toBe(3)
  })
})

describe('the budget rung and the host caps still apply on top', () => {
  it('cuts the cap to 0 from no_new_slots up, whatever the pace says', async () => {
    const w = await bonusWorld()
    // 1.3 is no_new_slots; the pace is not below 1, so no bonus either way, and the rung still stops starts.
    await w.afk.ok('status_tick', w.tick(1.3, { total_cap: 2 }))
    expect((await w.afk.ok('status_read')).pressure).toMatchObject({ budget_rung: 'no_new_slots', effective_slot_cap: 0 })
    // A spent allowance gates whatever the pace: pace 0.95 at 95% used with the reserve at 5 leaves nothing.
    await w.afk.ok('status_tick', { ...w.tick(0.9, { total_cap: 2 }), weekly_used_percent: 95 })
    expect((await w.afk.ok('status_read')).pressure).toMatchObject({ budget_rung: 'gate_only', effective_slot_cap: 0 })
    const refused = await w.afk.call('slot_start', { issue: issue(1), thread_id: 'w1' })
    expect(refused.isError).toBe(true)
  })

  it('bounds each host by its own cap: three in all, but never more than the host cap on one host', async () => {
    const w = await bonusWorld()
    await w.afk.ok('status_tick', w.tick(0.8, { total_cap: 2, host_caps: { wsl2: 2, homelab: 1 } }))
    expect((await w.afk.call('slot_start', { issue: issue(1), thread_id: 'w1', host: 'wsl2' })).isError).toBeFalsy()
    expect((await w.afk.call('slot_start', { issue: issue(2), thread_id: 'w2', host: 'wsl2' })).isError).toBeFalsy()
    const third = await w.afk.call('slot_start', { issue: issue(3), thread_id: 'w3', host: 'wsl2' })
    expect(third.isError).toBe(true)
    expect(text(third)).toMatch(/wsl2 slot cap 2 is reached/)
    expect((await w.afk.call('slot_start', { issue: issue(3), thread_id: 'w3', host: 'homelab' })).isError).toBeFalsy()
    expect((await w.afk.call('slot_start', { issue: issue(4), thread_id: 'w4', host: 'homelab' })).isError).toBe(true)
  })

  it('is bounded by a lift_budget_rung override: the override sets the cap at no_opus', async () => {
    const w = await bonusWorld({
      ...MINIMAL,
      max_slots: 3,
      pace_slot_bonus: { below_pace: 1.0, total_cap: 3 },
      overrides: [{ key: 'lift_budget_rung', value: { slots: 2, weekly_ceiling_percent: 70 }, until: UNTIL, reason: 'Owner' }],
    })
    await w.afk.ok('status_tick', w.tick(1.2, { total_cap: 3 }))
    expect((await w.afk.ok('status_read')).pressure).toMatchObject({ budget_rung: 'no_opus', effective_slot_cap: 2 })
  })
})

describe('with other overrides live', () => {
  it('a live max_slots override suspends the bonus: the owner set that cap by hand', async () => {
    const w = await bonusWorld({
      ...MINIMAL,
      pace_slot_bonus: BONUS,
      overrides: [{ key: 'max_slots', value: 1, until: UNTIL, reason: 'quota' }],
    })
    await w.afk.ok('status_tick', w.tick(0.8, { total_cap: 1 }))
    expect((await w.afk.ok('status_read')).pressure).toMatchObject({ effective_slot_cap: 1, pace_slot_bonus_suspended: true })
  })

  it('an expired max_slots override no longer suspends it', async () => {
    const w = await bonusWorld({
      ...MINIMAL,
      pace_slot_bonus: BONUS,
      overrides: [{ key: 'max_slots', value: 1, until: '2020-01-01T00:00:00+11:00', reason: 'quota' }],
    })
    await w.afk.ok('status_tick', w.tick(0.8, { total_cap: 2 }))
    expect((await w.afk.ok('status_read')).pressure).toMatchObject({ effective_slot_cap: 3, pace_slot_bonus_suspended: false })
  })

  it('ignore_weekly_budget live: the pace is not read, so the bonus applies', async () => {
    const w = await bonusWorld({
      ...MINIMAL,
      pace_slot_bonus: BONUS,
      overrides: [{ key: 'ignore_weekly_budget', value: true, until: UNTIL, reason: 'Owner' }],
    })
    await w.afk.ok('status_tick', w.tick(1.2, { total_cap: 2 }))
    expect((await w.afk.ok('status_read')).pressure).toMatchObject({ budget_rung: null, effective_slot_cap: 3 })
  })
})

describe('status_read shows which cap applied, and why', () => {
  it('names the bonus, the pace and the tick total cap it replaced', async () => {
    const w = await bonusWorld()
    await w.afk.ok('status_tick', w.tick(0.8, { total_cap: 2 }))
    expect((await w.afk.ok('status_read')).pressure).toMatchObject({
      effective_slot_cap: 3,
      pace_slot_bonus: { below_pace: 1, total_cap: 3 },
      pace_slot_bonus_active: true,
      pace_slot_bonus_suspended: false,
      slot_cap_reason: 'pace bonus: pace 0.8 is below 1, so the total cap is 3 (the tick sent 2)',
    })
  })

  it('names the tick total cap when the pace is not below', async () => {
    const w = await bonusWorld()
    await w.afk.ok('status_tick', w.tick(1.05, { total_cap: 2 }))
    expect((await w.afk.ok('status_read')).pressure).toMatchObject({
      effective_slot_cap: 2,
      pace_slot_bonus_active: false,
      slot_cap_reason: 'total cap 2 from the tick: pace 1.05 is not below 1',
    })
  })

  it('names the rung when the ladder cuts the cap', async () => {
    const w = await bonusWorld()
    await w.afk.ok('status_tick', w.tick(1.3, { total_cap: 2 }))
    expect((await w.afk.ok('status_read')).pressure.slot_cap_reason).toMatch(/budget rung no_new_slots: no new slots/)
  })

  it('says there is no bonus when the key is absent', async () => {
    const w = await bonusWorld({ ...MINIMAL })
    await w.afk.ok('status_tick', w.tick(0.8, { total_cap: 2 }))
    expect((await w.afk.ok('status_read')).pressure).toMatchObject({ pace_slot_bonus: null, pace_slot_bonus_active: false, slot_cap_reason: 'total cap 2 from the tick' })
  })

  it('reads the key from the current directives, so a later version that drops it puts the cap back', async () => {
    const w = await bonusWorld()
    await w.afk.ok('status_tick', w.tick(0.8, { total_cap: 2 }))
    expect((await w.afk.ok('status_read')).pressure.effective_slot_cap).toBe(3)
    await setDirectives(w.aquila, { ...MINIMAL }, 1).then((r) => expect(r.isError).toBeFalsy())
    expect((await w.afk.ok('status_read')).pressure.effective_slot_cap).toBe(2)
  })
})

describe('POST /wake/check counts the bonus room', () => {
  const check = (extra: Record<string, unknown> = {}) => ({
    role: 'afk',
    host: 'wsl2',
    thread_id: AFK_THREAD,
    directives_version: 'v1',
    needs_owner: [] as string[],
    window_used_percent: 20,
    takeable: 3,
    ...extra,
  })

  it('wakes for a free slot with two running when the third is allowed, and not once the pace is no longer below', async () => {
    const w = await bonusWorld()
    await w.afk.ok('status_tick', w.tick(0.8, { total_cap: 2 }))
    await startN(w.afk, 2)
    await w.afk.ok('status_tick', w.tick(0.8, { total_cap: 2 }))
    expect((await w.post('/wake/check', check(), TOKENS.afk)).body).toEqual({ wake: true, reason: 'free_slot', recorded: false })

    await w.afk.ok('status_tick', w.tick(1.05, { total_cap: 2 }))
    expect((await w.post('/wake/check', check(), TOKENS.afk)).body).toEqual({ wake: false, reason: 'quiet', recorded: true })
  })
})
