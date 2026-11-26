import { describe, expect, it } from 'vitest'

import { AFK_THREAD, AQUILA_THREAD, MINUTE, text, world } from './helpers.js'

// argus#70 (argus-config/1622, owner decision 8): the host's registered owner chat may call directives_set
// itself, but only within 30 minutes of its own owner_turn, so the owner no longer relays a directives change
// through the tick thread. Every other check of directives_set stays, and the tick's path is unchanged.

const OWNER = 'thread-owner-chat-0001'
const OWNER_HOMELAB = 'thread-owner-chat-homelab'
const STRAY = 'thread-stray'
const MINIMAL = { cadence_minutes: 30, max_slots: 2, repo_holds: [], take_next: [], ordering: [] }

/** The tick thread holds the direction lease, the owner is present, OWNER is registered for wsl2 and has not yet taken a turn. */
async function registered() {
  const w = world()
  const aquila = await w.as('direction', AQUILA_THREAD)
  await aquila.ok('owner_turn', { caller_thread_id: AQUILA_THREAD })
  await aquila.ok('owner_thread_set', { host: 'wsl2', thread_id: OWNER, caller_thread_id: AQUILA_THREAD })
  const owner = await w.as('direction', OWNER)
  return { ...w, aquila, owner }
}

const setFrom = (
  caller: { call: (name: string, args?: Record<string, unknown>) => Promise<any> },
  thread: string,
  args: Record<string, unknown> = {},
) => caller.call('directives_set', { record: MINIMAL, reason: 'owner: "set it"', expected_version: 0, caller_thread_id: thread, ...args })

