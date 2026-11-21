import { describe, expect, it } from 'vitest'

import { AFK_THREAD, MINUTE, TOKENS, world } from './helpers.js'
import { DAY, HOUR, WEEK, base, ladderWorld } from './ladder-world.js'

/**
 * The weekly budget ladder (argus#62, owner 22 Nov 2026; before it argus#871's burn ÷ allowance).
 * pace = weekly % used ÷ % of the week elapsed. Above 1.1 no_opus (the cap stays), above 1.25
 * no_new_slots, above 1.5 (or the allowance spent: 100 - reserve used) gate_only. A rung releases
 * only below its threshold - 0.05. Pace drives no rung in the first day of the week.
 * Burn, allowance and ratio are still reported, as information.
 */
describe('ladder: rung edges on pace', () => {
  it.each([
    [0, 'normal'],
    [0.8, 'normal'],
    [1.0, 'normal'],
    [1.1, 'normal'],
    [1.15, 'no_opus'],
    [1.25, 'no_opus'],
    [1.3, 'no_new_slots'],
    [1.5, 'no_new_slots'],
    [1.55, 'gate_only'],
  ])('a weekly pace of %s is %s', async (pace, level) => {
    const { paceTo } = await ladderWorld()
    const pressure = await paceTo(pace)
    expect(pressure.level).toBe(level)
    expect(pressure.weekly_pace).toBeCloseTo(pace, 10)
  })

  it('reads pace, not the burn: a busy day under even pace stays normal (22 Nov 2026)', async () => {
    // 45% used with 41.6% of the week gone: a 1.8 burn ratio gated everything; pace 1.08 is normal.
    const w = world()
    const afk = await w.as('afk')
    const resets = new Date(w.clock.now() + DAY + 0.584 * WEEK).toISOString()
    await afk.ok('status_tick', { ...base, weekly_used_percent: 23, weekly_resets_at: resets, reserve_percent: 5 })
    w.clock.advance(DAY)
    await afk.ok('status_tick', { ...base, weekly_used_percent: 45, weekly_resets_at: resets, reserve_percent: 5 })
    const { pressure } = await afk.ok('status_read')
    expect(pressure.budget_ratio).toBeGreaterThan(1.5)
    expect(pressure.weekly_pace).toBeCloseTo(1.08, 2)
    expect(pressure).toMatchObject({ level: 'normal', budget_rung: 'normal' })
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
      const result = await afk.call('status_tick', tick(0.5, { reserve_percent: reserve }))
      expect(result.isError).toBe(true)
      expect(result.content[0]?.text).toMatch(/reserve_percent/)
    }
  })
})

