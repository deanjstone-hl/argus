import { describe, expect, it } from 'vitest'

import { WAKE_REQUEST_COOLDOWN_MS } from '../src/store.js'
import { ladderWorld } from './ladder-world.js'
import { AFK_THREAD, AQUILA_THREAD, MINUTE, PROMOTION_TOKEN, world } from './helpers.js'

/**
 * argus#47: the ops hub's bearer reads nothing from loop-state, so POST /wake/request names the budget rung
 * itself, in the 200 and the 429 body, for the hub's Update dialog to say whether the filed issue will wait.
 * The rung is the AFK loop's last recorded tick: the row the slot gate enforces. The route still writes nothing.
 */
const ISSUE = 'deanjstone/argus#47'
const request = (issue = ISSUE) => ({ issue })

describe('POST /wake/request: the budget rung in the answer', () => {
  it('names normal and not held while the ladder is calm', async () => {
    const { post, paceTo } = await ladderWorld()
    await paceTo(0.5)
    expect(await post('/wake/request', request(), PROMOTION_TOKEN)).toEqual({
      status: 200,
      body: { recorded: true, budget_rung: 'normal', budget_rung_held: false },
    })
  })

  it.each([
    ['no_opus', 1.15],
    ['no_new_slots', 1.3],
    ['gate_only', 1.6],
  ])('names %s when the pace gives it', async (rung, pace) => {
    const { post, paceTo } = await ladderWorld()
    await paceTo(pace)
    expect((await post('/wake/request', request(), PROMOTION_TOKEN)).body).toEqual({ recorded: true, budget_rung: rung, budget_rung_held: false })
  })

  it('says a rung is held when hysteresis keeps it above what the pace alone gives', async () => {
    const { post, paceTo } = await ladderWorld()
    await paceTo(1.15)
    await paceTo(1.07)
    expect((await post('/wake/request', request(), PROMOTION_TOKEN)).body).toMatchObject({ budget_rung: 'no_opus', budget_rung_held: true })
  })

  it('carries the rung on a coalesced press, which is still a 200', async () => {
    const { post, paceTo } = await ladderWorld()
    await paceTo(1.3)
    await post('/wake/request', request(), PROMOTION_TOKEN)
    expect(await post('/wake/request', request(), PROMOTION_TOKEN)).toEqual({
      status: 200,
      body: { recorded: false, reason: 'pending', budget_rung: 'no_new_slots', budget_rung_held: false },
    })
  })

  it('carries the rung on the 429 body, beside the retry time', async () => {
    const { post, paceTo, as, clock } = await ladderWorld()
    const aquila = await as('direction')
    await paceTo(1.15)
    await post('/wake/request', request(), PROMOTION_TOKEN)
    await aquila.ok('status_tick', { thread_id: AQUILA_THREAD, directives_version: 'v1', needs_owner: [], window_used_percent: 20 })
    clock.advance(MINUTE)
    const refused = await post('/wake/request', request(), PROMOTION_TOKEN)
    expect(refused.status).toBe(429)
    expect(refused.body).toEqual({
      error: 'rate_limited',
      retry_after_seconds: (WAKE_REQUEST_COOLDOWN_MS - MINUTE) / 1000,
      budget_rung: 'no_opus',
      budget_rung_held: false,
    })
  })

  it('reads the rung from the latest AFK tick, so a pace that eases reads normal', async () => {
    const { post, paceTo, clock } = await ladderWorld()
    await paceTo(1.15)
    expect((await post('/wake/request', request(), PROMOTION_TOKEN)).body.budget_rung).toBe('no_opus')
    clock.advance(WAKE_REQUEST_COOLDOWN_MS)
    await paceTo(0.5)
    expect((await post('/wake/request', request('deanjstone/argus#48'), PROMOTION_TOKEN)).body).toMatchObject({
      budget_rung: 'normal',
      budget_rung_held: false,
    })
  })

  it('is null, not normal, when no weekly figure has been recorded: the ladder is unseen', async () => {
    const w = world()
    const afk = await w.as('afk')
    expect((await w.post('/wake/request', request(), PROMOTION_TOKEN)).body).toEqual({ recorded: true, budget_rung: null, budget_rung_held: false })
    await afk.ok('status_tick', { thread_id: AFK_THREAD, directives_version: 'v1', needs_owner: [], window_used_percent: 20 })
    expect((await w.post('/wake/request', request('deanjstone/argus#48'), PROMOTION_TOKEN)).body).toMatchObject({ budget_rung: null })
  })

  it('does not name the rung to a caller the route refuses', async () => {
    const { post, paceTo } = await ladderWorld()
    await paceTo(1.6)
    const refused = await post('/wake/request', request(), null)
    expect(refused).toEqual({ status: 401, body: { error: 'unauthorized' } })
  })

  it('writes no slot, lease or directive while reading the rung', async () => {
    const { post, paceTo, afk } = await ladderWorld()
    await paceTo(1.6)
    const before = { slots: await afk.ok('slot_list', {}), leases: await afk.ok('lease_read', {}), status: await afk.ok('status_read', {}) }
    await post('/wake/request', request(), PROMOTION_TOKEN)
    expect(await afk.ok('slot_list', {})).toEqual(before.slots)
    expect(await afk.ok('lease_read', {})).toEqual(before.leases)
    expect(await afk.ok('status_read', {})).toEqual(before.status)
  })
})