describe('directives_set from the registered owner chat', () => {
  it('is accepted within 30 minutes of the chat\'s own owner_turn, recorded as the owner chat\'s write', async () => {
    const { owner, aquila, clock } = await registered()
    await owner.ok('owner_turn', { caller_thread_id: OWNER })
    clock.advance(29 * MINUTE)

    const result = await owner.ok('directives_set', { record: MINIMAL, reason: 'owner: "quiet window 04:00-05:00"', expected_version: 0, caller_thread_id: OWNER })

    expect(result.directives).toMatchObject({ version: 1, source: 'owner', set_by: OWNER, reason: 'owner: "quiet window 04:00-05:00"' })
    expect((await aquila.ok('directives_read')).directives).toMatchObject({ version: 1, set_by: OWNER })
  })

  it('is refused after 30 minutes, telling the chat to call owner_turn, and writes nothing', async () => {
    const { owner, aquila, clock } = await registered()
    await owner.ok('owner_turn', { caller_thread_id: OWNER })
    clock.advance(31 * MINUTE)

    const result = await setFrom(owner, OWNER)

    expect(result.isError).toBe(true)
    expect(text(result)).toMatch(/owner_turn/)
    expect(await aquila.ok('directives_read')).toEqual({ directives: null })
  })

  it("is refused when only the tick thread's owner_turn is recent: the window is the chat's own turn", async () => {
    const { owner, aquila } = await registered()

    const result = await setFrom(owner, OWNER)

    expect(result.isError).toBe(true)
    expect(text(result)).toMatch(/owner_turn/)
    expect(await aquila.ok('directives_read')).toEqual({ directives: null })
  })

  it('is refused when the chat\'s turn was followed by a stepping_away turn', async () => {
    const { owner, aquila } = await registered()
    await owner.ok('owner_turn', { caller_thread_id: OWNER })
    await aquila.ok('owner_turn', { caller_thread_id: AQUILA_THREAD, stepping_away: true })

    const result = await setFrom(owner, OWNER)

    expect(result.isError).toBe(true)
    expect(text(result)).toMatch(/stepped away/)
  })

  it('is refused after the chat itself passes stepping_away', async () => {
    const { owner } = await registered()
    await owner.ok('owner_turn', { caller_thread_id: OWNER, stepping_away: true })
    expect((await setFrom(owner, OWNER)).isError).toBe(true)
  })

  it('is refused from an unregistered thread even with the owner present, naming the holder', async () => {
    const { as, aquila } = await registered()
    const stray = await as('direction', STRAY)
    await stray.ok('owner_turn').catch(() => undefined)

    const result = await setFrom(stray, STRAY)

    expect(result.isError).toBe(true)
    expect(text(result)).toContain(AQUILA_THREAD)
    expect(await aquila.ok('directives_read')).toEqual({ directives: null })
  })

  it('is refused once the chat is replaced by another registration', async () => {
    const { owner, aquila } = await registered()
    await owner.ok('owner_turn', { caller_thread_id: OWNER })
    await aquila.ok('owner_thread_set', { host: 'wsl2', thread_id: 'thread-owner-chat-0002', caller_thread_id: AQUILA_THREAD })

    expect((await setFrom(owner, OWNER)).isError).toBe(true)
  })

  it("a replacement chat starts with no turn of its own, and may write after its own owner_turn", async () => {
    const { as, aquila } = await registered()
    const replacement = 'thread-owner-chat-0002'
    await aquila.ok('owner_thread_set', { host: 'wsl2', thread_id: replacement, caller_thread_id: AQUILA_THREAD })
    const next = await as('direction', replacement)
    expect((await setFrom(next, replacement)).isError).toBe(true)

    await next.ok('owner_turn', { caller_thread_id: replacement })

    expect((await setFrom(next, replacement)).isError).toBeFalsy()
  })

  it("accepts the other host's registered chat, on its own turn", async () => {
    const { as, aquila } = await registered()
    await aquila.ok('owner_thread_set', { host: 'homelab', thread_id: OWNER_HOMELAB, caller_thread_id: AQUILA_THREAD })
    const homelab = await as('direction', OWNER_HOMELAB)
    await homelab.ok('owner_turn', { caller_thread_id: OWNER_HOMELAB })

    expect((await setFrom(homelab, OWNER_HOMELAB)).isError).toBeFalsy()
  })

  it('keeps the expected_version check, naming the current version', async () => {
    const { owner, aquila } = await registered()
    await owner.ok('owner_turn', { caller_thread_id: OWNER })
    await setFrom(owner, OWNER)

    const stale = await setFrom(owner, OWNER, { expected_version: 0 })

    expect(stale.isError).toBe(true)
    expect(text(stale)).toMatch(/current version is 1, not 0/)
    expect((await aquila.ok('directives_read')).directives).toMatchObject({ version: 1 })
  })

  it('keeps the reason check', async () => {
    const { owner } = await registered()
    await owner.ok('owner_turn', { caller_thread_id: OWNER })
    const result = await setFrom(owner, OWNER, { reason: '  ' })
    expect(result.isError).toBe(true)
  })

  it('returns a schema error to the chat, listing every problem, so it can correct while the owner is present', async () => {
    const { owner, aquila } = await registered()
    await owner.ok('owner_turn', { caller_thread_id: OWNER })

    const result = await setFrom(owner, OWNER, { record: { ...MINIMAL, max_slot: 2, max_slots: 0 } })

    expect(result.isError).toBe(true)
    expect(text(result)).toMatch(/unknown key: max_slot/)
    expect(text(result)).toMatch(/max_slots must be a positive integer/)
    expect(await aquila.ok('directives_read')).toEqual({ directives: null })

    expect((await setFrom(owner, OWNER)).isError).toBeFalsy()
  })

  it('accepts a patch from the chat', async () => {
    const { owner } = await registered()
    await owner.ok('owner_turn', { caller_thread_id: OWNER })
    await setFrom(owner, OWNER)

    const result = await owner.ok('directives_set', { patch: { set: { max_slots: 3 } }, reason: 'owner: "three slots"', expected_version: 1, caller_thread_id: OWNER })

    expect(result.directives.record).toMatchObject({ max_slots: 3 })
  })

  it('refuses a call naming another thread than the session, as before', async () => {
    const { owner } = await registered()
    await owner.ok('owner_turn', { caller_thread_id: OWNER })
    expect((await setFrom(owner, AQUILA_THREAD)).isError).toBe(true)
  })

  it('is no activity of the lease holder: a stalled tick thread stays stalled', async () => {
    const { owner, aquila, clock } = await registered()
    await aquila.ok('status_tick', { thread_id: AQUILA_THREAD, directives_version: 'v1', needs_owner: [] })
    clock.advance(3 * 60 * MINUTE)
    await owner.ok('owner_turn', { caller_thread_id: OWNER })
    await setFrom(owner, OWNER)
    expect((await aquila.ok('status_read', { role: 'direction' })).liveness).toMatchObject({ state: 'stalled' })
  })

  it("wakes the AFK loop's gate with a directives_set change, as the tick's write does", async () => {
    const { owner, as } = await registered()
    const afk = await as('afk')
    await afk.ok('status_tick', { thread_id: AFK_THREAD, directives_version: 'v1', needs_owner: [] })
    await owner.ok('owner_turn', { caller_thread_id: OWNER })
    await setFrom(owner, OWNER)
    expect(await afk.ok('tick_gate', { thread_id: AFK_THREAD, directives_version: 'v1', needs_owner: [] })).toMatchObject({
      changed: true,
      reasons: expect.arrayContaining(['directives_set']),
    })
  })
})

describe("the tick thread's own directives_set path", () => {
  it('still needs the owner present and the direction lease, as before', async () => {
    const { aquila, clock } = await registered()
    expect((await setFrom(aquila, AQUILA_THREAD)).isError).toBeFalsy()
    clock.advance(31 * MINUTE)
    const stale = await setFrom(aquila, AQUILA_THREAD, { expected_version: 1 })
    expect(stale.isError).toBe(true)
    expect(text(stale)).toMatch(/owner is not present/)
  })
})

describe('every other write from the owner chat is still refused', () => {
  it('slot_unpark, away_note and status_tick name the holder', async () => {
    const { owner } = await registered()
    await owner.ok('owner_turn', { caller_thread_id: OWNER })
    for (const [name, args] of [
      ['away_note', { text: 'x' }],
      ['status_tick', { thread_id: OWNER, directives_version: 'v1', needs_owner: [] }],
      ['slot_unpark', { issue: 'deanjstone/argus#70' }],
    ] as const) {
      const result = await owner.call(name, args)
      expect(result.isError, name).toBe(true)
      expect(text(result), name).toContain(AQUILA_THREAD)
    }
  })
})
