import { describe, expect, it } from 'vitest'

import { AQUILA_THREAD, MINUTE, text, world } from './helpers.js'

// argus#71 (argus-config/1622, owner decision 11): the host's registered owner chat may call owner_thread_set
// itself, within 30 minutes of its own owner_turn, so a self-handover needs no owner turn in the tick thread:
// the owner starts the new chat, the new chat asks the old one, the old one (the registered chat) registers it.
// The holder's path is unchanged.

const OWNER = 'thread-owner-chat-0001'
const SUCCESSOR = 'thread-owner-chat-0002'
const OWNER_HOMELAB = 'thread-owner-chat-homelab'
const STRAY = 'thread-stray'

/** The tick thread holds the direction lease, the owner is present, OWNER is registered for wsl2 and has taken no turn yet. */
async function registered() {
  const w = world()
  const aquila = await w.as('direction', AQUILA_THREAD)
  await aquila.ok('owner_turn', { caller_thread_id: AQUILA_THREAD })
  await aquila.ok('owner_thread_set', { host: 'wsl2', thread_id: OWNER, caller_thread_id: AQUILA_THREAD })
  const owner = await w.as('direction', OWNER)
  return { ...w, aquila, owner }
}

type Caller = { call: (name: string, args?: Record<string, unknown>) => Promise<any> }

const register = (caller: Caller, thread: string, args: Record<string, unknown> = {}) =>
  caller.call('owner_thread_set', { host: 'wsl2', thread_id: SUCCESSOR, caller_thread_id: thread, ...args })

