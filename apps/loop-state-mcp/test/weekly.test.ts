import { DatabaseSync } from 'node:sqlite'

import { describe, expect, it } from 'vitest'

import { MIGRATIONS } from '../src/store.js'
import { AFK_THREAD, MIGRATION_TEST_TIMEOUT_MS, MINUTE, TOKENS, tempDbPath, world } from './helpers.js'
import { DAY, base, ladderWorld } from './ladder-world.js'

/**
 * The weekly figures around the remaining-budget ladder (argus#871): how they combine with the
 * window ladder, carry through the quiet-tick gate and the wake check, gate slot starts, and
 * validate. The ladder's own edges and hysteresis are in ladder.test.ts.
 */
const calm = { ...base, window_used_percent: 20 }

describe('the budget ladder beside the window ladder', () => {
  it('takes the weekly level when the window is unknown, and stays unknown when the week is fine', async () => {
    const { afk, tick } = await ladderWorld()
    const { window_used_percent: _window, ...weeklyOnly } = tick(10.5)
    await afk.ok('status_tick', weeklyOnly)
    expect((await afk.ok('status_read')).pressure.level).toBe('no_opus')
    const { window_used_percent: _calm, ...fine } = tick(5)
    await afk.ok('status_tick', fine)
    expect((await afk.ok('status_read')).pressure.level).toBe('unknown')
  })

  it('a window pressure level given alone is the window side of the comparison', async () => {
    const { afk, tick } = await ladderWorld()
    const { window_used_percent: _window, ...weeklyOnly } = tick(10.5)
    await afk.ok('status_tick', { ...weeklyOnly, pressure: 'no_new_slots' })
    expect((await afk.ok('status_read')).pressure.level).toBe('no_new_slots')
  })

  it('is the directives cap when no weekly figure was sent', async () => {
    const { as } = world()
    const afk = await as('afk')
    await afk.ok('status_tick', { ...base, slot_cap: 2 })
    expect((await afk.ok('status_read')).pressure).toMatchObject({
      effective_slot_cap: 2,
      weekly_used_percent: null,
      weekly_pace: null,
      budget_ratio: null,
      budget_rung: null,
    })
  })

  it('reads null weekly fields from a loop that never ticked', async () => {
    const { as } = world()
    const aquila = await as('direction')
    expect((await aquila.ok('status_read')).pressure).toMatchObject({
      level: 'unknown',
      weekly_used_percent: null,
      weekly_pace: null,
      burn_per_day: null,
      allowance_per_day: null,
      budget_ratio: null,
      effective_slot_cap: null,
    })
  })
})

describe('slot starts under the budget ladder', () => {
  it('refuses a start past the effective cap, and allows one under it', async () => {
    const { afk, tick } = await ladderWorld()
    await afk.ok('status_tick', tick(10.5, { slot_cap: 2 }))
    await afk.ok('slot_start', { issue: 'deanjstone/argus#1', thread_id: 'w1' })
    const refused = await afk.call('slot_start', { issue: 'deanjstone/argus#2', thread_id: 'w2' })
    expect(refused.isError).toBe(true)
    expect(refused.content[0]?.text).toMatch(/effective slot cap 1/)
    expect((await afk.ok('slot_list')).slots).toHaveLength(1)
  })

  it('allows the second slot once the week is back under budget', async () => {
    const { afk, tick } = await ladderWorld()
    await afk.ok('status_tick', tick(5, { slot_cap: 2 }))
    await afk.ok('slot_start', { issue: 'deanjstone/argus#1', thread_id: 'w1' })
    expect((await afk.call('slot_start', { issue: 'deanjstone/argus#2', thread_id: 'w2' })).isError).toBeFalsy()
  })

  it.each([
    ['budget no_new_slots', { burn: 12.5 }],
    ['budget gate_only', { burn: 16 }],
    ['window no_new_slots', { burn: 5, window: 86 }],
  ])('refuses any start at %s, even with no slot running', async (_name, { burn, window }: { burn: number; window?: number }) => {
    const { afk, tick } = await ladderWorld()
    await afk.ok('status_tick', tick(burn, { slot_cap: 2, ...(window === undefined ? {} : { window_used_percent: window }) }))
    const refused = await afk.call('slot_start', { issue: 'deanjstone/argus#1', thread_id: 'w1' })
    expect(refused.isError).toBe(true)
    expect(refused.content[0]?.text).toMatch(/no_new_slots|gate_only/)
  })

  it('allows a start before any tick has set a cap', async () => {
    const { as } = world()
    const afk = await as('afk')
    expect((await afk.call('slot_start', { issue: 'deanjstone/argus#1', thread_id: 'w1' })).isError).toBeFalsy()
  })
})

