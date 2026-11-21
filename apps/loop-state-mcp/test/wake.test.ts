import { describe, expect, it } from 'vitest'

import { AFK_THREAD, AQUILA_THREAD, MINUTE, TOKENS, text, world } from './helpers.js'

/**
 * POST /wake/check (argus#831): the loop-wake client asks the server whether a tick needs a
 * model turn. The cases follow the issue's table, one block per row.
 */
const AFK_STANDBY = 'thread-afk-homelab'
const AQUILA_STANDBY = 'thread-aquila-homelab'
const HOUR = 60 * MINUTE

const modelTick = (thread_id: string, extra: Record<string, unknown> = {}) => ({
  thread_id,
  directives_version: 'v1',
  needs_owner: [] as string[],
  ...extra,
})

/** What the client posts: the same gate inputs a model tick would pass, plus host and takeable. */
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

/** A world where the AFK loop has run one full model tick with a cap of 2 and one slot running, so no slot is free by default. */
async function ticked(options: Parameters<typeof world>[0] = {}) {
  const w = world(options)
  const afk = await w.as('afk')
  const aquila = await w.as('direction')
  await afk.ok('status_tick', modelTick(AFK_THREAD, { slot_cap: 1, window_used_percent: 20 }))
  await aquila.ok('status_tick', modelTick(AQUILA_THREAD, { window_used_percent: 20 }))
  const wake = (body: Record<string, unknown>, token = TOKENS[body.role as 'afk' | 'direction']) => w.post('/wake/check', body, token)
  return { ...w, afk, aquila, wake }
}

