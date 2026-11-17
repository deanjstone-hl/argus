import { describe, expect, it } from 'vitest'

import { AFK_THREAD, MINUTE, TOKENS, world } from './helpers.js'
import { DAY, HOUR, WEEK, base, ladderWorld } from './ladder-world.js'

/**
 * The remaining-budget ladder (argus#871, map argus-config#870).
 * allowance = (100 - used - reserve) / days left; burn = the trailing 24h rise in weekly %
 * used; ratio = burn / allowance. Above 1.0 no_opus + cap 1, above 1.2 no_new_slots, above 1.5
 * (or the allowance spent: 100 - reserve used) gate_only. A rung releases only below its threshold - 0.05.
 */
describe('ladder v2: rung edges', () => {
  it.each([
    [0, 'normal', 0],
    [8, 'normal', 0.8],
    [10, 'normal', 1],
    [10.5, 'no_opus', 1.05],
    [12, 'no_opus', 1.2],
    [12.5, 'no_new_slots', 1.25],
    [15, 'no_new_slots', 1.5],
    [15.5, 'gate_only', 1.55],
  ])('a burn of %s a day against an allowance of 10 is %s (ratio %s)', async (burn, level, ratio) => {
    const { ratioTo } = await ladderWorld()
    const pressure = await ratioTo(burn)
    expect(pressure.level).toBe(level)
    expect(pressure.budget_ratio).toBeCloseTo(ratio, 10)
    expect(pressure.burn_per_day).toBeCloseTo(burn, 10)
    expect(pressure.allowance_per_day).toBeCloseTo(10, 10)
  })

  it('gate_only starts at 100 - reserve used, not at a fixed 90% (argus#1080)', async () => {
    // The last hours of the week: 2h to the reset, well under budget by the ratio.
    const w = world()
    const afk = await w.as('afk')
    const resets = new Date(w.clock.now() + 2 * HOUR).toISOString()
    await afk.ok('status_tick', { ...base, weekly_used_percent: 92, weekly_resets_at: resets, reserve_percent: 5 })
    expect((await afk.ok('status_read')).pressure.level).toBe('normal')
    await afk.ok('status_tick', { ...base, weekly_used_percent: 95, weekly_resets_at: resets, reserve_percent: 5 })
    expect((await afk.ok('status_read')).pressure).toMatchObject({ level: 'gate_only', budget_ratio: null })
  })

  it('the default reserve of 10 still gates at 90% used', async () => {
    const w = world()
    const afk = await w.as('afk')
    const resets = new Date(w.clock.now() + 2 * HOUR).toISOString()
    await afk.ok('status_tick', { ...base, weekly_used_percent: 89, weekly_resets_at: resets })
    expect((await afk.ok('status_read')).pressure.level).not.toBe('gate_only')
    await afk.ok('status_tick', { ...base, weekly_used_percent: 90, weekly_resets_at: resets })
    expect((await afk.ok('status_read')).pressure).toMatchObject({ level: 'gate_only' })
  })

  it('treats an allowance that is spent as gate_only', async () => {
    const { afk, resets } = await ladderWorld()
    await afk.ok('status_tick', { ...base, weekly_used_percent: 85, weekly_resets_at: resets, reserve_percent: 15 })
    expect((await afk.ok('status_read')).pressure).toMatchObject({ level: 'gate_only', budget_ratio: null })
  })

  it('reports the reserve it used, defaulting to 10', async () => {
    const { afk, resets } = await ladderWorld()
    await afk.ok('status_tick', { ...base, weekly_used_percent: 40, weekly_resets_at: resets })
    const { pressure } = await afk.ok('status_read')
    expect(pressure.reserve_percent).toBe(10)
    expect(pressure.allowance_per_day).toBeCloseTo((100 - 40 - 10) / 3.5, 10)
  })

  it('refuses a reserve outside 0 to 100', async () => {
    const { afk, tick } = await ladderWorld()
    for (const reserve of [-1, 100, 101]) {
      const result = await afk.call('status_tick', tick(5, { reserve_percent: reserve }))
      expect(result.isError).toBe(true)
      expect(result.content[0]?.text).toMatch(/reserve_percent/)
    }
  })
})