describe('the budget ladder and the quiet-tick gate', () => {
  it('a change in the rung is a pressure change, and a move inside a band is not', async () => {
    const { afk, tick } = await ladderWorld()
    await afk.ok('status_tick', tick(5))
    expect(await afk.ok('tick_gate', tick(7))).toMatchObject({ changed: false, recorded: true })
    expect(await afk.ok('tick_gate', tick(10.5))).toMatchObject({ changed: true, reasons: ['pressure'], recorded: false })
  })

  it('a quiet tick that omits the weekly fields carries them forward and sees no change', async () => {
    const { afk, tick } = await ladderWorld()
    await afk.ok('status_tick', tick(10.5, { slot_cap: 2 }))
    expect(await afk.ok('tick_gate', { ...base, window_used_percent: 41 })).toMatchObject({ changed: false, recorded: true })
    expect((await afk.ok('status_read')).pressure).toMatchObject({
      level: 'no_opus',
      window_used_percent: 41,
      weekly_used_percent: 40.5,
      effective_slot_cap: 1,
    })
  })

  it('a quiet tick with weekly fields but no window figure keeps the window side from the last tick', async () => {
    const { afk, tick } = await ladderWorld()
    await afk.ok('status_tick', tick(5, { window_used_percent: 90 }))
    const { window_used_percent: _window, ...weeklyOnly } = tick(5.5)
    expect(await afk.ok('tick_gate', weeklyOnly)).toMatchObject({ changed: false, recorded: true })
    expect((await afk.ok('status_read')).pressure).toMatchObject({ level: 'no_new_slots', window_used_percent: 90 })
  })

  it('a week that eases as time passes is seen by the next carry-forward, with no new weekly figure', async () => {
    const { afk, tick, clock } = await ladderWorld()
    await afk.ok('status_tick', tick(10.5))
    expect((await afk.ok('status_read')).pressure.level).toBe('no_opus')
    clock.advance(DAY)
    expect(await afk.ok('tick_gate', { ...base })).toMatchObject({ changed: true, reasons: ['pressure'] })
  })
})

describe('a stale weekly figure', () => {
  it('stops counting once its week has reset and the caller has sent no new figure', async () => {
    const { as, clock } = world()
    const afk = await as('afk')
    await afk.ok('status_tick', { ...calm, weekly_used_percent: 95, weekly_resets_at: new Date(clock.now() + 3.5 * DAY).toISOString() })
    expect((await afk.ok('status_read')).pressure.level).toBe('gate_only')
    clock.advance(4 * DAY)
    expect(await afk.ok('tick_gate', { ...base, window_used_percent: 20 })).toMatchObject({ changed: true, reasons: ['pressure'] })
    await afk.ok('status_tick', { ...base, window_used_percent: 20 })
    expect((await afk.ok('status_read')).pressure).toMatchObject({ level: 'normal', weekly_used_percent: null })
  })
})