describe('POST /wake/check: the primary holds the lease', () => {
  it('nothing changed: no wake, and the server records a quiet tick marked as recorded by the client', async () => {
    const { wake, afk, clock } = await ticked()
    clock.advance(30 * MINUTE)

    const result = await wake(check('afk', AFK_THREAD))
    expect(result).toEqual({ status: 200, body: { wake: false, reason: 'quiet', recorded: true } })

    const status = await afk.ok('status_read')
    expect(status).toMatchObject({ last_tick_at: clock.iso(), last_tick_recorded_by: 'client', liveness: { state: 'alive' } })
    expect(status.ticks).toMatchObject({ last_7_days: { model: 1, client: 1 }, all_time: { model: 1, client: 1 } })
  })

  it('the client-recorded quiet tick is a baseline the next model tick_gate compares against, as before', async () => {
    const { wake, afk, clock } = await ticked()
    clock.advance(30 * MINUTE)
    await wake(check('afk', AFK_THREAD))
    const recordedAt = clock.iso()

    clock.advance(30 * MINUTE)
    const gate = await afk.ok('tick_gate', modelTick(AFK_THREAD, { window_used_percent: 20 }))
    expect(gate).toEqual({ changed: false, reasons: [], changes: [], recorded: true, since: recordedAt, holds_lease: true, lease_holder: AFK_THREAD })
    expect((await afk.ok('status_read')).last_tick_recorded_by).toBe('model')
  })

  it('a changed directives version or needs:owner set wakes, recording nothing (a pressure flip waits for its dwell: wake-actionable.test.ts)', async () => {
    const { wake, afk } = await ticked()
    for (const changed of [{ directives_version: 'v2' }, { needs_owner: ['deanjstone/argus#1'] }]) {
      const result = await wake(check('afk', AFK_THREAD, changed))
      expect(result.body).toMatchObject({ wake: true, recorded: false })
      expect(result.body.reason).toMatch(/^changed:/)
    }
    expect((await afk.ok('status_read')).ticks.all_time.client).toBe(0)
  })

  it('a slot event since the last tick wakes, and names it', async () => {
    const { wake, afk } = await ticked()
    await afk.ok('slot_start', { issue: 'deanjstone/argus#5', thread_id: 'worker-1' })
    expect((await wake(check('afk', AFK_THREAD))).body).toEqual({ wake: true, reason: 'changed:slot_started', recorded: false })
  })

  it('afk: a free slot with takeable work wakes; a free slot with nothing takeable, or takeable work with no free slot, does not', async () => {
    const { wake, afk, clock } = await ticked()
    // Cap 1, nothing running: one free slot.
    expect((await wake(check('afk', AFK_THREAD, { takeable: 3 }))).body).toEqual({ wake: true, reason: 'free_slot', recorded: false })
    await afk.ok('tick_gate', modelTick(AFK_THREAD)) // answer the wake

    clock.advance(30 * MINUTE)
    expect((await wake(check('afk', AFK_THREAD, { takeable: 0 }))).body).toMatchObject({ wake: false, recorded: true })

    await afk.ok('slot_start', { issue: 'deanjstone/argus#5', thread_id: 'worker-1' })
    await afk.ok('status_tick', modelTick(AFK_THREAD, { slot_cap: 1, window_used_percent: 20 }))
    clock.advance(30 * MINUTE)
    expect((await wake(check('afk', AFK_THREAD, { takeable: 3 }))).body).toMatchObject({ wake: false, recorded: true })
  })

  it('afk: a free slot does not wake at or above the no_new_slots level, where no slot would start', async () => {
    const { wake, afk } = await ticked()
    await afk.ok('status_tick', modelTick(AFK_THREAD, { slot_cap: 1, window_used_percent: 88 }))
    expect((await wake(check('afk', AFK_THREAD, { takeable: 3, window_used_percent: 88 }))).body).toMatchObject({ wake: false })
  })

  it('direction: an outage opening (the AFK loop stalled) or closing wakes Aquila', async () => {
    const { wake, afk, aquila, clock } = await ticked()
    clock.advance(70 * MINUTE)
    // The AFK loop has missed 2 ticks; Aquila has no open outage yet: an edge.
    expect((await wake(check('direction', AQUILA_THREAD))).body).toEqual({ wake: true, reason: 'outage_opened', recorded: false })

    await aquila.ok('outage_observe', { stalled: true, reason: 'afk stalled' })
    await aquila.ok('status_tick', modelTick(AQUILA_THREAD, { window_used_percent: 20 }))
    expect((await wake(check('direction', AQUILA_THREAD))).body).toMatchObject({ wake: false, recorded: true })

    await afk.ok('status_tick', modelTick(AFK_THREAD, { slot_cap: 1, window_used_percent: 20 }))
    expect((await wake(check('direction', AQUILA_THREAD))).body).toMatchObject({ wake: true, reason: 'outage_closed' })
  })

  it('a role that never ticked wakes for its first tick', async () => {
    const { post } = world()
    const result = await post('/wake/check', check('afk', AFK_THREAD), TOKENS.afk)
    expect(result.body).toEqual({ wake: true, reason: 'first_tick', recorded: false })
  })
})

describe('POST /wake/check: the 4 h heartbeat', () => {
  it('wakes the primary once no tick has been recorded by the model for 4 h, however many quiet ticks the client recorded', async () => {
    const { wake, afk, clock } = await ticked()
    for (let poll = 1; poll < 8; poll += 1) {
      clock.advance(30 * MINUTE)
      expect((await wake(check('afk', AFK_THREAD))).body).toEqual({ wake: false, reason: 'quiet', recorded: true })
    }
    clock.advance(30 * MINUTE) // 4 h since the model's tick
    expect((await wake(check('afk', AFK_THREAD))).body).toEqual({ wake: true, reason: 'heartbeat', recorded: false })

    await afk.ok('tick_gate', modelTick(AFK_THREAD, { window_used_percent: 20 }))
    clock.advance(30 * MINUTE)
    expect((await wake(check('afk', AFK_THREAD))).body).toMatchObject({ wake: false, recorded: true })
  })
})

