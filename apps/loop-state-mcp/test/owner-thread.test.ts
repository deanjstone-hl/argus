import { describe, expect, it } from 'vitest'

import { AQUILA_THREAD, MINUTE, text, world } from './helpers.js'

// argus#54 / argus-config#1426: the split tick. A tick thread holds both leases, and the owner chat
// is registered on the lease record as `owner_thread_id` (one per host), so it may call owner_turn
// for presence and nothing else. An absent registration behaves exactly as before.

const OWNER = 'thread-owner-chat-0001'
const OWNER_HOMELAB = 'thread-owner-chat-homelab'
const STRAY = 'thread-stray'
const ISSUE = 'deanjstone/argus#54'
const tick = (thread_id: string) => ({ thread_id, directives_version: 'v1', needs_owner: [] as string[] })
const lastTurn = async (reader: { ok: (name: string) => Promise<any> }) => (await reader.ok('ledger_read')).owner

/** A world where the tick thread holds the direction lease, the owner is present, and OWNER is registered for wsl2. */
async function registered() {
  const w = world()
  const aquila = await w.as('direction', AQUILA_THREAD)
  await aquila.ok('owner_turn', { caller_thread_id: AQUILA_THREAD })
  await aquila.ok('owner_thread_set', { host: 'wsl2', thread_id: OWNER, caller_thread_id: AQUILA_THREAD })
  const owner = await w.as('direction', OWNER)
  return { ...w, aquila, owner }
}

describe('owner_thread_set', () => {
  it('registers a thread for a host, and lease_read shows it per host', async () => {
    const { aquila } = await registered()
    expect((await aquila.ok('lease_read')).owner_threads).toEqual({ wsl2: OWNER, homelab: null })
    await aquila.ok('owner_thread_set', { host: 'homelab', thread_id: OWNER_HOMELAB, caller_thread_id: AQUILA_THREAD })
    expect((await aquila.ok('lease_read')).owner_threads).toEqual({ wsl2: OWNER, homelab: OWNER_HOMELAB })
  })

  it('replaces the thread already registered for that host', async () => {
    const { aquila } = await registered()
    await aquila.ok('owner_thread_set', { host: 'wsl2', thread_id: 'thread-owner-chat-0002', caller_thread_id: AQUILA_THREAD })
    expect((await aquila.ok('lease_read')).owner_threads.wsl2).toBe('thread-owner-chat-0002')
  })

  it('is offered to the direction role only', async () => {
    const { as } = world()
    expect(await (await as('direction')).tools()).toContain('owner_thread_set')
    expect(await (await as('afk')).tools()).not.toContain('owner_thread_set')
    expect(await (await as('worker')).tools()).not.toContain('owner_thread_set')
  })

  it('is refused from a thread that is not the direction holder, naming the holder, and registers nothing', async () => {
    const { as } = world()
    const aquila = await as('direction', AQUILA_THREAD)
    await aquila.ok('owner_turn', { caller_thread_id: AQUILA_THREAD })
    const stray = await as('direction', STRAY)

    const result = await stray.call('owner_thread_set', { host: 'wsl2', thread_id: STRAY, caller_thread_id: STRAY })

    expect(result.isError).toBe(true)
    expect(text(result)).toContain(AQUILA_THREAD)
    expect((await aquila.ok('lease_read')).owner_threads).toBeUndefined()
  })

  it('is refused from the registered owner thread itself', async () => {
    const { owner, aquila } = await registered()
    const result = await owner.call('owner_thread_set', { host: 'wsl2', thread_id: STRAY, caller_thread_id: OWNER })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain(AQUILA_THREAD)
    expect((await aquila.ok('lease_read')).owner_threads.wsl2).toBe(OWNER)
  })

  it('must name the caller thread', async () => {
    const { as } = world()
    const aquila = await as('direction')
    await aquila.ok('owner_turn', { caller_thread_id: AQUILA_THREAD })
    const result = await aquila.call('owner_thread_set', { host: 'wsl2', thread_id: OWNER })
    expect(result.isError).toBe(true)
    expect(text(result)).toMatch(/caller_thread_id/)
  })

  it('is refused while the owner is not present, and registers nothing', async () => {
    const { as, clock } = world()
    const aquila = await as('direction', AQUILA_THREAD)
    const result = await aquila.call('owner_thread_set', { host: 'wsl2', thread_id: OWNER, caller_thread_id: AQUILA_THREAD })
    expect(result.isError).toBe(true)
    expect(text(result)).toMatch(/owner is not present/)

    await aquila.ok('owner_turn', { caller_thread_id: AQUILA_THREAD })
    clock.advance(31 * MINUTE)
    expect((await aquila.call('owner_thread_set', { host: 'wsl2', thread_id: OWNER, caller_thread_id: AQUILA_THREAD })).isError).toBe(true)
    expect((await aquila.ok('lease_read')).owner_threads).toBeUndefined()
  })

  it('is refused for a host that is not wsl2 or homelab', async () => {
    const { as } = world()
    const aquila = await as('direction', AQUILA_THREAD)
    await aquila.ok('owner_turn', { caller_thread_id: AQUILA_THREAD })
    const result = await aquila.call('owner_thread_set', { host: 'mars', thread_id: OWNER, caller_thread_id: AQUILA_THREAD })
    expect(result.isError).toBe(true)
  })

  it('survives a restart of the server', async () => {
    const { aquila, restart, as } = await registered()
    expect((await aquila.ok('lease_read')).owner_threads.wsl2).toBe(OWNER)
    restart()
    expect((await (await as('direction', AQUILA_THREAD)).ok('lease_read')).owner_threads.wsl2).toBe(OWNER)
  })
})