describe('weekly fields are validated', () => {
  it.each([
    ['weekly_used_percent alone', { weekly_used_percent: 40 }, /together/],
    ['weekly_resets_at alone', { weekly_resets_at: '2026-10-22T00:00:00Z' }, /together/],
    ['a percentage over 100', { weekly_used_percent: 101, weekly_resets_at: '2026-10-22T00:00:00Z' }, /weekly_used_percent/],
    ['a negative percentage', { weekly_used_percent: -1, weekly_resets_at: '2026-10-22T00:00:00Z' }, /weekly_used_percent/],
    ['a reset time that is not a date', { weekly_used_percent: 40, weekly_resets_at: 'next friday' }, /weekly_resets_at/],
  ])('refuses %s', async (_name, fields, message) => {
    const { as } = world()
    const afk = await as('afk')
    for (const tool of ['status_tick', 'tick_gate']) {
      const result = await afk.call(tool, { ...base, ...fields })
      expect(result.isError).toBe(true)
      expect(result.content[0]?.text).toMatch(message)
    }
  })

  it('treats a reset time in the past as a finished week: no ratio, and the pace is used over 100%', async () => {
    const { as, clock } = world()
    const afk = await as('afk')
    await afk.ok('status_tick', { ...calm, weekly_used_percent: 60, weekly_resets_at: new Date(clock.now() - DAY).toISOString() })
    expect((await afk.ok('status_read')).pressure).toMatchObject({ level: 'normal', weekly_pace: 0.6, budget_ratio: null })
  })
})

describe('POST /wake/check with the weekly fields', () => {
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
  /** The weekly fields of a tick at `burn`, as the wake check takes them. */
  const weeklyFields = (tick: Record<string, unknown>) => ({
    weekly_used_percent: tick.weekly_used_percent,
    weekly_resets_at: tick.weekly_resets_at,
    reserve_percent: tick.reserve_percent,
  })

  it('accepts weekly_used_percent, weekly_resets_at and reserve_percent', async () => {
    const { afk, tick, post } = await ladderWorld()
    await afk.ok('status_tick', tick(5, { slot_cap: 2 }))
    const result = await post('/wake/check', check(weeklyFields(tick(5))), TOKENS.afk)
    expect(result.status).toBe(200)
    expect(result.body).toMatchObject({ wake: true, reason: 'free_slot' })
  })

  it('wakes on a rung change once it has held for the pressure dwell (argus#1167)', async () => {
    const { afk, tick, post, clock } = await ladderWorld()
    await afk.ok('status_tick', tick(5, { slot_cap: 2 }))
    const poll = () => post('/wake/check', check({ ...weeklyFields(tick(10.5)), takeable: 0 }), TOKENS.afk)
    expect((await poll()).body).toMatchObject({ wake: false, reason: 'quiet' })
    clock.advance(20 * MINUTE)
    expect((await poll()).body).toMatchObject({ wake: true, reason: 'changed:pressure' })
  })

  it('a rung change that opens a free slot wakes for the slot at once (argus#1167)', async () => {
    const { afk, tick, post } = await ladderWorld()
    await afk.ok('status_tick', tick(5, { slot_cap: 2 }))
    expect((await post('/wake/check', check(weeklyFields(tick(10.5))), TOKENS.afk)).body).toMatchObject({ wake: true, reason: 'free_slot' })
  })

  it('does not wake for a free slot at budget no_new_slots', async () => {
    const { afk, tick, post, clock } = await ladderWorld()
    await afk.ok('status_tick', tick(12.5, { slot_cap: 2 }))
    clock.advance(MINUTE)
    expect((await post('/wake/check', check(weeklyFields(tick(12.5))), TOKENS.afk)).body).toEqual({ wake: false, reason: 'quiet', recorded: true })
  })

  it('does not wake for a second slot past the rung cap of 1', async () => {
    const { afk, tick, post, clock } = await ladderWorld()
    await afk.ok('slot_start', { issue: 'deanjstone/argus#1', thread_id: 'w1' })
    await afk.ok('status_tick', tick(10.5, { slot_cap: 2 }))
    clock.advance(MINUTE)
    expect((await post('/wake/check', check(weeklyFields(tick(10.5))), TOKENS.afk)).body).toEqual({ wake: false, reason: 'quiet', recorded: true })
  })

  it('refuses a half-given weekly pair with a 400', async () => {
    const { as, post } = world()
    await as('afk')
    expect((await post('/wake/check', check({ weekly_used_percent: 50 }), TOKENS.afk)).status).toBe(400)
  })

  it('refuses a reserve outside 0 to 100 with a 400', async () => {
    const { as, post } = world()
    await as('afk')
    expect((await post('/wake/check', check({ reserve_percent: 100 }), TOKENS.afk)).status).toBe(400)
  })
})

