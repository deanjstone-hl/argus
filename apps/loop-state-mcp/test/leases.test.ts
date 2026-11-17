import { describe, expect, it } from 'vitest'

import { AFK_THREAD, AQUILA_THREAD, MINUTE, text, TOKENS, world } from './helpers.js'

const SUCCESSOR = 'thread-afk-0002'
const tick = (thread_id: string) => ({ thread_id, directives_version: 'v1', needs_owner: [] as string[] })

describe('leases', () => {
  it('starts with no holder, and a tick with no lease held does nothing', async () => {
    const { as } = world({ leases: {} })
    const afk = await as('afk')
    expect(await afk.ok('lease_read')).toEqual({ leases: { afk: null, direction: null } })

    expect(await afk.ok('status_tick', tick(AFK_THREAD))).toMatchObject({ recorded: false, holds_lease: false, lease_holder: null })
    expect(await afk.ok('tick_gate', tick(AFK_THREAD))).toMatchObject({ recorded: false, holds_lease: false, lease_holder: null })
    expect((await afk.ok('status_read')).last_tick_at).toBeNull()
  })

  it('has one holder per role: Aquila writes it, and a held lease moves only from its holder', async () => {
    const { as, clock } = world({ leases: {} })
    const aquila = await as('direction')
    await aquila.ok('lease_move', { role: 'direction', to_thread_id: AQUILA_THREAD })
    await aquila.ok('lease_move', { role: 'afk', to_thread_id: AFK_THREAD })
    expect(await aquila.ok('lease_read')).toEqual({
      leases: {
        afk: { thread_id: AFK_THREAD, since: clock.iso(), primary_thread_id: AFK_THREAD, primary_host: null },
        direction: { thread_id: AQUILA_THREAD, since: clock.iso(), primary_thread_id: AQUILA_THREAD, primary_host: null },
      },
    })

    const blind = await aquila.call('lease_move', { role: 'afk', to_thread_id: SUCCESSOR })
    expect(blind.isError).toBe(true)
    expect(text(blind)).toMatch(/held by thread-afk-0001/)
    const wrongHolder = await aquila.call('lease_move', {
      role: 'afk',
      to_thread_id: SUCCESSOR,
      from_thread_id: 'thread-afk-9999',
      old_schedule_task_deleted: true,
    })
    expect(wrongHolder.isError).toBe(true)
    expect((await aquila.ok('lease_read')).leases.afk.thread_id).toBe(AFK_THREAD)
  })

  it('refuses lease writes from any role but Aquila', async () => {
    const { as } = world({ leases: {} })
    const afk = await as('afk')
    const worker = await as('worker')
    expect((await afk.call('lease_move', { role: 'afk', to_thread_id: AFK_THREAD })).isError).toBe(true)
    expect((await afk.call('lease_release', { role: 'afk', from_thread_id: AFK_THREAD, old_schedule_task_deleted: true })).isError).toBe(true)
    expect((await worker.call('lease_read')).isError).toBe(true)
    expect((await afk.ok('lease_read')).leases.afk).toBeNull()
  })

  it('ignores a tick from a thread that does not hold its role\'s lease', async () => {
    const { as, clock } = world()
    const afk = await as('afk')
    await afk.ok('status_tick', { ...tick(AFK_THREAD), slot_cap: 3 })
    const lastTick = clock.iso()

    clock.advance(30 * MINUTE)
    expect(await afk.ok('status_tick', { ...tick('thread-stray'), slot_cap: 1 })).toMatchObject({
      recorded: false,
      holds_lease: false,
      lease_holder: AFK_THREAD,
    })
    expect(await afk.ok('tick_gate', { ...tick('thread-stray'), directives_version: 'v9' })).toMatchObject({
      changed: false,
      recorded: false,
      holds_lease: false,
      lease_holder: AFK_THREAD,
    })
    expect(await afk.ok('status_read')).toMatchObject({ thread_id: AFK_THREAD, last_tick_at: lastTick, directives_version: 'v1', slots: { cap: 3 } })
  })

  it('tells Aquila\'s next gate about a stray tick, as a lease conflict', async () => {
    const { as } = world()
    const afk = await as('afk')
    const aquila = await as('direction')
    await afk.ok('status_tick', tick(AFK_THREAD))
    await aquila.ok('status_tick', tick(AQUILA_THREAD))

    await afk.ok('tick_gate', tick('thread-stray'))
    expect(await aquila.ok('tick_gate', tick(AQUILA_THREAD))).toMatchObject({ changed: true, reasons: ['lease_conflict'] })
    expect((await afk.ok('tick_gate', tick(AFK_THREAD))).changed).toBe(false)
  })

  it('runs the retire-first handover: schedule deleted, lease moved, then the successor boots', async () => {
    const { as } = world()
    const afk = await as('afk')
    const aquila = await as('direction')
    await afk.ok('status_tick', tick(AFK_THREAD))

    // The successor booting before the lease moves is a non-holder: its tick does nothing.
    expect((await afk.ok('status_tick', tick(SUCCESSOR))).recorded).toBe(false)

    // The move names the retiring holder and confirms its schedule_task is already deleted.
    const early = await aquila.call('lease_move', { role: 'afk', to_thread_id: SUCCESSOR, from_thread_id: AFK_THREAD })
    expect(early.isError).toBe(true)
    expect(text(early)).toMatch(/schedule_task/)
    await aquila.ok('lease_move', { role: 'afk', to_thread_id: SUCCESSOR, from_thread_id: AFK_THREAD, old_schedule_task_deleted: true })

    // A last tick from the retiring thread, already in flight, does nothing.
    expect((await afk.ok('status_tick', tick(AFK_THREAD))).recorded).toBe(false)
    expect(await afk.ok('tick_gate', tick(SUCCESSOR))).toMatchObject({ holds_lease: true, changed: true })
    expect(await afk.ok('status_tick', tick(SUCCESSOR))).toMatchObject({ recorded: true, holds_lease: true, thread_id: SUCCESSOR })
  })

  it('releases a lease on rollback, after which nobody\'s tick counts', async () => {
    const { as } = world()
    const afk = await as('afk')
    const aquila = await as('direction')
    expect((await aquila.call('lease_release', { role: 'afk', from_thread_id: AFK_THREAD })).isError).toBe(true)
    await aquila.ok('lease_release', { role: 'afk', from_thread_id: AFK_THREAD, old_schedule_task_deleted: true })

    expect((await aquila.ok('lease_read')).leases.afk).toBeNull()
    expect((await afk.ok('status_tick', tick(AFK_THREAD))).recorded).toBe(false)
  })

  it('keeps leases across a restart', async () => {
    const { as, restart } = world({ leases: {} })
    await (await as('direction')).ok('lease_move', { role: 'afk', to_thread_id: AFK_THREAD })
    restart()
    expect((await (await as('afk')).ok('status_tick', tick(AFK_THREAD))).recorded).toBe(true)
  })
})