describe('owner_turn from the registered owner thread', () => {
  it('sets presence and hands over the since-you-left lines', async () => {
    const { owner, aquila, clock } = await registered()
    clock.advance(45 * MINUTE)
    await aquila.ok('away_note', { text: 'pending line' })
    expect((await lastTurn(aquila)).present).toBe(false)

    const result = await owner.ok('owner_turn', { caller_thread_id: OWNER })

    expect(result.warning).toBeUndefined()
    expect(result.since_you_left).toHaveLength(1)
    expect(await lastTurn(aquila)).toEqual({ last_turn_at: clock.iso(), present: true, stepped_away: false })
  })

  it('accepts stepping_away', async () => {
    const { owner, aquila } = await registered()
    await owner.ok('owner_turn', { caller_thread_id: OWNER, stepping_away: true })
    expect(await lastTurn(aquila)).toMatchObject({ present: false, stepped_away: true })
  })

  it('works with no caller_thread_id, the header being the caller', async () => {
    const { owner, aquila, clock } = await registered()
    clock.advance(45 * MINUTE)
    await owner.ok('owner_turn')
    expect(await lastTurn(aquila)).toMatchObject({ present: true })
  })

  it('is no activity of the lease holder: a stalled tick thread stays stalled', async () => {
    const { owner, aquila, clock } = await registered()
    await aquila.ok('status_tick', tick(AQUILA_THREAD))
    clock.advance(3 * 60 * MINUTE)
    await owner.ok('owner_turn', { caller_thread_id: OWNER })
    expect((await aquila.ok('status_read', { role: 'direction' })).liveness).toMatchObject({ state: 'stalled' })
  })

  it('still refuses an unregistered thread, naming the holder', async () => {
    const { as, aquila } = await registered()
    const stray = await as('direction', STRAY)
    const result = await stray.call('owner_turn', { caller_thread_id: STRAY })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain(AQUILA_THREAD)
    expect((await lastTurn(aquila)).last_turn_at).not.toBeNull()
  })

  it('does not accept the owner thread of a host once it is replaced', async () => {
    const { owner, aquila } = await registered()
    await aquila.ok('owner_thread_set', { host: 'wsl2', thread_id: 'thread-owner-chat-0002', caller_thread_id: AQUILA_THREAD })
    const result = await owner.call('owner_turn', { caller_thread_id: OWNER })
    expect(result.isError).toBe(true)
  })

  it("accepts the other host's registered owner thread too", async () => {
    const { as, aquila, clock } = await registered()
    await aquila.ok('owner_thread_set', { host: 'homelab', thread_id: OWNER_HOMELAB, caller_thread_id: AQUILA_THREAD })
    clock.advance(45 * MINUTE)
    const homelabOwner = await as('direction', OWNER_HOMELAB)
    await homelabOwner.ok('owner_turn', { caller_thread_id: OWNER_HOMELAB })
    expect(await lastTurn(aquila)).toMatchObject({ present: true })
  })
})

