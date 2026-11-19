import { describe, expect, it } from 'vitest'

import { AFK_THREAD, AQUILA_THREAD, text, world } from './helpers.js'

// argus#51: `caller_thread_id` is self-asserted, and a T3 fork inherits its parent's id, so a fork
// could call as the lease holder. The harness's headersHelper now sends the session's own thread
// id (T3 sets it per thread in the Claude process env) as X-T3-Thread-Id. A header that differs
// from the thread a call names is refused; a call with no header is accepted until the server
// runs with requireThreadHeader, once every caller sends it.

const FORK = 'thread-aquila-fork-0002'
const WORKER = 'worker-1'
const A = 'deanjstone/argus#701'
const PR = 'https://github.com/deanjstone/argus/pull/9001'
const tick = (thread_id: string) => ({ thread_id, directives_version: 'v1', needs_owner: [] as string[] })

describe('a fork calling as the direction lease holder', () => {
  it('is refused on owner_turn when the header names the fork, and records no turn', async () => {
    const { as } = world()
    const holder = await as('direction', AQUILA_THREAD)
    const fork = await as('direction', FORK)

    const result = await fork.call('owner_turn', { caller_thread_id: AQUILA_THREAD })

    expect(result.isError).toBe(true)
    expect(text(result)).toContain(FORK)
    expect(text(result)).toMatch(/X-T3-Thread-Id/)
    expect((await holder.ok('ledger_read')).owner).toMatchObject({ last_turn_at: null, present: false })
  })

  it('leaves a lease_conflict event for the holder\'s next gate', async () => {
    const { as } = world()
    const holder = await as('direction', AQUILA_THREAD)
    const fork = await as('direction', FORK)
    await holder.ok('status_tick', tick(AQUILA_THREAD))

    await fork.call('owner_turn', { caller_thread_id: AQUILA_THREAD })

    expect(await holder.ok('tick_gate', tick(AQUILA_THREAD))).toMatchObject({ changed: true, reasons: ['lease_conflict'] })
  })

  it('cannot dodge the check by leaving caller_thread_id out: the header is the caller', async () => {
    const { as } = world()
    const fork = await as('direction', FORK)

    const result = await fork.call('owner_turn')

    expect(result.isError).toBe(true)
    expect(text(result)).toMatch(/direction lease/)
  })

  it('is refused on a tick that names the holder, and records nothing', async () => {
    const { as } = world()
    const holder = await as('direction', AQUILA_THREAD)
    const fork = await as('direction', FORK)

    for (const tool of ['status_tick', 'tick_gate']) {
      const result = await fork.call(tool, tick(AQUILA_THREAD))
      expect(result.isError, tool).toBe(true)
      expect(text(result)).toContain(FORK)
    }
    expect((await holder.ok('status_read', { role: 'direction' })).thread_id ?? null).toBeNull()
  })

  it('is refused on directives_set', async () => {
    const { as } = world()
    const fork = await as('direction', FORK)
    const result = await fork.call('directives_set', {
      record: { cadence_minutes: 30, max_slots: 4, repo_holds: [], take_next: [], ordering: [] },
      reason: 'fork',
      expected_version: 0,
      caller_thread_id: AQUILA_THREAD,
    })
    expect(result.isError).toBe(true)
    expect(text(result)).toMatch(/X-T3-Thread-Id/)
  })
})

describe('the real holder, whose header matches', () => {
  it('records an owner turn, with or without naming itself', async () => {
    const { as } = world()
    const holder = await as('direction', AQUILA_THREAD)

    const named = await holder.ok('owner_turn', { caller_thread_id: AQUILA_THREAD })
    expect(named.warning).toBeUndefined()
    const bare = await holder.ok('owner_turn')
    expect(bare.warning).toBeUndefined()
    expect((await holder.ok('ledger_read')).owner).toMatchObject({ present: true })
  })

  it('ticks as itself', async () => {
    const { as } = world()
    const holder = await as('direction', AQUILA_THREAD)
    expect(await holder.ok('status_tick', tick(AQUILA_THREAD))).toMatchObject({ recorded: true })
  })
})