describe('owner_thread_set from the registered owner chat', () => {
  it("is accepted within 30 minutes of the chat's own owner_turn and replaces the host's owner chat", async () => {
    const { owner, aquila, clock } = await registered()
    await owner.ok('owner_turn', { caller_thread_id: OWNER })
    clock.advance(29 * MINUTE)

    const result = await owner.ok('owner_thread_set', { host: 'wsl2', thread_id: SUCCESSOR, caller_thread_id: OWNER })

    expect(result.owner_threads.wsl2).toBe(SUCCESSOR)
    expect((await aquila.ok('lease_read')).owner_threads.wsl2).toBe(SUCCESSOR)
  })

  it('completes a self-handover: the new thread is registered by the old chat, then takes its own owner_turn', async () => {
    const { owner, as } = await registered()
    const successor = await as('direction', SUCCESSOR)
    expect((await successor.call('owner_turn', { caller_thread_id: SUCCESSOR })).isError).toBe(true)
    await owner.ok('owner_turn', { caller_thread_id: OWNER })

    await owner.ok('owner_thread_set', { host: 'wsl2', thread_id: SUCCESSOR, caller_thread_id: OWNER })

    expect((await successor.call('owner_turn', { caller_thread_id: SUCCESSOR })).isError).toBeFalsy()
  })

  it('is refused after 30 minutes, telling the chat to call owner_turn, and registers nothing', async () => {
    const { owner, aquila, clock } = await registered()
    await owner.ok('owner_turn', { caller_thread_id: OWNER })
    clock.advance(31 * MINUTE)

    const result = await register(owner, OWNER)

    expect(result.isError).toBe(true)
    expect(text(result)).toMatch(/owner_turn/)
    expect((await aquila.ok('lease_read')).owner_threads.wsl2).toBe(OWNER)
  })

  it("is refused when only the tick thread's owner_turn is recent: the window is the chat's own turn", async () => {
    const { owner, aquila } = await registered()

    const result = await register(owner, OWNER)

    expect(result.isError).toBe(true)
    expect(text(result)).toMatch(/owner_turn/)
    expect((await aquila.ok('lease_read')).owner_threads.wsl2).toBe(OWNER)
  })

  it("is refused when the chat's turn was followed by a stepping_away turn", async () => {
    const { owner, aquila } = await registered()
    await owner.ok('owner_turn', { caller_thread_id: OWNER })
    await aquila.ok('owner_turn', { caller_thread_id: AQUILA_THREAD, stepping_away: true })

    const result = await register(owner, OWNER)

    expect(result.isError).toBe(true)
    expect(text(result)).toMatch(/stepped away/)
  })

  it('is refused from an unregistered caller, naming the holder, and registers nothing', async () => {
    const { as, aquila } = await registered()
    const stray = await as('direction', STRAY)

    const result = await register(stray, STRAY)

    expect(result.isError).toBe(true)
    expect(text(result)).toContain(AQUILA_THREAD)
    expect((await aquila.ok('lease_read')).owner_threads.wsl2).toBe(OWNER)
  })

  it('is refused once the chat has been replaced: the old chat no longer registers anything', async () => {
    const { owner, aquila } = await registered()
    await owner.ok('owner_turn', { caller_thread_id: OWNER })
    await owner.ok('owner_thread_set', { host: 'wsl2', thread_id: SUCCESSOR, caller_thread_id: OWNER })

    const result = await register(owner, OWNER, { thread_id: STRAY })

    expect(result.isError).toBe(true)
    expect((await aquila.ok('lease_read')).owner_threads.wsl2).toBe(SUCCESSOR)
  })

  it("is refused for the other host: a chat registers only its own host's successor", async () => {
    const { owner, aquila } = await registered()
    await owner.ok('owner_turn', { caller_thread_id: OWNER })

    const result = await register(owner, OWNER, { host: 'homelab' })

    expect(result.isError).toBe(true)
    expect(text(result)).toContain(AQUILA_THREAD)
    expect((await aquila.ok('lease_read')).owner_threads.homelab).toBeNull()
  })

  it("accepts the other host's registered chat for its own host, on its own turn", async () => {
    const { as, aquila } = await registered()
    await aquila.ok('owner_thread_set', { host: 'homelab', thread_id: OWNER_HOMELAB, caller_thread_id: AQUILA_THREAD })
    const homelab = await as('direction', OWNER_HOMELAB)
    await homelab.ok('owner_turn', { caller_thread_id: OWNER_HOMELAB })

    const result = await homelab.ok('owner_thread_set', { host: 'homelab', thread_id: SUCCESSOR, caller_thread_id: OWNER_HOMELAB })

    expect(result.owner_threads).toMatchObject({ homelab: SUCCESSOR, wsl2: OWNER })
  })

  it('refuses a call naming another thread than the session, as before', async () => {
    const { owner } = await registered()
    await owner.ok('owner_turn', { caller_thread_id: OWNER })
    expect((await register(owner, AQUILA_THREAD)).isError).toBe(true)
  })

  it('is no activity of the lease holder: a stalled tick thread stays stalled', async () => {
    const { owner, aquila, clock } = await registered()
    await aquila.ok('status_tick', { thread_id: AQUILA_THREAD, directives_version: 'v1', needs_owner: [] })
    clock.advance(3 * 60 * MINUTE)
    await owner.ok('owner_turn', { caller_thread_id: OWNER })
    await owner.ok('owner_thread_set', { host: 'wsl2', thread_id: SUCCESSOR, caller_thread_id: OWNER })
    expect((await aquila.ok('status_read', { role: 'direction' })).liveness).toMatchObject({ state: 'stalled' })
  })

  it("leaves the tick thread's own path as it was: the holder needs the owner present", async () => {
    const { aquila, clock } = await registered()
    expect((await register(aquila, AQUILA_THREAD)).isError).toBeFalsy()
    clock.advance(31 * MINUTE)
    const stale = await register(aquila, AQUILA_THREAD, { thread_id: STRAY })
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
      ['slot_unpark', { issue: 'deanjstone/argus#71' }],
    ] as const) {
      const result = await owner.call(name, args)
      expect(result.isError, name).toBe(true)
      expect(text(result), name).toContain(AQUILA_THREAD)
    }
  })
})