describe('POST /wake/check: the wake acknowledgement', () => {
  it('a wake answered by a model tick within 10 min leaves the thread alive', async () => {
    const { wake, afk, aquila, clock } = await ticked()
    await afk.ok('slot_start', { issue: 'deanjstone/argus#5', thread_id: 'worker-1' })
    expect((await wake(check('afk', AFK_THREAD))).body.wake).toBe(true)

    clock.advance(4 * MINUTE)
    await afk.ok('tick_gate', modelTick(AFK_THREAD))
    clock.advance(10 * MINUTE)
    const status = await aquila.ok('status_read')
    expect(status.liveness.state).toBe('alive')
    expect(status.wake).toMatchObject({ pending_since: null, unanswered: false })
  })

  it('a wake with no model tick within 10 min stays late until 2 ticks are missed, and quiet ticks by the client cannot hide it', async () => {
    const { wake, aquila, clock } = await ticked()
    expect((await aquila.ok('status_read')).liveness.state).toBe('alive')

    // Directives changed: the AFK primary is woken but never answers.
    expect((await wake(check('afk', AFK_THREAD, { directives_version: 'v2' }))).body.wake).toBe(true)
    clock.advance(9 * MINUTE)
    expect((await aquila.ok('status_read')).liveness.state).toBe('alive')
    clock.advance(1 * MINUTE)
    const unanswered = await aquila.ok('status_read')
    expect(unanswered.liveness).toMatchObject({ state: 'late', missed_ticks: 0 })
    expect(unanswered.wake).toMatchObject({ unanswered: true })

    // The client polls again with the old inputs: nothing records a quiet tick over the unanswered wake.
    clock.advance(20 * MINUTE)
    expect((await wake(check('afk', AFK_THREAD))).body).toEqual({ wake: true, reason: 'unanswered', recorded: false })
    expect((await aquila.ok('status_read')).liveness).toMatchObject({ state: 'late', missed_ticks: 0 })

    // With no tick recorded over it, the missed ticks pile up and the unanswered thread is stalled at 2.
    clock.advance(40 * MINUTE)
    expect((await aquila.ok('status_read')).liveness).toMatchObject({ state: 'stalled', missed_ticks: 2 })
  })

  it('an unanswered wake alone is not a failover: the standby is not woken and lease_failover is refused until 2 ticks are missed', async () => {
    const { wake, afk, clock } = await ticked()
    expect((await wake(check('afk', AFK_THREAD, { directives_version: 'v2' }))).body.wake).toBe(true)
    clock.advance(11 * MINUTE)
    expect((await wake(check('afk', AFK_STANDBY, { host: 'homelab' }))).body).toEqual({ wake: false, reason: 'primary_alive', recorded: false })
    const refused = await afk.call('lease_failover', { role: 'afk', to_thread_id: AFK_STANDBY, from_thread_id: AFK_THREAD })
    expect(text(refused)).toMatch(/not stalled/)

    clock.advance(60 * MINUTE)
    expect((await wake(check('afk', AFK_STANDBY, { host: 'homelab' }))).body).toEqual({ wake: true, reason: 'failover', recorded: false })
    const moved = await afk.ok('lease_failover', { role: 'afk', to_thread_id: AFK_STANDBY, from_thread_id: AFK_THREAD })
    expect(moved.lease).toMatchObject({ thread_id: AFK_STANDBY, primary_thread_id: AFK_THREAD })
  })
})