describe('ladder v2: the burn', () => {
  it('uses the rise over the trailing 24h, normalised by the span of the readings', async () => {
    const w = await ladderWorld()
    w.clock.advance(12 * HOUR)
    const pressure = await w.ratioTo(15)
    // The baseline is the last reading at least 24h old: 36h back, a 15 point rise over 1.5 days.
    expect(pressure.burn_per_day).toBeCloseTo(10, 10)
  })

  it('takes the latest reading at least 24h old as the baseline, not the oldest', async () => {
    const w = await ladderWorld()
    // A reading 30h before the next tick, higher than the baseline: the rise is measured from it.
    await w.afk.ok('status_tick', w.tick(4))
    w.clock.advance(DAY)
    const pressure = await w.ratioTo(4 + 6)
    expect(pressure.burn_per_day).toBeCloseTo(6, 10)
  })

  it('never reports a negative burn', async () => {
    const { ratioTo } = await ladderWorld()
    expect((await ratioTo(-5)).burn_per_day).toBe(0)
  })

  it('has no burn while under 24h of readings: the week-start extrapolation engages nothing', async () => {
    // Half the week elapsed, 35% used (10 a day since the week began), but the only readings are 6h old.
    const w = world()
    const afk = await w.as('afk')
    const resets = new Date(w.clock.now() + 3.5 * DAY).toISOString()
    await afk.ok('status_tick', { ...base, weekly_used_percent: 30, weekly_resets_at: resets, reserve_percent: 100 - 30 - 35 })
    w.clock.advance(6 * HOUR)
    await afk.ok('status_tick', { ...base, weekly_used_percent: 35, weekly_resets_at: resets, reserve_percent: 30 })
    const { pressure } = await afk.ok('status_read')
    expect(pressure).toMatchObject({ burn_per_day: null, budget_ratio: null, level: 'normal' })
    expect(pressure.allowance_per_day).toBeCloseTo((100 - 35 - 30) / 3.25, 10)
  })

  it('stays normal through the 5 Nov sequence: 2% to 3% used in the first hours of the week', async () => {
    // Reset 08:00 AEDT; readings 10:37 (2%), 10:45 (2%), 11:06 (3%), 11:43 (3%). Default reserve 10.
    const w = world()
    const afk = await w.as('afk')
    const resets = new Date(w.clock.now() + WEEK - 2.6 * HOUR).toISOString()
    const readings: Array<[number, number]> = [[0, 2], [8, 2], [29, 3], [66, 3]]
    let elapsed = 0
    for (const [minutes, used] of readings) {
      w.clock.advance((minutes - elapsed) * MINUTE)
      elapsed = minutes
      await afk.ok('status_tick', { ...base, weekly_used_percent: used, weekly_resets_at: resets })
      expect((await afk.ok('status_read')).pressure).toMatchObject({ level: 'normal', burn_per_day: null, budget_ratio: null, budget_rung_held: false })
    }
  })

  it('drives the ladder once a reading 24h old exists', async () => {
    const w = world()
    const afk = await w.as('afk')
    const resets = new Date(w.clock.now() + 3.5 * DAY).toISOString()
    await afk.ok('status_tick', { ...base, weekly_used_percent: 30, weekly_resets_at: resets, reserve_percent: 35 })
    w.clock.advance(DAY)
    await afk.ok('status_tick', { ...base, weekly_used_percent: 41, weekly_resets_at: resets, reserve_percent: 34 })
    // 11 points over exactly 1 day against (100 - 41 - 34) / 2.5 = 10 a day.
    const { pressure } = await afk.ok('status_read')
    expect(pressure.burn_per_day).toBeCloseTo(11, 10)
    expect(pressure.budget_ratio).toBeCloseTo(1.1, 10)
    expect(pressure.level).toBe('no_opus')
  })

  it('has no ratio in the first hour of the week, but a spent allowance still gates', async () => {
    const w = world()
    const afk = await w.as('afk')
    const resets = new Date(w.clock.now() + WEEK - 30 * MINUTE).toISOString()
    await afk.ok('status_tick', { ...base, weekly_used_percent: 5, weekly_resets_at: resets })
    expect((await afk.ok('status_read')).pressure).toMatchObject({ level: 'normal', budget_ratio: null, burn_per_day: null })
    await afk.ok('status_tick', { ...base, weekly_used_percent: 90, weekly_resets_at: resets })
    expect((await afk.ok('status_read')).pressure.level).toBe('gate_only')
  })

  it('ignores readings from the week before', async () => {
    const w = await ladderWorld()
    // The week rolled over: a fresh week at 2% used must not be measured against last week's 30%.
    w.clock.advance(4.5 * DAY)
    const next = new Date(w.clock.now() + WEEK - 2 * DAY).toISOString()
    await w.afk.ok('status_tick', { ...base, weekly_used_percent: 2, weekly_resets_at: next })
    const { pressure } = await w.afk.ok('status_read')
    // 2 days into the new week with no reading 24h old in it: no burn, and nothing from last week's readings.
    expect(pressure.burn_per_day).toBeNull()
  })

  it('still gates at 100 - reserve used with no reading 24h old', async () => {
    const w = world()
    const afk = await w.as('afk')
    const resets = new Date(w.clock.now() + WEEK - 3 * HOUR).toISOString()
    await afk.ok('status_tick', { ...base, weekly_used_percent: 85, weekly_resets_at: resets, reserve_percent: 15 })
    expect((await afk.ok('status_read')).pressure).toMatchObject({ level: 'gate_only', burn_per_day: null, budget_ratio: null })
  })
})