describe('a stray afk-token thread', () => {
  it('cannot start a slot as the afk holder', async () => {
    const { as } = world()
    const fork = await as('afk', FORK)
    const result = await fork.call('slot_start', { issue: A, thread_id: WORKER, caller_thread_id: AFK_THREAD })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain(FORK)
    expect((await fork.ok('slot_list')).slots).toEqual([])
  })

  it('cannot rebuild, close or free as the holder', async () => {
    const { as } = world()
    const holder = await as('afk', AFK_THREAD)
    await holder.ok('slot_start', { issue: A, thread_id: WORKER, caller_thread_id: AFK_THREAD })
    const fork = await as('afk', FORK)

    for (const [tool, args] of [
      ['slot_close', { issue: A, verified: 'Verified: x', caller_thread_id: AFK_THREAD }],
      ['slot_free', { issue: A, reason: 'x', caller_thread_id: AFK_THREAD }],
      ['slot_park', { issue: A, caller_thread_id: AFK_THREAD }],
      ['slot_rebuild', { issues: [], threads: [], caller_thread_id: AFK_THREAD }],
    ] as const) {
      const result = await fork.call(tool, args)
      expect(result.isError, tool).toBe(true)
    }
    expect((await holder.ok('slot_list')).slots).toHaveLength(1)
  })

  it('lets the holder start a slot', async () => {
    const { as } = world()
    const holder = await as('afk', AFK_THREAD)
    const result = await holder.call('slot_start', { issue: A, thread_id: WORKER, caller_thread_id: AFK_THREAD })
    expect(result.isError).toBeFalsy()
  })
})

describe('a worker reporting for a slot', () => {
  it('is refused when the header is not the thread it names', async () => {
    const { as } = world()
    const afk = await as('afk', AFK_THREAD)
    await afk.ok('slot_start', { issue: A, thread_id: WORKER, caller_thread_id: AFK_THREAD })
    const impostor = await as('worker', 'worker-2')

    const report = await impostor.call('slot_report', { issue: A, thread_id: WORKER, outcome: 'complete' })
    const wait = await impostor.call('slot_await_ci', { issue: A, thread_id: WORKER, ref: PR })

    expect(report.isError).toBe(true)
    expect(wait.isError).toBe(true)
    expect(text(report)).toMatch(/X-T3-Thread-Id/)
    expect((await impostor.ok('slot_list')).slots[0]).toMatchObject({ state: 'running', report: null })
  })

  it('reports for its own slot when the header matches', async () => {
    const { as } = world()
    const afk = await as('afk', AFK_THREAD)
    await afk.ok('slot_start', { issue: A, thread_id: WORKER, caller_thread_id: AFK_THREAD })
    const worker = await as('worker', WORKER)

    const result = await worker.call('slot_report', { issue: A, thread_id: WORKER, outcome: 'complete' })
    expect(result.isError).toBeFalsy()
  })
})

describe('a caller that sends no header yet', () => {
  it('is accepted, so callers keep working until the helper ships', async () => {
    const { as } = world()
    const aquila = await as('direction')
    expect((await aquila.call('owner_turn', { caller_thread_id: AQUILA_THREAD })).isError).toBeFalsy()
    expect((await aquila.call('status_tick', tick(AQUILA_THREAD))).isError).toBeFalsy()
  })

  it('is logged once per thread, so the rollout shows who still sends none', async () => {
    const notices: string[] = []
    const { as } = world({ warn: (message) => notices.push(message) })
    const aquila = await as('direction')
    await aquila.call('owner_turn', { caller_thread_id: AQUILA_THREAD })
    await aquila.call('owner_turn', { caller_thread_id: AQUILA_THREAD })
    expect(notices).toHaveLength(1)
    expect(notices[0]).toContain(AQUILA_THREAD)
    expect(notices[0]).toMatch(/X-T3-Thread-Id/)
  })

  it('is refused on an identity call once the server runs with requireThreadHeader, and still reads', async () => {
    const { as } = world({ requireThreadHeader: true })
    const aquila = await as('direction')

    const result = await aquila.call('owner_turn', { caller_thread_id: AQUILA_THREAD })
    expect(result.isError).toBe(true)
    expect(text(result)).toMatch(/X-T3-Thread-Id/)
    expect((await aquila.call('status_tick', tick(AQUILA_THREAD))).isError).toBe(true)
    expect((await aquila.call('slot_list')).isError).toBeFalsy()
    expect((await aquila.call('lease_read')).isError).toBeFalsy()

    const sending = await as('direction', AQUILA_THREAD)
    expect((await sending.call('owner_turn', { caller_thread_id: AQUILA_THREAD })).isError).toBeFalsy()
  })
})

describe('an empty header', () => {
  it('counts as no header', async () => {
    const { as } = world()
    const aquila = await as('direction', '   ')
    expect((await aquila.call('owner_turn', { caller_thread_id: AQUILA_THREAD })).isError).toBeFalsy()
  })
})