describe('POST /wake/check: a standby on homelab', () => {
  it('the primary holds the lease and is alive or late, no homelab slot: no wake, and nothing recorded', async () => {
    const { wake, afk, aquila, clock } = await ticked()
    const before = await aquila.ok('status_read')
    expect((await wake(check('afk', AFK_STANDBY, { host: 'homelab' }))).body).toEqual({ wake: false, reason: 'primary_alive', recorded: false })

    clock.advance(40 * MINUTE) // late
    expect((await wake(check('afk', AFK_STANDBY, { host: 'homelab' }))).body).toEqual({ wake: false, reason: 'primary_alive', recorded: false })
    expect((await wake(check('direction', AQUILA_STANDBY, { host: 'homelab' }))).body).toMatchObject({ wake: false })

    const after = await afk.ok('status_read')
    expect(after).toMatchObject({ last_tick_at: before.last_tick_at, thread_id: AFK_THREAD })
    expect(after.ticks.all_time).toEqual({ model: 1, client: 0 })
  })

  it('the primary holder is stalled: wake, so it can lease_failover', async () => {
    const { wake, aquila, clock } = await ticked()
    clock.advance(70 * MINUTE)
    expect((await wake(check('afk', AFK_STANDBY, { host: 'homelab' }))).body).toEqual({ wake: true, reason: 'failover', recorded: false })
    expect((await wake(check('direction', AQUILA_STANDBY, { host: 'homelab' }))).body).toEqual({ wake: true, reason: 'failover', recorded: false })
    await aquila.ok('lease_failover', { role: 'direction', to_thread_id: AQUILA_STANDBY, from_thread_id: AQUILA_THREAD })
  })

  it('the standby holds the lease: wake at the 30 min cadence', async () => {
    const { wake, afk, clock } = await ticked()
    clock.advance(70 * MINUTE)
    await afk.ok('lease_failover', { role: 'afk', to_thread_id: AFK_STANDBY, from_thread_id: AFK_THREAD })

    const standby = check('afk', AFK_STANDBY, { host: 'homelab' })
    expect((await wake(standby)).body).toEqual({ wake: true, reason: 'standby_cadence', recorded: false })
    await afk.ok('status_tick', modelTick(AFK_STANDBY))
    clock.advance(10 * MINUTE)
    expect((await wake(standby)).body).toMatchObject({ wake: false, recorded: false })
    clock.advance(10 * MINUTE)
    expect((await wake(standby)).body).toMatchObject({ wake: false, recorded: false })
    clock.advance(10 * MINUTE)
    expect((await wake(standby)).body).toEqual({ wake: true, reason: 'standby_cadence', recorded: false })
  })

  it('after a handback with its own homelab slots still open: no drain while the WSL2 holder is alive, it drains them itself (argus#57)', async () => {
    const { wake, afk, clock } = await ticked()
    clock.advance(70 * MINUTE)
    await afk.ok('lease_failover', { role: 'afk', to_thread_id: AFK_STANDBY, from_thread_id: AFK_THREAD })
    await afk.ok('slot_start', { issue: 'deanjstone/argus#9', thread_id: 'homelab-worker', host: 'homelab' })
    await afk.ok('lease_reclaim', { role: 'afk', to_thread_id: AFK_THREAD, from_thread_id: AFK_STANDBY })
    await afk.ok('status_tick', modelTick(AFK_THREAD, { slot_cap: 1, window_used_percent: 20 }))

    const standby = check('afk', AFK_STANDBY, { host: 'homelab' })
    expect((await wake(standby)).body).toEqual({ wake: false, reason: 'primary_alive', recorded: false })
    clock.advance(40 * MINUTE)
    expect((await wake(standby)).body).toEqual({ wake: false, reason: 'primary_alive', recorded: false })
  })

  it('the holder\'s last tick carries a drain-left marker for a running homelab slot: wake at most once per 30 min to drain the open slots', async () => {
    const { wake, afk, clock } = await ticked()
    await afk.ok('slot_start', { issue: 'deanjstone/argus#9', thread_id: 'homelab-worker', host: 'homelab' })
    await afk.ok('status_tick', modelTick(AFK_THREAD, { slot_cap: 1, window_used_percent: 20, errors: ['drain-left: deanjstone/argus#9 homelab not reachable: t3 link expired'] }))

    const standby = check('afk', AFK_STANDBY, { host: 'homelab' })
    expect((await wake(standby)).body).toEqual({ wake: true, reason: 'drain', recorded: false })
    await afk.ok('tick_gate', modelTick(AFK_STANDBY)) // the standby answers; it does not hold the lease
    clock.advance(10 * MINUTE)
    expect((await wake(standby)).body).toEqual({ wake: false, reason: 'primary_alive', recorded: false })
    clock.advance(20 * MINUTE)
    expect((await wake(standby)).body).toEqual({ wake: true, reason: 'drain', recorded: false })

    await afk.ok('slot_free', { issue: 'deanjstone/argus#9', reason: 'drained' })
    clock.advance(30 * MINUTE)
    expect((await wake(standby)).body).toEqual({ wake: false, reason: 'primary_alive', recorded: false })
  })

  it('the marker is case-insensitive and may follow other errors on the tick', async () => {
    const { wake, afk } = await ticked()
    await afk.ok('slot_start', { issue: 'deanjstone/argus#9', thread_id: 'homelab-worker', host: 'homelab' })
    await afk.ok('status_tick', modelTick(AFK_THREAD, { slot_cap: 1, window_used_percent: 20, errors: ['gh rate limit low', 'Drain-Left: DEANJSTONE/ARGUS#9 slot_park refused'] }))
    expect((await wake(check('afk', AFK_STANDBY, { host: 'homelab' }))).body).toEqual({ wake: true, reason: 'drain', recorded: false })
  })

  it.each([
    ['a routine line that mentions homelab', "free slot held for the homelab trial's next slot after agents#16"],
    ['a loop-state URL on homelab', 'loop-state read failed: https://homelab.example.com:3791 timed out'],
    ['an error that names the slot but has no marker', 'slot_park deanjstone/argus#9 refused'],
    ['the marker naming a slot that is not running on homelab', 'drain-left: deanjstone/argus#10 homelab not reachable'],
    ['the marker naming a longer issue number (#90, not #9)', 'drain-left: deanjstone/argus#90 homelab not reachable'],
    ['the marker mid-line, not at the start', 'note drain-left: deanjstone/argus#9 homelab not reachable'],
    ['an unrelated error', 'gh rate limit low'],
  ])('%s does not wake the standby', async (_name, error) => {
    const { wake, afk } = await ticked()
    await afk.ok('slot_start', { issue: 'deanjstone/argus#9', thread_id: 'homelab-worker', host: 'homelab' })
    await afk.ok('status_tick', modelTick(AFK_THREAD, { slot_cap: 1, window_used_percent: 20, errors: [error] }))
    expect((await wake(check('afk', AFK_STANDBY, { host: 'homelab' }))).body).toEqual({ wake: false, reason: 'primary_alive', recorded: false })
  })
})