describe('ladder v2: hysteresis', () => {
  it('engages a rung only above its threshold, so a ratio just under it from calm stays calm', async () => {
    const { ratioTo } = await ladderWorld()
    expect((await ratioTo(9.7)).level).toBe('normal')
    expect((await ratioTo(10.2)).level).toBe('no_opus')
  })

  it.each([
    ['no_opus', 10.5, 9.7, 'no_opus', 9.4, 'normal'],
    ['no_new_slots', 12.5, 11.7, 'no_new_slots', 11.4, 'no_opus'],
    ['gate_only', 15.5, 14.7, 'gate_only', 14.4, 'no_new_slots'],
  ])('%s holds until the ratio is below its threshold - 0.05', async (rung, engage, within, held, below, released) => {
    const { ratioTo } = await ladderWorld()
    expect((await ratioTo(engage)).level).toBe(rung)
    const heldPressure = await ratioTo(within)
    expect(heldPressure.level).toBe(held)
    expect(heldPressure.budget_rung_held).toBe(true)
    const releasedPressure = await ratioTo(below)
    expect(releasedPressure.level).toBe(released)
  })

  it('does not mark a rung held when the ratio alone gives it', async () => {
    const { ratioTo } = await ladderWorld()
    expect((await ratioTo(10.5)).budget_rung_held).toBe(false)
  })

  it('a quiet tick_gate carries the rung forward without a flip', async () => {
    const { afk, ratioTo, tick } = await ladderWorld()
    await ratioTo(10.5)
    // 9.7 is inside the band: tick_gate sees the held rung, so no pressure change.
    expect(await afk.ok('tick_gate', tick(9.7))).toMatchObject({ changed: false, recorded: true })
    expect((await afk.ok('status_read')).pressure).toMatchObject({ level: 'no_opus', budget_rung_held: true })
  })

  it('a rung released between ticks does not hold into the next week', async () => {
    const w = await ladderWorld()
    await w.ratioTo(10.5)
    w.clock.advance(5 * DAY)
    const fresh = new Date(w.clock.now() + WEEK - DAY).toISOString()
    // Ratio 0.97 on the new week: inside the old rung's release band, but that rung belonged to the old week.
    await w.afk.ok('status_tick', { ...base, weekly_used_percent: 12.5, weekly_resets_at: fresh })
    expect((await w.afk.ok('status_read')).pressure).toMatchObject({ level: 'normal', budget_rung_held: false })
  })
})