/**
 * argus-config#796-#798: the merged orchestrator is one thread holding both the `afk` and the
 * `direction` lease. Nothing in loop-state names a thread per role, so these tests pin that each
 * role's lease, liveness, failover, reclaim and wake stay independent while the thread is the same.
 */
describe('one thread holding both leases', () => {
  const MERGED = 'thread-merged-0001'
  const STANDBY = 'thread-merged-homelab'
  const ROLES = ['afk', 'direction'] as const

  /** A world where nobody holds a lease and Aquila's token gives both to the merged thread, as at the cutover. */
  async function merged() {
    const w = world({ leases: {} })
    const afk = await w.as('afk')
    const aquila = await w.as('direction')
    for (const role of ROLES) await aquila.ok('lease_move', { role, to_thread_id: MERGED })
    const wake = (role: (typeof ROLES)[number], thread_id: string, extra: Record<string, unknown> = {}) =>
      w.post(
        '/wake/check',
        {
          role,
          host: 'wsl2',
          thread_id,
          directives_version: 'v1',
          needs_owner: [] as string[],
          window_used_percent: 20,
          ...(role === 'afk' ? { takeable: 0 } : {}),
          ...extra,
        },
        TOKENS[role],
      )
    /** The merged thread's full tick: one status_tick per role. */
    const tickBoth = async (thread_id = MERGED) => {
      await afk.ok('status_tick', { ...tick(thread_id), slot_cap: 1, window_used_percent: 20 })
      await aquila.ok('status_tick', { ...tick(thread_id), window_used_percent: 20 })
    }
    return { ...w, afk, aquila, wake, tickBoth }
  }

  it('takes both unheld leases with lease_move, each recording the thread as its own primary', async () => {
    const { afk, clock } = await merged()
    const held = { thread_id: MERGED, since: clock.iso(), primary_thread_id: MERGED, primary_host: null }
    expect(await afk.ok('lease_read')).toEqual({ leases: { afk: held, direction: held } })
  })

  it('counts its tick for each role, and each role reads alive', async () => {
    const { afk, aquila, clock, tickBoth } = await merged()
    expect(await afk.ok('status_tick', tick(MERGED))).toMatchObject({ recorded: true, holds_lease: true, lease_holder: MERGED })
    expect(await aquila.ok('status_tick', tick(MERGED))).toMatchObject({ recorded: true, holds_lease: true, lease_holder: MERGED })

    clock.advance(30 * MINUTE)
    await tickBoth()
    for (const role of ROLES) {
      expect(await afk.ok('status_read', { role })).toMatchObject({
        role,
        thread_id: MERGED,
        last_tick_at: clock.iso(),
        liveness: { state: 'alive', missed_ticks: 0 },
      })
    }
  })

  it('answers a tick_gate for each role on its own cursor', async () => {
    const { afk, aquila, clock, tickBoth } = await merged()
    expect(await afk.ok('tick_gate', tick(MERGED))).toMatchObject({ changed: true, reasons: ['first_tick'], holds_lease: true })
    expect(await aquila.ok('tick_gate', tick(MERGED))).toMatchObject({ changed: true, reasons: ['first_tick'], holds_lease: true })
    await tickBoth()

    clock.advance(30 * MINUTE)
    expect(await afk.ok('tick_gate', tick(MERGED))).toMatchObject({ changed: false, recorded: true, holds_lease: true })
    expect(await aquila.ok('tick_gate', tick(MERGED))).toMatchObject({ changed: false, recorded: true, holds_lease: true })
  })

  it('goes late after one missed cadence and stalled after two, for both roles together', async () => {
    const { afk, clock, tickBoth } = await merged()
    await tickBoth()
    clock.advance(40 * MINUTE)
    for (const role of ROLES) expect((await afk.ok('status_read', { role })).liveness).toMatchObject({ state: 'late', missed_ticks: 1 })

    clock.advance(30 * MINUTE)
    for (const role of ROLES) expect((await afk.ok('status_read', { role })).liveness).toMatchObject({ state: 'stalled', missed_ticks: 2 })
  })

  it('stalls only the role whose tick is missing when the thread ticks one role and not the other', async () => {
    const { afk, aquila, clock, tickBoth } = await merged()
    await tickBoth()
    clock.advance(40 * MINUTE)
    await aquila.ok('status_tick', tick(MERGED))
    clock.advance(30 * MINUTE)
    await aquila.ok('status_tick', tick(MERGED))
    expect((await afk.ok('status_read', { role: 'afk' })).liveness.state).toBe('stalled')
    expect((await afk.ok('status_read', { role: 'direction' })).liveness.state).toBe('alive')
  })

  it('lets a standby fail over each role in turn, each role with its own token', async () => {
    const { afk, aquila, clock, tickBoth } = await merged()
    await tickBoth()
    clock.advance(70 * MINUTE)

    // The afk token moves only the afk lease, and the direction token may move either.
    expect((await afk.call('lease_failover', { role: 'direction', to_thread_id: STANDBY, from_thread_id: MERGED })).isError).toBe(true)
    expect((await afk.ok('lease_failover', { role: 'afk', to_thread_id: STANDBY, from_thread_id: MERGED })).lease).toMatchObject({
      thread_id: STANDBY,
      primary_thread_id: MERGED,
    })

    // Mid-way: the standby holds afk only. Its direction tick does nothing, and the primary's afk tick does nothing.
    expect(await afk.ok('status_tick', tick(STANDBY))).toMatchObject({ recorded: true, holds_lease: true })
    expect(await aquila.ok('status_tick', tick(STANDBY))).toMatchObject({ recorded: false, holds_lease: false, lease_holder: MERGED })
    expect(await afk.ok('status_tick', tick(MERGED))).toMatchObject({ recorded: false, holds_lease: false, lease_holder: STANDBY })

    expect((await aquila.ok('lease_failover', { role: 'direction', to_thread_id: STANDBY, from_thread_id: MERGED })).lease).toMatchObject({
      thread_id: STANDBY,
      primary_thread_id: MERGED,
    })
    expect(await aquila.ok('status_tick', tick(STANDBY))).toMatchObject({ recorded: true, holds_lease: true })
    expect((await aquila.ok('lease_read')).leases).toMatchObject({
      afk: { thread_id: STANDBY, primary_thread_id: MERGED },
      direction: { thread_id: STANDBY, primary_thread_id: MERGED },
    })
  })

  it('refuses a failover of a role whose own tick is still alive, though the other role is stalled', async () => {
    const { afk, aquila, clock, tickBoth } = await merged()
    await tickBoth()
    clock.advance(40 * MINUTE)
    await aquila.ok('status_tick', tick(MERGED))
    clock.advance(30 * MINUTE)

    const alive = await aquila.call('lease_failover', { role: 'direction', to_thread_id: STANDBY, from_thread_id: MERGED })
    expect(alive.isError).toBe(true)
    expect(text(alive)).toMatch(/not stalled/)
    await afk.ok('lease_failover', { role: 'afk', to_thread_id: STANDBY, from_thread_id: MERGED })
  })

  it('lets the primary reclaim each role in turn, keeping the other role with the standby until its turn', async () => {
    const { afk, aquila, clock, tickBoth } = await merged()
    await tickBoth()
    clock.advance(70 * MINUTE)
    for (const role of ROLES) await aquila.ok('lease_failover', { role, to_thread_id: STANDBY, from_thread_id: MERGED })
    await afk.ok('status_tick', tick(STANDBY))
    await aquila.ok('status_tick', tick(STANDBY))

    expect((await afk.ok('lease_reclaim', { role: 'afk', to_thread_id: MERGED, from_thread_id: STANDBY })).lease).toMatchObject({
      thread_id: MERGED,
      primary_thread_id: MERGED,
    })
    expect(await afk.ok('status_tick', tick(MERGED))).toMatchObject({ recorded: true, holds_lease: true })
    expect(await aquila.ok('status_tick', tick(MERGED))).toMatchObject({ recorded: false, holds_lease: false, lease_holder: STANDBY })

    await aquila.ok('lease_reclaim', { role: 'direction', to_thread_id: MERGED, from_thread_id: STANDBY })
    expect(await aquila.ok('status_tick', tick(MERGED))).toMatchObject({ recorded: true, holds_lease: true })
    expect(await afk.ok('status_tick', tick(STANDBY))).toMatchObject({ recorded: false, holds_lease: false, lease_holder: MERGED })
    expect((await aquila.ok('lease_read')).leases).toMatchObject({ afk: { thread_id: MERGED }, direction: { thread_id: MERGED } })
  })

  it('rotates the merged thread one lease at a time, making the successor primary of both', async () => {
    const { aquila } = await merged()
    const successor = 'thread-merged-0002'
    const rotate = (role: (typeof ROLES)[number]) =>
      aquila.ok('lease_move', { role, to_thread_id: successor, from_thread_id: MERGED, old_schedule_task_deleted: true })

    await rotate('afk')
    expect((await aquila.ok('lease_read')).leases).toMatchObject({ afk: { thread_id: successor }, direction: { thread_id: MERGED } })
    await rotate('direction')
    expect((await aquila.ok('lease_read')).leases).toMatchObject({
      afk: { thread_id: successor, primary_thread_id: successor },
      direction: { thread_id: successor, primary_thread_id: successor },
    })
  })

  it('makes a lease_move while the standby holds a lease rewrite its primary, so the old primary can no longer reclaim', async () => {
    const { aquila, clock, tickBoth } = await merged()
    await tickBoth()
    clock.advance(70 * MINUTE)
    await aquila.ok('lease_failover', { role: 'afk', to_thread_id: STANDBY, from_thread_id: MERGED })

    const successor = 'thread-merged-0002'
    await aquila.ok('lease_move', { role: 'afk', to_thread_id: successor, from_thread_id: STANDBY, old_schedule_task_deleted: true })
    expect((await aquila.ok('lease_read')).leases.afk).toMatchObject({ thread_id: successor, primary_thread_id: successor })

    const stale = await aquila.call('lease_reclaim', { role: 'afk', to_thread_id: MERGED, from_thread_id: successor })
    expect(stale.isError).toBe(true)
    expect(text(stale)).toMatch(/primary/)
  })

  describe('POST /wake/check from the one thread', () => {
    it('answers each role as it does for separate threads: a quiet tick recorded by the client per role', async () => {
      const { wake, afk, clock, tickBoth } = await merged()
      await tickBoth()
      clock.advance(30 * MINUTE)

      for (const role of ROLES) {
        expect((await wake(role, MERGED)).body).toEqual({ wake: false, reason: 'quiet', recorded: true })
        expect(await afk.ok('status_read', { role })).toMatchObject({ last_tick_at: clock.iso(), last_tick_recorded_by: 'client', liveness: { state: 'alive' } })
      }
    })

    it('wakes for the first tick of each role', async () => {
      const { wake } = await merged()
      for (const role of ROLES) expect((await wake(role, MERGED)).body).toEqual({ wake: true, reason: 'first_tick', recorded: false })
    })

    it('wakes only the role that has a reason, and leaves the other role quiet', async () => {
      const { wake, afk, clock, tickBoth } = await merged()
      await tickBoth()
      clock.advance(30 * MINUTE)

      expect((await wake('afk', MERGED, { takeable: 3 })).body).toEqual({ wake: true, reason: 'free_slot', recorded: false })
      expect((await wake('direction', MERGED)).body).toEqual({ wake: false, reason: 'quiet', recorded: true })
      expect((await afk.ok('status_read', { role: 'afk' })).wake.pending_since).not.toBeNull()
      expect((await afk.ok('status_read', { role: 'direction' })).wake.pending_since).toBeNull()
    })

    it('needs each role\'s wake answered by that role\'s own tick: one answered role leaves the other\'s wake unanswered', async () => {
      const { wake, afk, aquila, clock, tickBoth } = await merged()
      await tickBoth()
      clock.advance(30 * MINUTE)
      for (const role of ROLES) expect((await wake(role, MERGED, { directives_version: 'v2' })).body).toMatchObject({ wake: true })

      await afk.ok('tick_gate', { ...tick(MERGED), directives_version: 'v2' })
      clock.advance(11 * MINUTE)
      // Both roles have missed one cadence (a changed gate records nothing); only direction has an unanswered wake,
      // and that alone does not stall it.
      expect((await afk.ok('status_read', { role: 'afk' })).liveness.state).toBe('late')
      expect((await afk.ok('status_read', { role: 'afk' })).wake.unanswered).toBe(false)
      const unanswered = await afk.ok('status_read', { role: 'direction' })
      expect(unanswered.liveness.state).toBe('late')
      expect(unanswered.wake.unanswered).toBe(true)

      await aquila.ok('tick_gate', { ...tick(MERGED), directives_version: 'v2' })
      const answered = await afk.ok('status_read', { role: 'direction' })
      expect(answered.liveness.state).toBe('late')
      expect(answered.wake.unanswered).toBe(false)
    })

    it('wakes the standby to fail over each stalled role, and the primary to reclaim each after it', async () => {
      const { wake, afk, aquila, clock, tickBoth } = await merged()
      await tickBoth()
      expect((await wake('afk', STANDBY, { host: 'homelab' })).body).toEqual({ wake: false, reason: 'primary_alive', recorded: false })

      clock.advance(70 * MINUTE)
      for (const role of ROLES) expect((await wake(role, STANDBY, { host: 'homelab' })).body).toEqual({ wake: true, reason: 'failover', recorded: false })
      for (const role of ROLES) {
        await (role === 'afk' ? afk : aquila).ok('lease_failover', { role, to_thread_id: STANDBY, from_thread_id: MERGED })
      }
      await tickBoth(STANDBY)

      for (const role of ROLES) expect((await wake(role, MERGED)).body).toEqual({ wake: true, reason: 'reclaim', recorded: false })
      await afk.ok('lease_reclaim', { role: 'afk', to_thread_id: MERGED, from_thread_id: STANDBY })
      // Holding afk again, the primary's check is an ordinary one; direction is still the standby's, so it still reclaims.
      expect((await wake('afk', MERGED)).body).toMatchObject({ wake: false })
      expect((await wake('direction', MERGED)).body).toEqual({ wake: true, reason: 'reclaim', recorded: false })
    })

    it('answers a standby of the merged thread by role: its own lease stands by, the other holder\'s is primary_alive', async () => {
      const { wake, afk, clock, tickBoth } = await merged()
      await tickBoth()
      clock.advance(70 * MINUTE)
      await afk.ok('lease_failover', { role: 'afk', to_thread_id: STANDBY, from_thread_id: MERGED })
      await afk.ok('status_tick', tick(STANDBY))

      expect((await wake('afk', STANDBY, { host: 'homelab' })).body).toMatchObject({ wake: true, reason: 'standby_cadence' })
      expect((await wake('direction', STANDBY, { host: 'homelab' })).body).toEqual({ wake: true, reason: 'failover', recorded: false })
    })
  })
})