describe('POST /wake/check: the drain counts only running homelab slots', () => {
  async function parkedHomelabWorld() {
    const world = await ticked()
    await world.afk.ok('slot_start', { issue: 'deanjstone/budget#240', thread_id: 'homelab-worker', host: 'homelab' })
    await world.afk.ok('status_tick', modelTick(AFK_THREAD, { slot_cap: 2, window_used_percent: 20 }))
    return world
  }

  it('only parked homelab slots: no drain, however long the cadence has run', async () => {
    const { wake, afk, clock } = await parkedHomelabWorld()
    await afk.ok('slot_park', { issue: 'deanjstone/budget#240', note: 'needs:owner' })
    const standby = check('afk', AFK_STANDBY, { host: 'homelab' })
    expect((await wake(standby)).body).toEqual({ wake: false, reason: 'primary_alive', recorded: false })
    clock.advance(40 * MINUTE)
    expect((await wake(standby)).body).toEqual({ wake: false, reason: 'primary_alive', recorded: false })
  })

  it('an un-parked (ready) homelab slot is the lease holder\'s to restart: no drain', async () => {
    const { wake, afk, aquila } = await parkedHomelabWorld()
    await afk.ok('slot_park', { issue: 'deanjstone/budget#240', note: 'needs:owner' })
    await aquila.ok('slot_unpark', { issue: 'deanjstone/budget#240', note: 'owner answered' })
    expect((await wake(check('afk', AFK_STANDBY, { host: 'homelab' }))).body).toEqual({ wake: false, reason: 'primary_alive', recorded: false })
  })

  it('one running homelab slot among parked ones still drains, when the holder cannot reach homelab', async () => {
    const { wake, afk } = await parkedHomelabWorld()
    await afk.ok('slot_park', { issue: 'deanjstone/budget#240', note: 'needs:owner' })
    await afk.ok('slot_start', { issue: 'deanjstone/context#329', thread_id: 'homelab-worker-2', host: 'homelab' })
    await afk.ok('status_tick', modelTick(AFK_THREAD, { slot_cap: 2, window_used_percent: 20, errors: ['drain-left: deanjstone/context#329 homelab not reachable'] }))
    expect((await wake(check('afk', AFK_STANDBY, { host: 'homelab' }))).body).toEqual({ wake: true, reason: 'drain', recorded: false })
  })
})

