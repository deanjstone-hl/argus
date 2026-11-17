import { describe, expect, it } from 'vitest'

import { AFK_THREAD, AQUILA_THREAD, MINUTE, TOKENS, text, world } from './helpers.js'

/**
 * argus#1046: a homelab thread that is a lease's primary follows the primary's wake path, and
 * a lease remembers its primary's host so a new thread on that host can reclaim it.
 */
const HOMELAB_AFK = 'thread-afk-homelab-primary'
const HOMELAB_AFK_NEXT = 'thread-afk-homelab-next'
const WSL_AFK_NEXT = 'thread-afk-wsl2-next'
const HOMELAB_OTHER = 'thread-afk-homelab-other'

const modelTick = (thread_id: string, extra: Record<string, unknown> = {}) => ({
  thread_id,
  directives_version: 'v1',
  needs_owner: [] as string[],
  ...extra,
})

const check = (thread_id: string, extra: Record<string, unknown> = {}) => ({
  role: 'afk',
  host: 'homelab',
  thread_id,
  directives_version: 'v1',
  needs_owner: [] as string[],
  window_used_percent: 20,
  takeable: 0,
  ...extra,
})

/** The owner moved the afk lease to a homelab thread, which then ticked once with cap 2. */
async function homelabPrimary() {
  const w = world({ leases: {} })
  const afk = await w.as('afk')
  const aquila = await w.as('direction')
  await aquila.ok('lease_move', { role: 'afk', to_thread_id: HOMELAB_AFK, host: 'homelab' })
  await afk.ok('status_tick', modelTick(HOMELAB_AFK, { slot_cap: 2, window_used_percent: 20 }))
  const wake = (body: Record<string, unknown>) => w.post('/wake/check', body, TOKENS.afk)
  return { ...w, afk, aquila, wake }
}

describe('a homelab primary that holds the lease is woken as a primary', () => {
  it('wakes for a free slot, not on the standby cadence', async () => {
    const { wake } = await homelabPrimary()
    expect((await wake(check(HOMELAB_AFK, { takeable: 3 }))).body).toEqual({ wake: true, reason: 'free_slot', recorded: false })
  })

  it('wakes for a pending approval', async () => {
    const { wake, afk } = await homelabPrimary()
    await afk.ok('slot_start', { issue: 'deanjstone/argus#9', thread_id: 'worker-9', host: 'homelab', caller_thread_id: HOMELAB_AFK })
    await afk.ok('status_tick', modelTick(HOMELAB_AFK, { slot_cap: 2, window_used_percent: 20, pending_approvals: { 'deanjstone/argus#9': 1 } }))
    expect((await wake(check(HOMELAB_AFK))).body).toEqual({ wake: true, reason: 'pending_approvals', recorded: false })
  })

  it('wakes when the gate inputs changed, and records a quiet tick otherwise', async () => {
    const { wake } = await homelabPrimary()
    expect((await wake(check(HOMELAB_AFK, { directives_version: 'v2' }))).body.reason).toBe('changed:directives')
    const quiet = await world({ leases: {} })
    const afk = await quiet.as('afk')
    await (await quiet.as('direction')).ok('lease_move', { role: 'afk', to_thread_id: HOMELAB_AFK, host: 'homelab' })
    await afk.ok('status_tick', modelTick(HOMELAB_AFK, { slot_cap: 2, window_used_percent: 20 }))
    expect((await quiet.post('/wake/check', check(HOMELAB_AFK), TOKENS.afk)).body).toEqual({ wake: false, reason: 'quiet', recorded: true })
  })

  it('wakes on the heartbeat once the model has recorded no tick for 4 h', async () => {
    const { wake, clock } = await homelabPrimary()
    clock.advance(4 * 60 * MINUTE)
    expect((await wake(check(HOMELAB_AFK))).body).toMatchObject({ wake: true, reason: 'heartbeat' })
  })

  it('wakes direction for an outage as a primary', async () => {
    const w = world({ leases: { afk: AFK_THREAD } })
    const aquila = await w.as('direction')
    await aquila.ok('lease_move', { role: 'direction', to_thread_id: HOMELAB_AFK, host: 'homelab' })
    await aquila.ok('status_tick', modelTick(HOMELAB_AFK, { window_used_percent: 20 }))
    const afk = await w.as('afk')
    await afk.ok('status_tick', modelTick(AFK_THREAD, { slot_cap: 1 }))
    w.clock.advance(70 * MINUTE)
    const body = { ...check(HOMELAB_AFK), role: 'direction' }
    delete (body as Record<string, unknown>).takeable
    expect((await w.post('/wake/check', body, TOKENS.direction)).body).toEqual({ wake: true, reason: 'outage_opened', recorded: false })
  })
})