describe('schema migration for the weekly and budget columns', { timeout: MIGRATION_TEST_TIMEOUT_MS }, () => {
  it('upgrades a db at the previous schema, keeping its window level so the gate sees no change', async () => {
    const path = tempDbPath()
    const previous = new DatabaseSync(path)
    for (const step of MIGRATIONS.slice(0, MIGRATIONS.length - 1)) previous.exec(step as string)
    previous.exec(`PRAGMA user_version = ${MIGRATIONS.length - 1}`)
    const tickedAt = Date.parse('2026-10-17T23:45:00Z')
    previous.prepare("INSERT INTO leases (role, thread_id, moved_at, primary_thread_id) VALUES ('afk', ?, 1, ?)").run(AFK_THREAD, AFK_THREAD)
    previous
      .prepare(
        `INSERT INTO loop_status (role, thread_id, last_tick_at, event_cursor, directives_version, needs_owner, slot_cap, errors, pressure, window_used_percent)
         VALUES ('afk', ?, ?, 0, 'v1', '[]', 2, '[]', 'no_opus', 72)`,
      )
      .run(AFK_THREAD, tickedAt)
    previous.close()

    const { as, clock } = world({ path, leases: {} })
    const afk = await as('afk')
    const weekly = (used: number) => ({ weekly_used_percent: used, weekly_resets_at: new Date(clock.now() + 3.5 * DAY).toISOString() })
    expect((await afk.ok('status_read')).pressure).toMatchObject({
      level: 'no_opus',
      window_used_percent: 72,
      weekly_used_percent: null,
      weekly_pace: null,
      effective_slot_cap: 2,
    })
    expect(await afk.ok('tick_gate', { ...base, window_used_percent: 73 })).toMatchObject({ changed: false, recorded: true })
    expect(await afk.ok('tick_gate', { ...base, window_used_percent: 73, ...weekly(95) })).toMatchObject({ changed: true, reasons: ['pressure'] })
  })
  it('reads the weekly figures a db at the previous schema recorded, and carries them into the ladder', async () => {
    const path = tempDbPath()
    const previous = new DatabaseSync(path)
    for (const step of MIGRATIONS.slice(0, MIGRATIONS.length - 1)) previous.exec(step as string)
    previous.exec(`PRAGMA user_version = ${MIGRATIONS.length - 1}`)
    const { clock } = world()
    previous.prepare("INSERT INTO leases (role, thread_id, moved_at, primary_thread_id) VALUES ('afk', ?, 1, ?)").run(AFK_THREAD, AFK_THREAD)
    previous
      .prepare(
        `INSERT INTO loop_status (role, thread_id, last_tick_at, event_cursor, directives_version, needs_owner, slot_cap, errors, pressure,
                                  window_used_percent, window_level, weekly_used_percent, weekly_resets_at, weekly_pace)
         VALUES ('afk', ?, ?, 0, 'v1', '[]', 2, '[]', 'no_opus', 40, 'normal', 55, ?, 1.2)`,
      )
      .run(AFK_THREAD, clock.now(), clock.now() + 3.5 * DAY)
    previous.close()

    const { as } = world({ path, leases: {} })
    const afk = await as('afk')
    const { pressure, slots } = await afk.ok('status_read')
    // The old fields still read; the new ones are empty until the next tick fills them.
    expect(pressure).toMatchObject({ weekly_used_percent: 55, weekly_pace: 1.2, burn_per_day: null, budget_rung: 'normal', effective_slot_cap: 2 })
    expect(slots.hosts).toEqual({ wsl2: { used: 0, cap: null }, homelab: { used: 0, cap: null } })
  })
})
