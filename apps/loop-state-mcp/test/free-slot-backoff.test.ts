import { describe, expect, it } from 'vitest'

import { AFK_THREAD, AQUILA_THREAD, MINUTE, TOKENS, world } from './helpers.js'

/**
 * argus-config#1357: a parked slot whose worker is still live holds its host, but loop-state counts
 * only running slots, so `free_slot` woke the AFK thread every poll while the tick ended with nothing
 * to start. After a `free_slot` wake the model answered, the same answer stays quiet until the slot
 * set, the takeable counts or the pressure level change (the 4 h heartbeat still fires).
 */
const modelTick = (thread_id: string, extra: Record<string, unknown> = {}) => ({
  thread_id,
  directives_version: 'v1',
  needs_owner: [] as string[],
  ...extra,
})

const check = (extra: Record<string, unknown> = {}) => ({
  role: 'afk',
  host: 'wsl2',
  thread_id: AFK_THREAD,
  directives_version: 'v1',
  needs_owner: [] as string[],
  window_used_percent: 20,
  takeable: 3,
  ...extra,
})

/** One homelab slot parked behind a live worker, a host cap of 1 and takeable work: the issue's state. */
async function parkedHomelab() {
  const w = world()
  const afk = await w.as('afk')
  const aquila = await w.as('direction')
  const tick = () => modelTick(AFK_THREAD, { slot_cap: 2, host_caps: { wsl2: 1, homelab: 1 }, window_used_percent: 20 })
  await afk.ok('status_tick', tick())
  await aquila.ok('status_tick', modelTick(AQUILA_THREAD, { window_used_percent: 20 }))
  await afk.ok('slot_start', { issue: 'deanjstone/homelab#400', thread_id: 'worker-400', host: 'homelab' })
  await afk.ok('slot_park', { issue: 'deanjstone/homelab#400', note: 'approval prompt, worker live' })
  await afk.ok('status_tick', tick())
  const wake = (body: Record<string, unknown>) => w.post('/wake/check', body, TOKENS.afk)
  return { ...w, afk, wake, tick }
}

describe('POST /wake/check: free_slot backs off after an answered wake', () => {
  it('the first poll wakes; once the model has answered it, the same poll stays quiet and recorded, every 10 min', async () => {
    const { wake, afk, tick, clock } = await parkedHomelab()
    expect((await wake(check())).body).toEqual({ wake: true, reason: 'free_slot', recorded: false })
    await afk.ok('status_tick', tick()) // the tick answers it and starts no slot

    for (let poll = 0; poll < 6; poll += 1) {
      clock.advance(10 * MINUTE)
      expect((await wake(check())).body).toEqual({ wake: false, reason: 'quiet', recorded: true })
    }
  })

  it('a wake the model has not answered wakes again, as before', async () => {
    const { wake, clock } = await parkedHomelab()
    expect((await wake(check())).body).toMatchObject({ wake: true, reason: 'free_slot' })
    clock.advance(10 * MINUTE)
    expect((await wake(check())).body).toMatchObject({ wake: true, reason: 'free_slot' })
  })

  it('wakes again when the takeable count changes, then backs off on the new count', async () => {
    const { wake, afk, tick, clock } = await parkedHomelab()
    await wake(check())
    await afk.ok('status_tick', tick())
    clock.advance(10 * MINUTE)
    expect((await wake(check())).body).toMatchObject({ wake: false })

    clock.advance(10 * MINUTE)
    expect((await wake(check({ takeable: 4 }))).body).toMatchObject({ wake: true, reason: 'free_slot' })
    await afk.ok('status_tick', tick())
    clock.advance(10 * MINUTE)
    expect((await wake(check({ takeable: 4 }))).body).toMatchObject({ wake: false })
  })

  it('wakes again once the slot set changes: the parked worker finishes and the slot closes', async () => {
    const { wake, afk, tick, clock } = await parkedHomelab()
    await wake(check())
    await afk.ok('status_tick', tick())
    clock.advance(10 * MINUTE)
    expect((await wake(check())).body).toMatchObject({ wake: false })

    await afk.ok('slot_free', { issue: 'deanjstone/homelab#400', reason: 'worker finished' })
    await afk.ok('status_tick', tick())
    clock.advance(10 * MINUTE)
    expect((await wake(check())).body).toMatchObject({ wake: true, reason: 'free_slot' })
  })

  it('wakes again when host_gates_ok goes false and back: the held answer does not outlive a closed gate', async () => {
    const { wake, afk, tick, clock } = await parkedHomelab()
    await wake(check())
    await afk.ok('status_tick', tick())
    clock.advance(10 * MINUTE)
    expect((await wake(check({ host_gates_ok: false }))).body).toMatchObject({ wake: false })
    clock.advance(10 * MINUTE)
    expect((await wake(check())).body).toMatchObject({ wake: true, reason: 'free_slot' })
  })

  it('the 4 h heartbeat still wakes a backed-off thread', async () => {
    const { wake, afk, tick, clock } = await parkedHomelab()
    await wake(check())
    await afk.ok('status_tick', tick())
    let reason = 'quiet'
    for (let poll = 0; poll < 30 && reason === 'quiet'; poll += 1) {
      clock.advance(10 * MINUTE)
      reason = ((await wake(check())).body as { reason: string }).reason
    }
    expect(reason).toBe('heartbeat')
  })
})