describe('every other loop-state write from the owner thread is refused, naming the holder', () => {
  const FAILOVER = { role: 'direction', to_thread_id: 'thread-standby', from_thread_id: AQUILA_THREAD }
  const calls: [string, Record<string, unknown>][] = [
    ['tick_gate', { ...tick(OWNER) }],
    ['status_tick', { ...tick(OWNER) }],
    ['slot_unpark', { issue: ISSUE }],
    ['slot_resume_ci', { issue: ISSUE }],
    ['slot_rebuild', { issues: [], threads: [], apply: true }],
    ['lease_move', { role: 'direction', to_thread_id: OWNER, from_thread_id: AQUILA_THREAD, old_schedule_task_deleted: true }],
    ['lease_release', { role: 'direction', from_thread_id: AQUILA_THREAD, old_schedule_task_deleted: true }],
    ['lease_failover', FAILOVER],
    ['lease_reclaim', FAILOVER],
    ['directives_set', { record: {}, reason: 'x', expected_version: 0, caller_thread_id: OWNER }],
    ['child_start', { thread_id: 'child-1', purpose: 'x' }],
    ['child_close', { thread_id: 'child-1', outcome: 'done' }],
    ['away_note', { text: 'x' }],
    ['notify_claim', { class: 'stall', items: ['x'] }],
    ['outage_observe', { stalled: false }],
  ]

  it.each(calls)('%s', async (name, args) => {
    const { owner, aquila } = await registered()
    const before = await aquila.ok('lease_read')

    const result = await owner.call(name, args)

    expect(result.isError, name).toBe(true)
    expect(text(result), name).toContain(AQUILA_THREAD)
    expect(await aquila.ok('lease_read'), name).toEqual(before)
  })

  it('records nothing from a refused tick, and leaves a lease_conflict for the holder\'s gate', async () => {
    const { owner, aquila } = await registered()
    await aquila.ok('status_tick', tick(AQUILA_THREAD))
    await owner.call('status_tick', tick(OWNER))
    expect(await aquila.ok('tick_gate', tick(AQUILA_THREAD))).toMatchObject({ changed: true, reasons: ['lease_conflict'] })
  })

  it('is refused when the call names the owner thread but the header is absent', async () => {
    const { as, aquila } = await registered()
    const headerless = await as('direction')
    const result = await headerless.call('tick_gate', tick(OWNER))
    expect(result.isError).toBe(true)
    expect(text(result)).toContain(AQUILA_THREAD)
    expect((await aquila.ok('lease_read')).leases.direction.thread_id).toBe(AQUILA_THREAD)
  })

  it('leaves the tick thread able to call all of them', async () => {
    const { aquila } = await registered()
    expect((await aquila.call('tick_gate', tick(AQUILA_THREAD))).isError).toBeFalsy()
    expect((await aquila.call('away_note', { text: 'x' })).isError).toBeFalsy()
    expect((await aquila.call('status_tick', tick(AQUILA_THREAD))).isError).toBeFalsy()
  })

  it('reads stay open to the owner thread', async () => {
    const { owner } = await registered()
    for (const name of ['lease_read', 'ledger_read', 'status_read', 'slot_list', 'directives_read']) {
      expect((await owner.call(name)).isError, name).toBeFalsy()
    }
  })
})

describe('the lease tools leave owner_thread_id alone', () => {
  it('lease_move keeps it', async () => {
    const { aquila } = await registered()
    await aquila.ok('lease_move', { role: 'direction', to_thread_id: 'thread-tick-2', from_thread_id: AQUILA_THREAD, old_schedule_task_deleted: true })
    const read = await aquila.ok('lease_read')
    expect(read.leases.direction.thread_id).toBe('thread-tick-2')
    expect(read.owner_threads).toEqual({ wsl2: OWNER, homelab: null })
  })

  it('lease_release keeps it, and the next lease_move still finds it', async () => {
    const { aquila, as } = await registered()
    await aquila.ok('lease_release', { role: 'direction', from_thread_id: AQUILA_THREAD, old_schedule_task_deleted: true })
    const next = await as('direction', 'thread-tick-2')
    await next.ok('lease_move', { role: 'direction', to_thread_id: 'thread-tick-2' })
    expect((await next.ok('lease_read')).owner_threads.wsl2).toBe(OWNER)
  })

  it('lease_failover and lease_reclaim keep it, and the owner thread still counts after each', async () => {
    const { as, aquila, owner, clock } = await registered()
    await aquila.ok('status_tick', tick(AQUILA_THREAD))
    clock.advance(3 * 60 * MINUTE)
    const standby = await as('direction', 'thread-standby')
    await standby.ok('lease_failover', { role: 'direction', to_thread_id: 'thread-standby', from_thread_id: AQUILA_THREAD })
    expect((await standby.ok('lease_read')).owner_threads.wsl2).toBe(OWNER)
    expect((await owner.call('owner_turn', { caller_thread_id: OWNER })).isError).toBeFalsy()

    await aquila.ok('lease_reclaim', { role: 'direction', to_thread_id: AQUILA_THREAD, from_thread_id: 'thread-standby' })
    expect((await aquila.ok('lease_read')).owner_threads.wsl2).toBe(OWNER)
    expect((await owner.call('owner_turn', { caller_thread_id: OWNER })).isError).toBeFalsy()
  })
})

describe('with no owner_thread_id registered', () => {
  it('lease_read has no owner_threads key, and every refusal reads as before', async () => {
    const { as } = world()
    const aquila = await as('direction', AQUILA_THREAD)
    expect((await aquila.ok('lease_read')).owner_threads).toBeUndefined()

    const stray = await as('direction', STRAY)
    const turn = await stray.call('owner_turn', { caller_thread_id: STRAY })
    expect(turn.isError).toBe(true)
    expect(text(turn)).toMatch(/direction lease/)
    // an unregistered thread's lease writes are not stopped by this feature: as before, they are the lease's own checks
    expect((await stray.call('away_note', { text: 'x' })).isError).toBeFalsy()
  })
})
