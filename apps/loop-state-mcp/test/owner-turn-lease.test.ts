import { describe, expect, it } from 'vitest'

import { AQUILA_THREAD, text, world } from './helpers.js'

// argus#1042 / argus-config#1031: owner_turn counts only from the thread holding the direction
// lease, as a slot write counts only from the afk lease holder (argus#882). The caller says who
// it is in `caller_thread_id`; a non-holder is refused and leaves a lease_conflict event.

const STRAY = 'thread-stray'
const tick = (thread_id: string) => ({ thread_id, directives_version: 'v1', needs_owner: [] as string[] })

const presence = async (caller: Awaited<ReturnType<ReturnType<typeof world>['as']>>) => (await caller.ok('ledger_read')).owner

describe('owner_turn needs the direction lease', () => {
  it('records the turn from the holder', async () => {
    const { as, clock } = world()
    const aquila = await as('direction')

    const result = await aquila.ok('owner_turn', { caller_thread_id: AQUILA_THREAD })
    expect(result.warning).toBeUndefined()
    expect(await presence(aquila)).toEqual({ last_turn_at: clock.iso(), present: true, stepped_away: false })
  })

  it('refuses a thread that is not the holder, naming the holder, and records no turn', async () => {
    const { as } = world()
    const aquila = await as('direction')
    await aquila.ok('away_note', { text: 'pending line' })

    const result = await aquila.call('owner_turn', { caller_thread_id: STRAY, stepping_away: true })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain(AQUILA_THREAD)
    expect(text(result)).toMatch(/direction lease/)
    expect(await presence(aquila)).toEqual({ last_turn_at: null, present: false, stepped_away: false })
    expect((await aquila.ok('owner_turn', { caller_thread_id: AQUILA_THREAD })).since_you_left).toHaveLength(1)
  })

  it('refuses a caller when nobody holds the direction lease', async () => {
    const { as } = world({ leases: {} })
    const aquila = await as('direction')
    const result = await aquila.call('owner_turn', { caller_thread_id: AQUILA_THREAD })
    expect(result.isError).toBe(true)
    expect(text(result)).toMatch(/no thread holds the direction lease/)
    expect(await presence(aquila)).toMatchObject({ last_turn_at: null })
  })

  it("tells Aquila's next gate about a refused turn, as a lease conflict", async () => {
    const { as } = world()
    const aquila = await as('direction')
    await aquila.ok('status_tick', tick(AQUILA_THREAD))

    await aquila.call('owner_turn', { caller_thread_id: STRAY })
    expect(await aquila.ok('tick_gate', tick(AQUILA_THREAD))).toMatchObject({ changed: true, reasons: ['lease_conflict'] })
  })
})

describe('owner_turn with no caller_thread_id', () => {
  it('is accepted with a warning and an event for one release, so a charter that has not been updated keeps working', async () => {
    const { as, clock } = world()
    const aquila = await as('direction')
    await aquila.ok('status_tick', tick(AQUILA_THREAD))

    const result = await aquila.ok('owner_turn')
    expect(result.warning).toMatch(/caller_thread_id/)
    expect(await presence(aquila)).toMatchObject({ last_turn_at: clock.iso(), present: true })
    expect(await aquila.ok('tick_gate', tick(AQUILA_THREAD))).toMatchObject({
      changed: true,
      reasons: expect.arrayContaining(['owner_turn_unchecked']),
    })
  })

  it('is refused once the server runs with requireCallerThread', async () => {
    const { as } = world({ requireCallerThread: true })
    const aquila = await as('direction')
    const result = await aquila.call('owner_turn')
    expect(result.isError).toBe(true)
    expect(text(result)).toMatch(/caller_thread_id/)
    expect(await presence(aquila)).toMatchObject({ last_turn_at: null })

    expect((await aquila.call('owner_turn', { caller_thread_id: AQUILA_THREAD })).isError).toBeFalsy()
  })
})