describe('ladder v2: the effective level and cap', () => {
  it('is the stricter of the budget rung and the window ladder', async () => {
    const { afk, tick } = await ladderWorld()
    await afk.ok('status_tick', tick(10.5, { window_used_percent: 90 }))
    expect((await afk.ok('status_read')).pressure.level).toBe('no_new_slots')
    await afk.ok('status_tick', tick(15.5, { window_used_percent: 72 }))
    expect((await afk.ok('status_read')).pressure.level).toBe('gate_only')
    await afk.ok('status_tick', tick(5, { window_used_percent: 72 }))
    expect((await afk.ok('status_read')).pressure.level).toBe('no_opus')
  })

  it.each([
    [3, 8, 3],
    [3, 10, 3],
    [3, 10.5, 1],
    [undefined, 10.5, 1],
    [undefined, 5, null],
    [0, 10.5, 0],
  ])('a total cap of %s at burn %s is an effective cap of %s', async (cap, burn, expected) => {
    const { afk, tick } = await ladderWorld()
    await afk.ok('status_tick', tick(burn, cap === undefined ? {} : { total_cap: cap }))
    expect((await afk.ok('status_read')).pressure.effective_slot_cap).toBe(expected)
  })

  it('still reads the legacy weekly fields', async () => {
    const { afk, tick } = await ladderWorld()
    await afk.ok('status_tick', tick(5))
    expect((await afk.ok('status_read')).pressure).toMatchObject({ weekly_used_percent: 35, weekly_pace: expect.any(Number) })
  })

  it('takes slot_cap as the total cap from a caller that has not moved to total_cap', async () => {
    const { afk, tick } = await ladderWorld()
    await afk.ok('status_tick', tick(5, { slot_cap: 2 }))
    expect((await afk.ok('status_read')).slots.cap).toBe(2)
    await afk.ok('status_tick', tick(5, { slot_cap: 2, total_cap: 3 }))
    expect((await afk.ok('status_read')).slots.cap).toBe(3)
  })
})

describe('ladder v2: slot starts', () => {
  const issue = (n: number) => `deanjstone/argus#${n}`
  const caps = { host_caps: { homelab: 1, wsl2: 2 }, total_cap: 3 }

  it('refuses a start past the host cap, with room left in the total', async () => {
    const { afk, tick } = await ladderWorld()
    await afk.ok('status_tick', tick(0, caps))
    await afk.ok('slot_start', { issue: issue(1), thread_id: 'w1', host: 'homelab' })
    const refused = await afk.call('slot_start', { issue: issue(2), thread_id: 'w2', host: 'homelab' })
    expect(refused.isError).toBe(true)
    expect(refused.content[0]?.text).toMatch(/homelab slot cap 1/)
    expect((await afk.call('slot_start', { issue: issue(2), thread_id: 'w2', host: 'wsl2' })).isError).toBeFalsy()
  })

  it('refuses a start past the total cap even when the host has room', async () => {
    const { afk, tick } = await ladderWorld()
    await afk.ok('status_tick', tick(0, caps))
    await afk.ok('slot_start', { issue: issue(1), thread_id: 'w1', host: 'homelab' })
    await afk.ok('slot_start', { issue: issue(2), thread_id: 'w2', host: 'wsl2' })
    await afk.ok('slot_start', { issue: issue(3), thread_id: 'w3', host: 'wsl2' })
    const refused = await afk.call('slot_start', { issue: issue(4), thread_id: 'w4', host: 'wsl2' })
    expect(refused.isError).toBe(true)
    expect(refused.content[0]?.text).toMatch(/slot cap/)
  })

  it('applies the rung cap of 1 across the hosts', async () => {
    const { afk, tick } = await ladderWorld()
    await afk.ok('status_tick', tick(10.5, caps))
    await afk.ok('slot_start', { issue: issue(1), thread_id: 'w1', host: 'wsl2' })
    const refused = await afk.call('slot_start', { issue: issue(2), thread_id: 'w2', host: 'homelab' })
    expect(refused.isError).toBe(true)
    expect(refused.content[0]?.text).toMatch(/effective slot cap 1/)
  })

  it('a host with no cap is limited only by the total', async () => {
    const { afk, tick } = await ladderWorld()
    await afk.ok('status_tick', tick(0, { host_caps: { homelab: 1 }, total_cap: 3 }))
    for (const n of [1, 2, 3]) await afk.ok('slot_start', { issue: issue(n), thread_id: `w${n}`, host: 'wsl2' })
    expect((await afk.call('slot_start', { issue: issue(4), thread_id: 'w4', host: 'wsl2' })).isError).toBe(true)
  })

  it('a caller that sends no host caps is held to the total alone, as before', async () => {
    const { afk, tick } = await ladderWorld()
    await afk.ok('status_tick', tick(0, { slot_cap: 2 }))
    await afk.ok('slot_start', { issue: issue(1), thread_id: 'w1', host: 'homelab' })
    await afk.ok('slot_start', { issue: issue(2), thread_id: 'w2', host: 'homelab' })
    expect((await afk.call('slot_start', { issue: issue(3), thread_id: 'w3', host: 'wsl2' })).isError).toBe(true)
  })

  it('reports per-host used and cap in status_read, and carries the caps through a quiet tick', async () => {
    const { afk, tick } = await ladderWorld()
    await afk.ok('status_tick', tick(0, caps))
    await afk.ok('slot_start', { issue: issue(1), thread_id: 'w1', host: 'homelab' })
    await afk.ok('status_tick', tick(0, caps))
    expect((await afk.ok('status_read')).slots).toMatchObject({
      cap: 3,
      hosts: { homelab: { used: 1, cap: 1 }, wsl2: { used: 0, cap: 2 } },
    })
    expect(await afk.ok('tick_gate', tick(0))).toMatchObject({ changed: false, recorded: true })
    expect((await afk.ok('status_read')).slots.hosts).toMatchObject({ homelab: { cap: 1 }, wsl2: { cap: 2 } })
  })

  it('reports a null host cap when the caller sent none', async () => {
    const { afk, tick } = await ladderWorld()
    await afk.ok('status_tick', tick(0))
    expect((await afk.ok('status_read')).slots.hosts).toEqual({ homelab: { used: 0, cap: null }, wsl2: { used: 0, cap: null } })
  })

  it.each([
    ['a negative cap', { homelab: -1 }],
    ['a fractional cap', { wsl2: 1.5 }],
  ])('refuses %s', async (_name, host_caps) => {
    const { afk, tick } = await ladderWorld()
    const result = await afk.call('status_tick', tick(0, { host_caps }))
    expect(result.isError).toBe(true)
  })
})

