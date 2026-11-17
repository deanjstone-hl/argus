import { describe, expect, it } from 'vitest'

import { fakeGitHub, fakeT3, observe } from './fakes.js'
import { AFK_THREAD, AQUILA_THREAD, MINUTE, text, world } from './helpers.js'

// argus#882 / argus-config#900: a slot write counts only from the thread holding the afk
// lease. The caller says who it is in `caller_thread_id` (slot_start already has `thread_id`
// for the worker), and a non-holder is refused and leaves a lease_conflict event.

const ISSUE = 'deanjstone/argus#701'
const HOME_ISSUE = 'deanjstone/homelab#293'
const STANDBY = 'thread-afk-homelab'
const STRAY = 'thread-stray'
const tick = (thread_id: string) => ({ thread_id, directives_version: 'v1', needs_owner: [] as string[] })

type Caller = Awaited<ReturnType<ReturnType<typeof world>['as']>>

const slotsOf = async (caller: Caller) =>
  ((await caller.ok('slot_list')).slots as { issue: string; state: string; thread_id: string }[]).map(({ issue, state }) => [issue, state])

/** The WSL2 primary stalls, the homelab standby takes the lease, then the primary reclaims it: the standby is a non-holder. */
async function standbyAfterReclaim(clockAdvance: (ms: number) => void, afk: Caller) {
  await afk.ok('status_tick', tick(AFK_THREAD))
  clockAdvance(70 * MINUTE)
  await afk.ok('lease_failover', { role: 'afk', to_thread_id: STANDBY, from_thread_id: AFK_THREAD })
}

describe('slot writes need the afk lease', () => {
  it('accepts every slot write from the holder', async () => {
    const { as } = world()
    const afk = await as('afk')
    const caller_thread_id = AFK_THREAD

    await afk.ok('slot_start', { issue: ISSUE, thread_id: 'worker-1', caller_thread_id })
    await afk.ok('slot_park', { issue: ISSUE, note: 'needs:owner', caller_thread_id })
    await afk.ok('slot_free', { issue: ISSUE, reason: 'withdrawn', caller_thread_id })
    await afk.ok('slot_start', { issue: ISSUE, thread_id: 'worker-2', caller_thread_id })
    await afk.ok('slot_close', { issue: ISSUE, verified: 'Verified: merged', caller_thread_id })
    expect(await slotsOf(afk)).toEqual([])

    const github = fakeGitHub()
    const t3 = fakeT3()
    github.assign(ISSUE, { needsOwner: true, claimedBy: 'worker-y' })
    t3.thread('worker-y', 'idle')
    expect(await afk.ok('slot_rebuild', { ...observe(github, t3), apply: true, caller_thread_id })).toMatchObject({ applied: true })
    expect(await slotsOf(afk)).toEqual([[ISSUE, 'parked']])
  })

  it('refuses every slot write from a thread that is not the holder, naming the holder, and changes nothing', async () => {
    const { as } = world()
    const afk = await as('afk')
    await afk.ok('slot_start', { issue: ISSUE, thread_id: 'worker-1', caller_thread_id: AFK_THREAD })
    const before = await slotsOf(afk)
    const caller_thread_id = STRAY

    const github = fakeGitHub()
    const t3 = fakeT3()
    const calls: [string, Record<string, unknown>][] = [
      ['slot_start', { issue: HOME_ISSUE, thread_id: 'worker-9' }],
      ['slot_park', { issue: ISSUE, note: 'x' }],
      ['slot_close', { issue: ISSUE, verified: 'Verified: merged' }],
      ['slot_free', { issue: ISSUE, reason: 'stale' }],
      ['slot_rebuild', { ...observe(github, t3), apply: true }],
    ]
    for (const [name, args] of calls) {
      const result = await afk.call(name, { ...args, caller_thread_id })
      expect(result.isError, name).toBe(true)
      expect(text(result), name).toContain(AFK_THREAD)
      expect(text(result), name).toMatch(/afk lease/)
    }
    expect(await slotsOf(afk)).toEqual(before)
  })

  it('refuses a slot write when nobody holds the lease', async () => {
    const { as } = world({ leases: {} })
    const afk = await as('afk')
    const result = await afk.call('slot_start', { issue: ISSUE, thread_id: 'worker-1', caller_thread_id: AFK_THREAD })
    expect(result.isError).toBe(true)
    expect(text(result)).toMatch(/no thread holds the afk lease/)
    expect(await slotsOf(afk)).toEqual([])
  })

  it('tells Aquila\'s next gate about a refused write, as a lease conflict', async () => {
    const { as } = world()
    const afk = await as('afk')
    const aquila = await as('direction')
    await aquila.ok('status_tick', tick(AQUILA_THREAD))

    await afk.call('slot_start', { issue: ISSUE, thread_id: 'worker-1', caller_thread_id: STRAY })
    expect(await aquila.ok('tick_gate', tick(AQUILA_THREAD))).toMatchObject({ changed: true, reasons: ['lease_conflict'] })
  })

  it('lets a non-holder compare a rebuild: only the apply writes', async () => {
    const { as } = world()
    const afk = await as('afk')
    const result = await afk.call('slot_rebuild', { ...observe(fakeGitHub(), fakeT3()), caller_thread_id: STRAY })
    expect(result.isError).toBeFalsy()
  })

  it('leaves Aquila\'s rebuild rule alone: she is not the afk lease holder and passes no caller', async () => {
    const { as } = world({ leases: { direction: AQUILA_THREAD } })
    const aquila = await as('direction')
    const github = fakeGitHub()
    github.assign(ISSUE, { needsOwner: true, claimedBy: 'worker-y' })
    const t3 = fakeT3()
    t3.thread('worker-y', 'idle')
    expect(await aquila.ok('slot_rebuild', { ...observe(github, t3), apply: true })).toMatchObject({ applied: true })
  })
})

