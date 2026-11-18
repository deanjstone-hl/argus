import { describe, expect, it } from 'vitest'

import { AFK_THREAD, AQUILA_THREAD, MINUTE, TOKENS, text, world } from './helpers.js'

/**
 * argus#50: liveness counted only ticks, so a primary whose tick prompts queued behind a long owner
 * conversation read as dead and the homelab standby failed over a live thread (17 Nov 2026). A holder's
 * own writes (owner_turn, directives_set, child_*, slot writes) now count as seen, like a tick.
 */
const AFK_STANDBY = 'thread-afk-homelab'
const AQUILA_STANDBY = 'thread-aquila-homelab'
const ISSUE = 'deanjstone/argus#50'
const MINIMAL = { cadence_minutes: 30, max_slots: 2, repo_holds: [], take_next: [], ordering: [] }

const modelTick = (thread_id: string) => ({ thread_id, directives_version: 'v1', needs_owner: [] as string[], window_used_percent: 20 })

const check = (role: 'afk' | 'direction', thread_id: string, extra: Record<string, unknown> = {}) => ({
  role,
  host: 'wsl2',
  thread_id,
  directives_version: 'v1',
  needs_owner: [] as string[],
  window_used_percent: 20,
  ...(role === 'afk' ? { takeable: 0 } : {}),
  ...extra,
})

async function ticked() {
  const w = world()
  const afk = await w.as('afk')
  const aquila = await w.as('direction')
  await afk.ok('status_tick', modelTick(AFK_THREAD))
  await aquila.ok('status_tick', modelTick(AQUILA_THREAD))
  const wake = (body: Record<string, unknown>) => w.post('/wake/check', body, TOKENS[body.role as 'afk' | 'direction'])
  const standbyCheck = (role: 'afk' | 'direction') => wake(check(role, role === 'afk' ? AFK_STANDBY : AQUILA_STANDBY, { host: 'homelab' }))
  return { ...w, afk, aquila, wake, standbyCheck }
}

