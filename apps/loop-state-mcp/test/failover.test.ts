import { describe, expect, it } from 'vitest'

import { AFK_THREAD, AQUILA_THREAD, MINUTE, text, world } from './helpers.js'

/** The homelab standbys: they take a lease only while the WSL2 primary is stalled, and hand it back. */
const AFK_STANDBY = 'thread-afk-homelab'
const AQUILA_STANDBY = 'thread-aquila-homelab'
const tick = (thread_id: string) => ({ thread_id, directives_version: 'v1', needs_owner: [] as string[] })

describe('lease failover to a standby', () => {
  it('records the primary on a normal move, and lease_read shows it', async () => {
    const { as, clock } = world()
    const afk = await as('afk')
    expect((await afk.ok('lease_read')).leases.afk).toEqual({ thread_id: AFK_THREAD, since: clock.iso(), primary_thread_id: AFK_THREAD, primary_host: null })
  })

  it('refuses failover while the holder is alive or only late', async () => {
    const { as, clock } = world()
    const afk = await as('afk')
    await afk.ok('status_tick', tick(AFK_THREAD))

    const alive = await afk.call('lease_failover', { role: 'afk', to_thread_id: AFK_STANDBY, from_thread_id: AFK_THREAD })
    expect(alive.isError).toBe(true)
    expect(text(alive)).toMatch(/not stalled/)

    clock.advance(40 * MINUTE)
    const late = await afk.call('lease_failover', { role: 'afk', to_thread_id: AFK_STANDBY, from_thread_id: AFK_THREAD })
    expect(late.isError).toBe(true)
    expect((await afk.ok('lease_read')).leases.afk.thread_id).toBe(AFK_THREAD)
  })

  it('moves the lease to the standby once the holder is stalled, keeping the primary', async () => {
    const { as, clock } = world()
    const afk = await as('afk')
    await afk.ok('status_tick', tick(AFK_THREAD))
    clock.advance(70 * MINUTE)

    const moved = await afk.ok('lease_failover', { role: 'afk', to_thread_id: AFK_STANDBY, from_thread_id: AFK_THREAD })
    expect(moved.lease).toMatchObject({ thread_id: AFK_STANDBY, primary_thread_id: AFK_THREAD })
    expect(await afk.ok('status_tick', tick(AFK_STANDBY))).toMatchObject({ recorded: true, holds_lease: true })
    expect(await afk.ok('status_tick', tick(AFK_THREAD))).toMatchObject({ recorded: false, holds_lease: false, lease_holder: AFK_STANDBY })
  })

  it('treats a holder that never ticked as stalled from when it took the lease', async () => {
    const { as, clock } = world()
    const afk = await as('afk')
    clock.advance(70 * MINUTE)
    await afk.ok('lease_failover', { role: 'afk', to_thread_id: AFK_STANDBY, from_thread_id: AFK_THREAD })
    expect((await afk.ok('lease_read')).leases.afk.thread_id).toBe(AFK_STANDBY)
  })

  it('refuses failover naming the wrong holder, and lets each role fail over only its own lease', async () => {
    const { as, clock } = world()
    const afk = await as('afk')
    const aquila = await as('direction')
    const worker = await as('worker')
    clock.advance(70 * MINUTE)

    expect((await afk.call('lease_failover', { role: 'afk', to_thread_id: AFK_STANDBY, from_thread_id: 'thread-x' })).isError).toBe(true)
    expect((await afk.call('lease_failover', { role: 'direction', to_thread_id: AQUILA_STANDBY, from_thread_id: AQUILA_THREAD })).isError).toBe(true)
    expect((await worker.call('lease_failover', { role: 'afk', to_thread_id: AFK_STANDBY, from_thread_id: AFK_THREAD })).isError).toBe(true)

    await aquila.ok('lease_failover', { role: 'direction', to_thread_id: AQUILA_STANDBY, from_thread_id: AQUILA_THREAD })
    expect((await aquila.ok('lease_read')).leases.direction).toMatchObject({ thread_id: AQUILA_STANDBY, primary_thread_id: AQUILA_THREAD })
  })

  it('hands the lease back to the primary at any time, and only to the primary', async () => {
    const { as, clock } = world()
    const afk = await as('afk')
    clock.advance(70 * MINUTE)
    await afk.ok('lease_failover', { role: 'afk', to_thread_id: AFK_STANDBY, from_thread_id: AFK_THREAD })
    await afk.ok('status_tick', tick(AFK_STANDBY))

    const stranger = await afk.call('lease_reclaim', { role: 'afk', to_thread_id: 'thread-x', from_thread_id: AFK_STANDBY })
    expect(stranger.isError).toBe(true)
    expect(text(stranger)).toMatch(/primary/)

    const back = await afk.ok('lease_reclaim', { role: 'afk', to_thread_id: AFK_THREAD, from_thread_id: AFK_STANDBY })
    expect(back.lease).toMatchObject({ thread_id: AFK_THREAD, primary_thread_id: AFK_THREAD })
    expect(await afk.ok('status_tick', tick(AFK_STANDBY))).toMatchObject({ recorded: false, holds_lease: false, lease_holder: AFK_THREAD })

    const again = await afk.call('lease_reclaim', { role: 'afk', to_thread_id: AFK_THREAD, from_thread_id: AFK_STANDBY })
    expect(again.isError).toBe(true)
  })

  it('a rotation by Aquila makes the successor the new primary', async () => {
    const { as } = world()
    const aquila = await as('direction')
    await aquila.ok('lease_move', { role: 'afk', to_thread_id: 'thread-afk-0002', from_thread_id: AFK_THREAD, old_schedule_task_deleted: true })
    expect((await aquila.ok('lease_read')).leases.afk.primary_thread_id).toBe('thread-afk-0002')
  })
})

describe('slots carry their host', () => {
  it('defaults to wsl2 and records homelab when given', async () => {
    const { as } = world()
    const afk = await as('afk')
    await afk.ok('slot_start', { issue: 'o/r#1', thread_id: 'worker-a' })
    await afk.ok('slot_start', { issue: 'o/r#2', thread_id: 'worker-b', host: 'homelab' })
    const hosts = (await afk.ok('slot_list')).slots.map((slot: { issue: string; host: string }) => [slot.issue, slot.host])
    expect(hosts).toEqual([
      ['o/r#1', 'wsl2'],
      ['o/r#2', 'homelab'],
    ])
  })

  it('a rebuild for one host leaves the other host\'s slots alone', async () => {
    const { as } = world()
    const afk = await as('afk')
    await afk.ok('slot_start', { issue: 'o/r#1', thread_id: 'worker-a' })
    await afk.ok('slot_start', { issue: 'o/r#2', thread_id: 'worker-b', host: 'homelab' })

    // WSL2 sees only its own worker thread; the homelab worker is not in its T3 list.
    const plan = await afk.ok('slot_rebuild', {
      issues: [
        { issue: 'o/r#1', assigned: true, needs_owner: false },
        { issue: 'o/r#2', assigned: true, needs_owner: false },
      ],
      threads: [{ thread_id: 'worker-a', state: 'running', issue: 'o/r#1' }],
      host: 'wsl2',
      apply: true,
    })
    expect(plan.changes).toEqual([])
    expect(plan.orphaned).toEqual([])
    expect((await afk.ok('slot_list')).slots.map((slot: { issue: string }) => slot.issue)).toEqual(['o/r#1', 'o/r#2'])
  })
})