describe('the standby drain on its own host', () => {
  async function drainWorld() {
    const ctx = world()
    const afk = await ctx.as('afk')
    // One slot per host, started while the primary holds the lease.
    await afk.ok('slot_start', { issue: ISSUE, thread_id: 'worker-wsl', host: 'wsl2', caller_thread_id: AFK_THREAD })
    await afk.ok('slot_start', { issue: HOME_ISSUE, thread_id: 'worker-home', host: 'homelab', caller_thread_id: AFK_THREAD })
    await afk.ok('slot_start', { issue: 'deanjstone/homelab#294', thread_id: 'worker-home-2', host: 'homelab', caller_thread_id: AFK_THREAD })
    await afk.ok('slot_start', { issue: 'deanjstone/homelab#295', thread_id: 'worker-home-3', host: 'homelab', caller_thread_id: AFK_THREAD })
    // The primary stalls, the standby takes the lease, the primary comes back and reclaims it.
    await standbyAfterReclaim(ctx.clock.advance, afk)
    await afk.ok('lease_reclaim', { role: 'afk', to_thread_id: AFK_THREAD, from_thread_id: STANDBY })
    return { ...ctx, afk }
  }

  it('lets the standby close, park and free its own host\'s slots without the lease', async () => {
    const { afk } = await drainWorld()
    const drain = { caller_thread_id: STANDBY, host: 'homelab' }

    await afk.ok('slot_park', { issue: HOME_ISSUE, note: 'needs:owner', ...drain })
    await afk.ok('slot_free', { issue: 'deanjstone/homelab#294', reason: 'standby stood down', ...drain })
    await afk.ok('slot_close', { issue: 'deanjstone/homelab#295', verified: 'Verified: merged', ...drain })
    expect(await slotsOf(afk)).toEqual([
      [ISSUE, 'running'],
      [HOME_ISSUE, 'parked'],
    ])
  })

  it('never lets the standby start a slot', async () => {
    const { afk } = await drainWorld()
    const result = await afk.call('slot_start', { issue: 'deanjstone/homelab#400', thread_id: 'worker-x', host: 'homelab', caller_thread_id: STANDBY })
    expect(result.isError).toBe(true)
    expect(text(result)).toMatch(/afk lease/)
  })

  it('refuses a drain of the other host\'s slot, and a drain that names no host', async () => {
    const { afk } = await drainWorld()

    const otherHost = await afk.call('slot_close', { issue: ISSUE, verified: 'Verified: merged', caller_thread_id: STANDBY, host: 'homelab' })
    expect(otherHost.isError).toBe(true)
    expect(text(otherHost)).toContain(AFK_THREAD)

    const noHost = await afk.call('slot_free', { issue: HOME_ISSUE, reason: 'stale', caller_thread_id: STANDBY })
    expect(noHost.isError).toBe(true)

    expect(await slotsOf(afk)).toContainEqual([ISSUE, 'running'])
    expect(await slotsOf(afk)).toContainEqual([HOME_ISSUE, 'running'])
  })

  it('does not extend the drain to the WSL2 primary while the standby holds the lease: that is the 26 Oct breach', async () => {
    const { as, clock } = world()
    const afk = await as('afk')
    await afk.ok('slot_start', { issue: ISSUE, thread_id: 'worker-wsl', host: 'wsl2', caller_thread_id: AFK_THREAD })
    await standbyAfterReclaim(clock.advance, afk)

    const result = await afk.call('slot_close', { issue: ISSUE, verified: 'Verified: merged', caller_thread_id: AFK_THREAD, host: 'wsl2' })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain(STANDBY)
    expect(await slotsOf(afk)).toEqual([[ISSUE, 'running']])
  })
})

describe('a slot write with no caller_thread_id', () => {
  it('is accepted with a warning event for one release, so a charter that has not been updated keeps working', async () => {
    const { as } = world()
    const afk = await as('afk')
    const aquila = await as('direction')
    await aquila.ok('status_tick', tick(AQUILA_THREAD))

    const started = await afk.ok('slot_start', { issue: ISSUE, thread_id: 'worker-1' })
    expect(started.slot).toMatchObject({ issue: ISSUE, state: 'running' })
    expect(started.warning).toMatch(/caller_thread_id/)
    expect(await aquila.ok('tick_gate', tick(AQUILA_THREAD))).toMatchObject({
      changed: true,
      reasons: expect.arrayContaining(['slot_write_unchecked']),
    })
  })

  it('is refused once the server runs with requireCallerThread', async () => {
    const { as } = world({ requireCallerThread: true })
    const afk = await as('afk')
    const result = await afk.call('slot_start', { issue: ISSUE, thread_id: 'worker-1' })
    expect(result.isError).toBe(true)
    expect(text(result)).toMatch(/caller_thread_id/)
    expect(await slotsOf(afk)).toEqual([])

    expect((await afk.call('slot_start', { issue: ISSUE, thread_id: 'worker-1', caller_thread_id: AFK_THREAD })).isError).toBeFalsy()
  })
})