describe('a homelab thread that is not the primary keeps the standby path', () => {
  it('a non-primary holder gets standby_cadence, not free_slot', async () => {
    const { wake, afk, clock } = await homelabPrimary()
    clock.advance(70 * MINUTE)
    await afk.ok('lease_failover', { role: 'afk', to_thread_id: HOMELAB_OTHER, from_thread_id: HOMELAB_AFK })
    expect((await wake(check(HOMELAB_OTHER, { takeable: 3 }))).body).toEqual({ wake: true, reason: 'standby_cadence', recorded: false })
    await afk.ok('status_tick', modelTick(HOMELAB_OTHER))
    clock.advance(10 * MINUTE)
    expect((await wake(check(HOMELAB_OTHER, { takeable: 3 }))).body).toEqual({ wake: false, reason: 'standby_waiting', recorded: false })
  })

  it('a non-primary non-holder is primary_alive while the primary lives', async () => {
    const { wake } = await homelabPrimary()
    expect((await wake(check(HOMELAB_OTHER, { takeable: 3 }))).body).toEqual({ wake: false, reason: 'primary_alive', recorded: false })
  })
})

describe('primary_host', () => {
  it('is set by lease_move from the host given, and shown in lease_read', async () => {
    const w = world({ leases: {} })
    const aquila = await w.as('direction')
    await aquila.ok('lease_move', { role: 'afk', to_thread_id: HOMELAB_AFK, host: 'homelab' })
    await aquila.ok('lease_move', { role: 'direction', to_thread_id: AQUILA_THREAD, host: 'wsl2' })
    const { leases } = await aquila.ok('lease_read')
    expect(leases.afk).toMatchObject({ thread_id: HOMELAB_AFK, primary_thread_id: HOMELAB_AFK, primary_host: 'homelab' })
    expect(leases.direction).toMatchObject({ primary_host: 'wsl2' })
  })

  it('is null when lease_move is given no host, and refuses an unknown host', async () => {
    const w = world({ leases: {} })
    const aquila = await w.as('direction')
    await aquila.ok('lease_move', { role: 'afk', to_thread_id: AFK_THREAD })
    expect((await aquila.ok('lease_read')).leases.afk.primary_host).toBeNull()
    const bad = await aquila.call('lease_move', { role: 'direction', to_thread_id: AQUILA_THREAD, host: 'mars' })
    expect(bad.isError).toBe(true)
  })

  it('survives a failover', async () => {
    const { afk, clock } = await homelabPrimary()
    clock.advance(70 * MINUTE)
    await afk.ok('lease_failover', { role: 'afk', to_thread_id: HOMELAB_OTHER, from_thread_id: HOMELAB_AFK })
    expect((await afk.ok('lease_read')).leases.afk).toMatchObject({ thread_id: HOMELAB_OTHER, primary_host: 'homelab' })
  })
})