describe('liveness counts a holder that is working, not only one that ticks', () => {
  it('the 17 Nov outage: an owner conversation for over an hour with no tick is not a failover', async () => {
    const { aquila, clock, wake, standbyCheck } = await ticked()

    // 05:07 last tick. At 05:35 a wake goes out and its tick prompt queues behind the owner's conversation.
    clock.advance(28 * MINUTE)
    expect((await wake(check('direction', AQUILA_THREAD, { directives_version: 'v2' }))).body).toMatchObject({ wake: true })
    for (let turn = 0; turn < 8; turn++) {
      clock.advance(8 * MINUTE)
      await aquila.ok('owner_turn', { caller_thread_id: AQUILA_THREAD })
    }
    // 06:22: 93 min after the tick, the wake unanswered for 57 min.
    clock.advance(2 * MINUTE)

    expect((await standbyCheck('direction')).body).toEqual({ wake: false, reason: 'primary_alive', recorded: false })
    const status = await aquila.ok('status_read', { role: 'direction' })
    expect(status.liveness.state).not.toBe('stalled')
    expect(status.liveness.missed_ticks).toBeLessThan(2)
    const refused = await aquila.call('lease_failover', { role: 'direction', to_thread_id: AQUILA_STANDBY, from_thread_id: AQUILA_THREAD })
    expect(refused.isError).toBe(true)
    expect(text(refused)).toMatch(/not stalled/)
    expect((await aquila.ok('lease_read')).leases.direction.thread_id).toBe(AQUILA_THREAD)
  })

  it('a child_start or child_close by the direction holder counts', async () => {
    const { aquila, clock, standbyCheck } = await ticked()
    clock.advance(50 * MINUTE)
    await aquila.ok('child_start', { thread_id: 'child-1', purpose: 'research' })
    clock.advance(45 * MINUTE)
    expect((await standbyCheck('direction')).body).toMatchObject({ wake: false, reason: 'primary_alive' })

    await aquila.ok('child_close', { thread_id: 'child-1', outcome: 'complete' })
    clock.advance(45 * MINUTE)
    expect((await standbyCheck('direction')).body).toMatchObject({ wake: false, reason: 'primary_alive' })
  })

  it('a directives_set by the direction holder counts', async () => {
    const { aquila, clock, standbyCheck } = await ticked()
    clock.advance(10 * MINUTE)
    await aquila.ok('owner_turn', { caller_thread_id: AQUILA_THREAD })
    clock.advance(28 * MINUTE)
    await aquila.ok('directives_set', { record: MINIMAL, reason: 'test', expected_version: 0, caller_thread_id: AQUILA_THREAD })
    // 80 min on: 70 since the owner turn and the tick would be stalled, 42 since the directives write is not.
    clock.advance(42 * MINUTE)
    expect((await standbyCheck('direction')).body).toEqual({ wake: false, reason: 'primary_alive', recorded: false })
  })

  it('an AFK slot write by the afk holder counts for the afk lease, and not for the direction lease', async () => {
    const { afk, aquila, clock, standbyCheck } = await ticked()
    clock.advance(50 * MINUTE)
    await afk.ok('slot_start', { issue: ISSUE, thread_id: 'worker-1', caller_thread_id: AFK_THREAD })
    clock.advance(45 * MINUTE)

    expect((await standbyCheck('afk')).body).toMatchObject({ wake: false, reason: 'primary_alive' })
    expect((await afk.ok('status_read', { role: 'afk' })).liveness.state).not.toBe('stalled')
    expect((await standbyCheck('direction')).body).toEqual({ wake: true, reason: 'failover', recorded: false })
    expect((await aquila.ok('status_read', { role: 'direction' })).liveness.state).toBe('stalled')
  })

  it('is stalled again once the holder has neither ticked nor written for 2 cadence windows', async () => {
    const { aquila, clock, standbyCheck } = await ticked()
    clock.advance(50 * MINUTE)
    await aquila.ok('owner_turn', { caller_thread_id: AQUILA_THREAD })
    clock.advance(70 * MINUTE)

    expect((await standbyCheck('direction')).body).toEqual({ wake: true, reason: 'failover', recorded: false })
    expect((await aquila.ok('status_read', { role: 'direction' })).liveness.state).toBe('stalled')
    const failover = await aquila.ok('lease_failover', { role: 'direction', to_thread_id: AQUILA_STANDBY, from_thread_id: AQUILA_THREAD })
    expect(failover.lease.thread_id).toBe(AQUILA_STANDBY)
  })

  it('a write from a thread that does not hold the lease does not keep the holder alive', async () => {
    const { aquila, afk, clock, standbyCheck } = await ticked()
    clock.advance(70 * MINUTE)
    const stray = await aquila.call('owner_turn', { caller_thread_id: 'thread-stray' })
    expect(stray.isError).toBe(true)
    const strayAfk = await afk.call('slot_start', { issue: ISSUE, thread_id: 'worker-1', caller_thread_id: 'thread-stray' })
    expect(strayAfk.isError).toBe(true)

    expect((await standbyCheck('direction')).body).toMatchObject({ wake: true, reason: 'failover' })
    expect((await standbyCheck('afk')).body).toMatchObject({ wake: true, reason: 'failover' })
  })

  it("the old holder's earlier activity does not make a new holder look alive", async () => {
    const { aquila, clock } = await ticked()
    await aquila.ok('owner_turn', { caller_thread_id: AQUILA_THREAD })
    clock.advance(70 * MINUTE)
    await aquila.ok('lease_failover', { role: 'direction', to_thread_id: AQUILA_STANDBY, from_thread_id: AQUILA_THREAD })
    clock.advance(70 * MINUTE)

    const status = await aquila.ok('status_read', { role: 'direction' })
    expect(status.liveness.state).toBe('stalled')
  })

  it('status_read reports when the holder was last active', async () => {
    const { aquila, clock } = await ticked()
    clock.advance(50 * MINUTE)
    const before = await aquila.ok('status_read', { role: 'direction' })
    expect(before.last_activity_at).toBeNull()
    await aquila.ok('owner_turn', { caller_thread_id: AQUILA_THREAD })
    const after = await aquila.ok('status_read', { role: 'direction' })
    expect(after.last_activity_at).toBe(clock.iso())
  })
})