/**
 * argus#58: the afk lease holder, WSL2 while it is alive, also fills free homelab slots through the linked
 * environment (charter, "Starting slots" under Cross-env control), so room on any host wakes it. The homelab
 * standby that does not hold the lease is never woken for `free_slot`.
 */
describe('POST /wake/check: free_slot counts room on every host the holder may start on', () => {
  const HOST_CAPS = { wsl2: 2, homelab: 1 }

  /** Total cap 3, host caps wsl2 2 / homelab 1, two wsl2 slots running: wsl2 2/2, homelab 0/1. */
  async function wsl2FullHomelabFree() {
    const w = await ticked()
    const tick = () => modelTick(AFK_THREAD, { slot_cap: 3, host_caps: HOST_CAPS, window_used_percent: 20 })
    await w.afk.ok('status_tick', tick())
    await w.afk.ok('slot_start', { issue: 'deanjstone/argus#5', thread_id: 'worker-5', host: 'wsl2' })
    await w.afk.ok('slot_start', { issue: 'deanjstone/argus#6', thread_id: 'worker-6', host: 'wsl2' })
    await w.afk.ok('status_tick', tick())
    return { ...w, tick }
  }

  it('the wsl2 holder at wsl2 2/2 is woken for the free homelab slot (homelab 0/1)', async () => {
    const { wake } = await wsl2FullHomelabFree()
    expect((await wake(check('afk', AFK_THREAD, { takeable: 3 }))).body).toEqual({ wake: true, reason: 'free_slot', recorded: false })
  })

  it('the homelab standby that does not hold afk is not woken for it while the primary is alive', async () => {
    const { wake } = await wsl2FullHomelabFree()
    expect((await wake(check('afk', AFK_STANDBY, { host: 'homelab', takeable: 3 }))).body).toEqual({ wake: false, reason: 'primary_alive', recorded: false })
  })

  it('the homelab entry bounds the homelab room: homelab 1/1 and wsl2 2/2 under a total of 4 wakes nobody', async () => {
    const { wake, afk } = await wsl2FullHomelabFree()
    await afk.ok('status_tick', modelTick(AFK_THREAD, { slot_cap: 4, host_caps: HOST_CAPS, window_used_percent: 20 }))
    await afk.ok('slot_start', { issue: 'deanjstone/homelab#400', thread_id: 'worker-400', host: 'homelab' })
    await afk.ok('status_tick', modelTick(AFK_THREAD, { slot_cap: 4, host_caps: HOST_CAPS, window_used_percent: 20 }))
    expect((await wake(check('afk', AFK_THREAD, { takeable: 3 }))).body).toMatchObject({ wake: false })
  })

  it('the total cap still bounds it: wsl2 2/2, homelab 1/1 and a total of 3 wakes nobody', async () => {
    const { wake, afk, tick } = await wsl2FullHomelabFree()
    await afk.ok('slot_start', { issue: 'deanjstone/homelab#400', thread_id: 'worker-400', host: 'homelab' })
    await afk.ok('status_tick', tick())
    expect((await wake(check('afk', AFK_THREAD, { takeable: 3 }))).body).toMatchObject({ wake: false })
  })

  it('the wsl2 holder at wsl2 2/2 with the homelab entry at 0 is not woken: homelab has no room either', async () => {
    const { wake, afk } = await wsl2FullHomelabFree()
    await afk.ok('status_tick', modelTick(AFK_THREAD, { slot_cap: 3, host_caps: { wsl2: 2, homelab: 0 }, window_used_percent: 20 }))
    expect((await wake(check('afk', AFK_THREAD, { takeable: 3 }))).body).toMatchObject({ wake: false })
  })
})