describe('lease_reclaim by host', () => {
  async function wslHeldByHomelab() {
    const w = world({ leases: {} })
    const afk = await w.as('afk')
    const aquila = await w.as('direction')
    await aquila.ok('lease_move', { role: 'afk', to_thread_id: AFK_THREAD, host: 'wsl2' })
    await afk.ok('status_tick', modelTick(AFK_THREAD, { slot_cap: 1 }))
    w.clock.advance(70 * MINUTE)
    await afk.ok('lease_failover', { role: 'afk', to_thread_id: HOMELAB_AFK, from_thread_id: AFK_THREAD })
    return { ...w, afk, aquila }
  }

  it('hands the lease to a new thread on the primary host and records it as primary', async () => {
    const { afk } = await wslHeldByHomelab()
    const back = await afk.ok('lease_reclaim', { role: 'afk', to_thread_id: WSL_AFK_NEXT, from_thread_id: HOMELAB_AFK, host: 'wsl2' })
    expect(back.lease).toMatchObject({ thread_id: WSL_AFK_NEXT, primary_thread_id: WSL_AFK_NEXT, primary_host: 'wsl2' })
    expect((await afk.ok('lease_read')).leases.afk).toMatchObject({ thread_id: WSL_AFK_NEXT, primary_thread_id: WSL_AFK_NEXT })
  })

  it('refuses a new thread named from the other host, and a new thread with no host', async () => {
    const { afk } = await wslHeldByHomelab()
    const wrongHost = await afk.call('lease_reclaim', { role: 'afk', to_thread_id: HOMELAB_AFK_NEXT, from_thread_id: HOMELAB_AFK, host: 'homelab' })
    expect(wrongHost.isError).toBe(true)
    expect(text(wrongHost)).toMatch(/primary/)
    const noHost = await afk.call('lease_reclaim', { role: 'afk', to_thread_id: WSL_AFK_NEXT, from_thread_id: HOMELAB_AFK })
    expect(noHost.isError).toBe(true)
    expect((await afk.ok('lease_read')).leases.afk.thread_id).toBe(HOMELAB_AFK)
  })

  it('refuses a new thread when the lease records no primary_host', async () => {
    const w = world()
    const afk = await w.as('afk')
    await afk.ok('status_tick', modelTick(AFK_THREAD, { slot_cap: 1 }))
    w.clock.advance(70 * MINUTE)
    await afk.ok('lease_failover', { role: 'afk', to_thread_id: HOMELAB_AFK, from_thread_id: AFK_THREAD })
    const result = await afk.call('lease_reclaim', { role: 'afk', to_thread_id: WSL_AFK_NEXT, from_thread_id: HOMELAB_AFK, host: 'wsl2' })
    expect(result.isError).toBe(true)
  })

  it('keeps the exact-id path working, with or without a host', async () => {
    const { afk } = await wslHeldByHomelab()
    const back = await afk.ok('lease_reclaim', { role: 'afk', to_thread_id: AFK_THREAD, from_thread_id: HOMELAB_AFK })
    expect(back.lease).toMatchObject({ thread_id: AFK_THREAD, primary_thread_id: AFK_THREAD, primary_host: 'wsl2' })
  })

  it('stops the reclaimed new thread being woken as a stranger, and wakes the new host thread to reclaim', async () => {
    const { post, afk } = await wslHeldByHomelab()
    // A new WSL thread is not the recorded primary id yet, so it is not_holder until it reclaims.
    const body = { role: 'afk', host: 'wsl2', thread_id: WSL_AFK_NEXT, directives_version: 'v1', needs_owner: [], window_used_percent: 20, takeable: 0 }
    expect((await post('/wake/check', body, TOKENS.afk)).body).toMatchObject({ wake: false, reason: 'not_holder' })
    await afk.ok('lease_reclaim', { role: 'afk', to_thread_id: WSL_AFK_NEXT, from_thread_id: HOMELAB_AFK, host: 'wsl2' })
    expect((await post('/wake/check', body, TOKENS.afk)).body.wake).toBe(true)
  })
})