describe('ladder: the burn, reported beside the rung', () => {
  it('uses the rise over the trailing 24h, normalised by the span of the readings', async () => {
    const w = await ladderWorld()
    w.clock.advance(12 * HOUR)
    const pressure = await w.paceTo(0.9)
    // 45% used. The baseline is the last reading at least 24h old: 36h back, a 15 point rise over 1.5 days.
    expect(pressure.burn_per_day).toBeCloseTo(10, 10)
  })

  it('takes the latest reading at least 24h old as the baseline, not the oldest', async () => {
    const w = await ladderWorld()
    // A reading 30h before the next tick, higher than the baseline: the rise is measured from it.
    await w.afk.ok('status_tick', w.tick(0.68))
    w.clock.advance(DAY)
    // 34% then 40% used.
    const pressure = await w.paceTo(0.8)
    expect(pressure.burn_per_day).toBeCloseTo(6, 10)
  })

  it('never reports a negative burn', async () => {
    const { paceTo } = await ladderWorld()
    // 25% used, under the 30% baseline.
    expect((await paceTo(0.5)).burn_per_day).toBe(0)
  })

  it('has no burn while under 24h of readings', async () => {
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

  it('reports burn and ratio once a reading 24h old exists, without letting them set the rung', async () => {
    const w = world()
    const afk = await w.as('afk')
    const resets = new Date(w.clock.now() + 3.5 * DAY).toISOString()
    await afk.ok('status_tick', { ...base, weekly_used_percent: 30, weekly_resets_at: resets, reserve_percent: 35 })
    w.clock.advance(DAY)
    await afk.ok('status_tick', { ...base, weekly_used_percent: 41, weekly_resets_at: resets, reserve_percent: 34 })
    // 11 points over exactly 1 day against (100 - 41 - 34) / 2.5 = 10 a day; pace 41 / 64.3 = 0.64.
    const { pressure } = await afk.ok('status_read')
    expect(pressure.burn_per_day).toBeCloseTo(11, 10)
    expect(pressure.budget_ratio).toBeCloseTo(1.1, 10)
    expect(pressure.level).toBe('normal')
  })

  it('drives no rung from pace in the first day of the week: a few early points are not a trend', async () => {
    const w = world()
    const afk = await w.as('afk')
    // 12h into the week, 10% used: pace 1.4, but the week is too young to read.
    const resets = new Date(w.clock.now() + WEEK - 12 * HOUR).toISOString()
    await afk.ok('status_tick', { ...base, weekly_used_percent: 10, weekly_resets_at: resets })
    expect((await afk.ok('status_read')).pressure).toMatchObject({ level: 'normal', budget_rung: 'normal' })
    // A day in, the same pace counts.
    w.clock.advance(12 * HOUR)
    await afk.ok('status_tick', { ...base, weekly_used_percent: 20, weekly_resets_at: resets })
    expect((await afk.ok('status_read')).pressure.level).toBe('no_new_slots')
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

describe('ladder: hysteresis', () => {
  it('engages a rung only above its threshold, so a pace just under it from calm stays calm', async () => {
    const { paceTo } = await ladderWorld()
    expect((await paceTo(1.08)).level).toBe('normal')
    expect((await paceTo(1.12)).level).toBe('no_opus')
  })

  it('does not flap on the 25 Oct sequence: 1.09 to 1.12 around the 1.1 edge holds no_opus', async () => {
    const { paceTo } = await ladderWorld()
    const levels = []
    for (const pace of [1.09, 1.12, 1.09, 1.11, 1.09, 1.12]) levels.push((await paceTo(pace)).level)
    expect(levels).toEqual(['normal', 'no_opus', 'no_opus', 'no_opus', 'no_opus', 'no_opus'])
  })

  it.each([
    ['no_opus', 1.15, 1.07, 'no_opus', 1.04, 'normal'],
    ['no_new_slots', 1.3, 1.22, 'no_new_slots', 1.19, 'no_opus'],
    ['gate_only', 1.55, 1.47, 'gate_only', 1.44, 'no_new_slots'],
  ])('%s holds until the pace is below its threshold - 0.05', async (rung, engage, within, held, below, released) => {
    const { paceTo } = await ladderWorld()
    expect((await paceTo(engage)).level).toBe(rung)
    const heldPressure = await paceTo(within)
    expect(heldPressure.level).toBe(held)
    expect(heldPressure.budget_rung_held).toBe(true)
    const releasedPressure = await paceTo(below)
    expect(releasedPressure.level).toBe(released)
  })

  it('does not mark a rung held when the pace alone gives it', async () => {
    const { paceTo } = await ladderWorld()
    expect((await paceTo(1.15)).budget_rung_held).toBe(false)
  })

  it('a quiet tick_gate carries the rung forward without a flip', async () => {
    const { afk, paceTo, tick } = await ladderWorld()
    await paceTo(1.15)
    // 1.07 is inside the band: tick_gate sees the held rung, so no pressure change.
    expect(await afk.ok('tick_gate', tick(1.07))).toMatchObject({ changed: false, recorded: true })
    expect((await afk.ok('status_read')).pressure).toMatchObject({ level: 'no_opus', budget_rung_held: true })
  })

  it('a rung released between ticks does not hold into the next week', async () => {
    const w = await ladderWorld()
    await w.paceTo(1.15)
    w.clock.advance(5 * DAY)
    const fresh = new Date(w.clock.now() + WEEK - 1.5 * DAY).toISOString()
    // Pace 1.07 on the new week: inside the old rung's release band, but that rung belonged to the old week.
    await w.afk.ok('status_tick', { ...base, weekly_used_percent: 22.93, weekly_resets_at: fresh })
    expect((await w.afk.ok('status_read')).pressure).toMatchObject({ level: 'normal', budget_rung_held: false })
  })
})

describe('ladder: the effective level and cap', () => {
  it('is the stricter of the budget rung and the window ladder', async () => {
    const { afk, tick } = await ladderWorld()
    await afk.ok('status_tick', tick(1.15, { window_used_percent: 90 }))
    expect((await afk.ok('status_read')).pressure.level).toBe('no_new_slots')
    await afk.ok('status_tick', tick(1.55, { window_used_percent: 72 }))
    expect((await afk.ok('status_read')).pressure.level).toBe('gate_only')
    await afk.ok('status_tick', tick(0.5, { window_used_percent: 72 }))
    expect((await afk.ok('status_read')).pressure.level).toBe('no_opus')
  })

  it.each([
    [3, 0.8, 3],
    [3, 1.0, 3],
    [3, 1.15, 3],
    [undefined, 1.15, null],
    [undefined, 0.5, null],
    [0, 1.15, 0],
    [3, 1.3, 0],
    [3, 1.55, 0],
    [undefined, 1.3, 0],
  ])('a total cap of %s at pace %s is an effective cap of %s', async (cap, pace, expected) => {
    const { afk, tick } = await ladderWorld()
    await afk.ok('status_tick', tick(pace, cap === undefined ? {} : { total_cap: cap }))
    expect((await afk.ok('status_read')).pressure.effective_slot_cap).toBe(expected)
  })

  it('still reads the legacy weekly fields', async () => {
    const { afk, tick } = await ladderWorld()
    await afk.ok('status_tick', tick(0.7))
    expect((await afk.ok('status_read')).pressure).toMatchObject({ weekly_used_percent: 35, weekly_pace: expect.any(Number) })
  })

  it('takes slot_cap as the total cap from a caller that has not moved to total_cap', async () => {
    const { afk, tick } = await ladderWorld()
    await afk.ok('status_tick', tick(0.5, { slot_cap: 2 }))
    expect((await afk.ok('status_read')).slots.cap).toBe(2)
    await afk.ok('status_tick', tick(0.5, { slot_cap: 2, total_cap: 3 }))
    expect((await afk.ok('status_read')).slots.cap).toBe(3)
  })
})

describe('ladder: slot starts', () => {
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

  it('keeps the directives cap at no_opus: the rung limits the model, not the slot count', async () => {
    const { afk, tick } = await ladderWorld()
    await afk.ok('status_tick', tick(1.15, caps))
    await afk.ok('slot_start', { issue: issue(1), thread_id: 'w1', host: 'wsl2' })
    await afk.ok('slot_start', { issue: issue(2), thread_id: 'w2', host: 'homelab' })
    await afk.ok('slot_start', { issue: issue(3), thread_id: 'w3', host: 'wsl2' })
    expect((await afk.call('slot_start', { issue: issue(4), thread_id: 'w4', host: 'wsl2' })).isError).toBe(true)
  })

  it('refuses every start from no_new_slots up', async () => {
    const { afk, tick } = await ladderWorld()
    await afk.ok('status_tick', tick(1.3, caps))
    const refused = await afk.call('slot_start', { issue: issue(1), thread_id: 'w1', host: 'wsl2' })
    expect(refused.isError).toBe(true)
    expect(refused.content[0]?.text).toMatch(/pressure is no_new_slots/)
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

describe('ladder: the quiet-tick gate and wake', () => {
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
    await afk.ok('status_tick', tick(1.15))
    expect(await afk.ok('tick_gate', tick(1.07))).toMatchObject({ changed: false })
    expect(await afk.ok('tick_gate', tick(1.04))).toMatchObject({ changed: true, reasons: ['pressure'] })
  })
})
