import { describe, expect, it } from 'vitest'

import { AFK_THREAD, AQUILA_THREAD, TOKENS, world } from './helpers.js'

/**
 * argus-config#1366: a thread starts slots only on its own host. With the total cap not reached but
 * the waker's own host at its `host_caps` entry, the free slot belongs to the other host, so a
 * `free_slot` wake would run the whole checklist and start nothing.
 */
const HOMELAB_AFK = 'thread-afk-homelab-primary'

const modelTick = (thread_id: string, extra: Record<string, unknown> = {}) => ({
  thread_id,
  directives_version: 'v1',
  needs_owner: [] as string[],
  ...extra,
})

const check = (host: 'wsl2' | 'homelab', thread_id: string, extra: Record<string, unknown> = {}) => ({
  role: 'afk',
  host,
  thread_id,
  directives_version: 'v1',
  needs_owner: [] as string[],
  window_used_percent: 20,
  takeable: 3,
  ...extra,
})

/** Total cap 2, one homelab slot running: homelab used 1, wsl2 used 0. */
async function oneHomelabSlotRunning(hostCaps: { wsl2: number; homelab: number }, holder: { thread: string; host: 'wsl2' | 'homelab' }) {
  const w = world(holder.host === 'homelab' ? { leases: {} } : {})
  const afk = await w.as('afk')
  const aquila = await w.as('direction')
  if (holder.host === 'homelab') await aquila.ok('lease_move', { role: 'afk', to_thread_id: holder.thread, host: 'homelab' })
  const tick = () => modelTick(holder.thread, { slot_cap: 2, host_caps: hostCaps, window_used_percent: 20 })
  await afk.ok('status_tick', tick())
  if (holder.host === 'wsl2') await aquila.ok('status_tick', modelTick(AQUILA_THREAD, { window_used_percent: 20 }))
  await afk.ok('slot_start', { issue: 'deanjstone/homelab#400', thread_id: 'worker-400', host: 'homelab', caller_thread_id: holder.thread })
  await afk.ok('status_tick', tick())
  const wake = (body: Record<string, unknown>) => w.post('/wake/check', body, TOKENS.afk)
  return { ...w, wake }
}

describe('POST /wake/check: free_slot needs room on the waking thread host', () => {
  it('a homelab holder at homelab 1/1 is not woken while only wsl2 (0/2) has room', async () => {
    const { wake } = await oneHomelabSlotRunning({ wsl2: 2, homelab: 1 }, { thread: HOMELAB_AFK, host: 'homelab' })
    expect((await wake(check('homelab', HOMELAB_AFK))).body).toEqual({ wake: false, reason: 'quiet', recorded: true })
  })

  it('the same state wakes a wsl2 holder, whose own host has room', async () => {
    const { wake } = await oneHomelabSlotRunning({ wsl2: 2, homelab: 1 }, { thread: AFK_THREAD, host: 'wsl2' })
    expect((await wake(check('wsl2', AFK_THREAD))).body).toEqual({ wake: true, reason: 'free_slot', recorded: false })
  })

  it('a homelab holder with room under its own cap (homelab 1/2) is woken', async () => {
    const { wake } = await oneHomelabSlotRunning({ wsl2: 2, homelab: 2 }, { thread: HOMELAB_AFK, host: 'homelab' })
    expect((await wake(check('homelab', HOMELAB_AFK))).body).toEqual({ wake: true, reason: 'free_slot', recorded: false })
  })

  it('a host with no entry in host_caps is bounded by the total cap only', async () => {
    const { wake } = await oneHomelabSlotRunning({ wsl2: 2 } as { wsl2: number; homelab: number }, { thread: HOMELAB_AFK, host: 'homelab' })
    expect((await wake(check('homelab', HOMELAB_AFK))).body).toEqual({ wake: true, reason: 'free_slot', recorded: false })
  })
})