describe('POST /wake/check: taking a lease answers a wake', () => {
  it('a standby woken to drain, then failing over, is not stalled by that older wake', async () => {
    const { wake, afk, aquila, clock } = await ticked()
    await afk.ok('slot_start', { issue: 'deanjstone/argus#9', thread_id: 'homelab-worker', host: 'homelab' })
    await afk.ok('status_tick', modelTick(AFK_THREAD, { slot_cap: 1, window_used_percent: 20, errors: ['drain-left: deanjstone/argus#9 homelab not reachable'] }))
    expect((await wake(check('afk', AFK_STANDBY, { host: 'homelab' }))).body.reason).toBe('drain') // never answered

    clock.advance(70 * MINUTE)
    expect((await wake(check('afk', AFK_STANDBY, { host: 'homelab' }))).body.reason).toBe('failover')
    await afk.ok('lease_failover', { role: 'afk', to_thread_id: AFK_STANDBY, from_thread_id: AFK_THREAD })
    expect((await aquila.ok('status_read')).wake).toMatchObject({ thread_id: AFK_STANDBY, pending_since: null, unanswered: false })
  })
})

describe('POST /wake/check: other lease positions', () => {
  it('the WSL2 primary, back while its standby holds the lease, wakes to reclaim it', async () => {
    const { wake, afk, clock } = await ticked()
    clock.advance(70 * MINUTE)
    await afk.ok('lease_failover', { role: 'afk', to_thread_id: AFK_STANDBY, from_thread_id: AFK_THREAD })
    expect((await wake(check('afk', AFK_THREAD))).body).toEqual({ wake: true, reason: 'reclaim', recorded: false })
  })

  it('a WSL2 thread that neither holds the lease nor is its primary does not wake', async () => {
    const { wake } = await ticked()
    expect((await wake(check('afk', 'thread-afk-retired'))).body).toEqual({ wake: false, reason: 'not_holder', recorded: false })
  })

  it('nobody holds the lease: no wake', async () => {
    const { post } = world({ leases: {} })
    expect((await post('/wake/check', check('afk', AFK_THREAD), TOKENS.afk)).body).toEqual({ wake: false, reason: 'no_lease', recorded: false })
  })
})

describe('POST /wake/check: auth and validation', () => {
  it('refuses a missing or unknown token, a worker token, and a token for another role', async () => {
    const { wake } = await ticked()
    expect((await wake(check('afk', AFK_THREAD), null as never)).status).toBe(401)
    expect((await wake(check('afk', AFK_THREAD), 'not-a-real-token-0123456789')).status).toBe(401)
    expect((await wake(check('afk', AFK_THREAD), TOKENS.worker)).status).toBe(403)
    expect((await wake(check('afk', AFK_THREAD), TOKENS.direction)).status).toBe(403)
  })

  it.each([
    ['an unknown field', { extra: 1 }],
    ['an unknown host', { host: 'laptop' }],
    ['a blank thread_id', { thread_id: ' ' }],
    ['needs_owner that is not issues', { needs_owner: ['not an issue'] }],
    ['a percentage over 100', { window_used_percent: 101 }],
    ['a negative takeable', { takeable: -1 }],
    ['a fractional takeable', { takeable: 1.5 }],
  ])('refuses %s with 400', async (_label, override) => {
    const { wake } = await ticked()
    const result = await wake(check('afk', AFK_THREAD, override))
    expect(result.status).toBe(400)
    expect(result.body).toHaveProperty('error')
  })

  it('refuses an afk check with no takeable, and a body that is not JSON', async () => {
    const { wake, post } = await ticked()
    const { takeable: _omitted, ...body } = check('afk', AFK_THREAD) as Record<string, unknown>
    expect((await wake(body)).status).toBe(400)
    expect((await post('/wake/check', '{not json', TOKENS.afk)).status).toBe(400)
  })
})