describe('ladder v2: the quiet-tick gate and wake', () => {
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

  it('does not wake for a free slot when every host with room is full', async () => {
    const { afk, tick, post, clock } = await ladderWorld()
    await afk.ok('status_tick', tick(0, { host_caps: { homelab: 1, wsl2: 1 }, total_cap: 3 }))
    await afk.ok('slot_start', { issue: 'deanjstone/argus#1', thread_id: 'w1', host: 'homelab' })
    await afk.ok('slot_start', { issue: 'deanjstone/argus#2', thread_id: 'w2', host: 'wsl2' })
    await afk.ok('status_tick', tick(0, { host_caps: { homelab: 1, wsl2: 1 }, total_cap: 3 }))
    clock.advance(MINUTE)
    const { weekly_used_percent, weekly_resets_at } = tick(0)
    expect((await post('/wake/check', check({ weekly_used_percent, weekly_resets_at }), TOKENS.afk)).body).toEqual({
      wake: false,
      reason: 'quiet',
      recorded: true,
    })
  })

  it('wakes for a free slot while one host has room', async () => {
    const { afk, tick, post, clock } = await ladderWorld()
    await afk.ok('status_tick', tick(0, { host_caps: { homelab: 1, wsl2: 2 }, total_cap: 3 }))
    await afk.ok('slot_start', { issue: 'deanjstone/argus#1', thread_id: 'w1', host: 'homelab' })
    await afk.ok('status_tick', tick(0, { host_caps: { homelab: 1, wsl2: 2 }, total_cap: 3 }))
    clock.advance(MINUTE)
    const { weekly_used_percent, weekly_resets_at } = tick(0)
    expect((await post('/wake/check', check({ weekly_used_percent, weekly_resets_at }), TOKENS.afk)).body).toMatchObject({
      wake: true,
      reason: 'free_slot',
    })
  })

  it('a rung held by hysteresis is not a pressure change', async () => {
    const { afk, tick } = await ladderWorld()
    await afk.ok('status_tick', tick(10.5))
    expect(await afk.ok('tick_gate', tick(9.7))).toMatchObject({ changed: false })
    expect(await afk.ok('tick_gate', tick(9.4))).toMatchObject({ changed: true, reasons: ['pressure'] })
  })
})
