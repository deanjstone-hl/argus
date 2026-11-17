import { describe, expect, it } from 'vitest'

import { AFK_THREAD, MINUTE, TOKENS } from './helpers.js'
import { ladderWorld } from './ladder-world.js'

/**
 * argus#1171: an issue labelled efficiency:orchestrator starts with `budget_exempt: true`. It is
 * allowed through no_new_slots, refused at gate_only, keeps one running exempt slot, and sits
 * outside the total, effective and host caps. Burn 13 puts the ladder at no_new_slots, 16 at gate_only.
 */
const issue = (n: number) => `deanjstone/argus#${n}`

describe('slot_start budget_exempt', () => {
  it('starts at no_new_slots, and a start without it is still refused there', async () => {
    const { afk, tick } = await ladderWorld()
    await afk.ok('status_tick', tick(13, { total_cap: 3 }))
    expect((await afk.call('slot_start', { issue: issue(1), thread_id: 'w1' })).content[0]?.text).toMatch(/no_new_slots/)
    const started = await afk.ok('slot_start', { issue: issue(2), thread_id: 'w2', budget_exempt: true })
    expect(started.slot).toMatchObject({ issue: issue(2), state: 'running', budget_exempt: true })
  })

  it('is refused at gate_only', async () => {
    const { afk, tick } = await ladderWorld()
    await afk.ok('status_tick', tick(16, { total_cap: 3 }))
    const refused = await afk.call('slot_start', { issue: issue(1), thread_id: 'w1', budget_exempt: true })
    expect(refused.isError).toBe(true)
    expect(refused.content[0]?.text).toMatch(/gate_only/)
  })

  it('refuses a second exempt start while one runs, and allows it once the first closes', async () => {
    const { afk, tick } = await ladderWorld()
    await afk.ok('status_tick', tick(13, { total_cap: 3 }))
    await afk.ok('slot_start', { issue: issue(1), thread_id: 'w1', budget_exempt: true })
    const refused = await afk.call('slot_start', { issue: issue(2), thread_id: 'w2', budget_exempt: true })
    expect(refused.isError).toBe(true)
    expect(refused.content[0]?.text).toMatch(/deanjstone\/argus#1 already runs a budget-exempt slot/)
    await afk.ok('slot_close', { issue: issue(1), verified: 'Verified: verify-claim merged #1 ok; CI run 123 green' })
    expect((await afk.call('slot_start', { issue: issue(2), thread_id: 'w2', budget_exempt: true })).isError).toBeFalsy()
  })

  it('does not count toward the total, effective or host caps, and is not held to them', async () => {
    const { afk, tick } = await ladderWorld()
    await afk.ok('status_tick', tick(10.5, { total_cap: 1, host_caps: { wsl2: 1, homelab: 1 } }))
    await afk.ok('slot_start', { issue: issue(1), thread_id: 'w1' })
    // The cap of 1 is full, yet the exempt start goes through.
    await afk.ok('slot_start', { issue: issue(2), thread_id: 'w2', budget_exempt: true })
    // And once the plain slot closes, the running exempt slot does not fill the cap against a plain start.
    await afk.ok('slot_close', { issue: issue(1), verified: 'Verified: verify-claim merged #1 ok; CI run 123 green' })
    expect((await afk.call('slot_start', { issue: issue(3), thread_id: 'w3' })).isError).toBeFalsy()
    const refused = await afk.call('slot_start', { issue: issue(4), thread_id: 'w4' })
    expect(refused.content[0]?.text).toMatch(/effective slot cap 1 is reached \(1 running\)/)
  })

  it('shows budget_exempt in slot_list and the running count in status_read', async () => {
    const { afk, tick } = await ladderWorld()
    await afk.ok('status_tick', tick(0, { total_cap: 3 }))
    await afk.ok('slot_start', { issue: issue(1), thread_id: 'w1' })
    await afk.ok('slot_start', { issue: issue(2), thread_id: 'w2', budget_exempt: true })
    const list = await afk.ok('slot_list')
    const flags = Object.fromEntries((list.slots as { issue: string; budget_exempt: boolean }[]).map((slot) => [slot.issue, slot.budget_exempt]))
    expect(flags).toEqual({ [issue(1)]: false, [issue(2)]: true })
    expect((await afk.ok('status_read')).slots.budget_exempt_running).toBe(1)
  })
})

describe('budget_exempt: POST /wake/check', () => {
  const body = { role: 'afk', host: 'wsl2', thread_id: AFK_THREAD, directives_version: 'v1', needs_owner: [] as string[], window_used_percent: 20, takeable: 3 }

  it('wakes at no_new_slots for a takeable exempt issue, and stays quiet without one', async () => {
    const { afk, tick, post, clock } = await ladderWorld()
    await afk.ok('status_tick', tick(13, { total_cap: 3 }))
    clock.advance(5 * MINUTE)
    expect((await post('/wake/check', body, TOKENS.afk)).body).toMatchObject({ wake: false })
    expect((await post('/wake/check', { ...body, takeable_exempt: 1 }, TOKENS.afk)).body).toMatchObject({ wake: true, reason: 'free_slot' })
  })

  it('stays quiet at gate_only and while an exempt slot already runs', async () => {
    const { afk, tick, post, clock } = await ladderWorld()
    await afk.ok('status_tick', tick(16, { total_cap: 3 }))
    clock.advance(5 * MINUTE)
    expect((await post('/wake/check', { ...body, takeable_exempt: 1 }, TOKENS.afk)).body).toMatchObject({ wake: false })

    await afk.ok('status_tick', tick(13, { total_cap: 3 }))
    await afk.ok('slot_start', { issue: issue(1), thread_id: 'w1', budget_exempt: true })
    await afk.ok('status_tick', tick(13, { total_cap: 3 }))
    clock.advance(5 * MINUTE)
    expect((await post('/wake/check', { ...body, takeable_exempt: 1 }, TOKENS.afk)).body).toMatchObject({ wake: false })
  })

  it.each([[-1], [1.5], ['1']])('refuses takeable_exempt %j', async (bad) => {
    const { afk, tick, post, clock } = await ladderWorld()
    await afk.ok('status_tick', tick(13, { total_cap: 3 }))
    clock.advance(5 * MINUTE)
    expect((await post('/wake/check', { ...body, takeable_exempt: bad }, TOKENS.afk)).status).toBeGreaterThanOrEqual(400)
  })
})
