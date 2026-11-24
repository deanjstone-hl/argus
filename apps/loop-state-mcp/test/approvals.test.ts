import { DatabaseSync } from 'node:sqlite'

import { describe, expect, it } from 'vitest'

import { MIGRATIONS } from '../src/store.js'
import { AFK_THREAD, MIGRATION_TEST_TIMEOUT_MS, MINUTE, TOKENS, tempDbPath, text, world } from './helpers.js'

/**
 * argus#836: the AFK tick reports each running worker's pendingRequestCount through
 * status_tick, and POST /wake/check wakes the AFK thread while any running slot has one.
 */
const ISSUE = 'deanjstone/argus#5'
const OTHER = 'deanjstone/argus#6'

const tickBody = (extra: Record<string, unknown> = {}) => ({
  thread_id: AFK_THREAD,
  directives_version: 'v1',
  needs_owner: [] as string[],
  slot_cap: 3,
  window_used_percent: 20,
  ...extra,
})

const wakeBody = (extra: Record<string, unknown> = {}) => ({
  role: 'afk',
  host: 'wsl2',
  thread_id: AFK_THREAD,
  directives_version: 'v1',
  needs_owner: [] as string[],
  window_used_percent: 20,
  takeable: 0,
  ...extra,
})

/** Two running slots and a model tick that has seen them, so nothing else is pending. */
async function running() {
  const w = world()
  const afk = await w.as('afk')
  await afk.ok('slot_start', { issue: ISSUE, thread_id: 'worker-1' })
  await afk.ok('slot_start', { issue: OTHER, thread_id: 'worker-2' })
  await afk.ok('status_tick', tickBody())
  const wake = (extra: Record<string, unknown> = {}) => w.post('/wake/check', wakeBody(extra), TOKENS.afk)
  return { ...w, afk, wake }
}

describe('status_tick pending_approvals', () => {
  it('stores the count per slot and returns it from slot_list and status_read', async () => {
    const { afk } = await running()
    await afk.ok('status_tick', tickBody({ pending_approvals: { [ISSUE]: 1 } }))

    const slots = (await afk.ok('slot_list')).slots
    expect(slots.find((slot: any) => slot.issue === ISSUE)).toMatchObject({ pending_approvals: 1 })
    expect(slots.find((slot: any) => slot.issue === OTHER)).toMatchObject({ pending_approvals: 0 })
    expect((await afk.ok('status_read')).slots.pending_approvals).toEqual({ [ISSUE]: 1 })
  })

  it('is readable by the worker role too, and 0 clears a count', async () => {
    const { afk, as } = await running()
    await afk.ok('status_tick', tickBody({ pending_approvals: { [ISSUE]: 2, [OTHER]: 1 } }))
    const worker = await as('worker')
    expect((await worker.ok('status_read')).slots.pending_approvals).toEqual({ [ISSUE]: 2, [OTHER]: 1 })

    await afk.ok('status_tick', tickBody({ pending_approvals: { [ISSUE]: 0 } }))
    expect((await worker.ok('status_read')).slots.pending_approvals).toEqual({ [OTHER]: 1 })
  })

  it('leaves counts unchanged when the field is omitted, and carries them over a quiet tick_gate', async () => {
    const { afk } = await running()
    await afk.ok('status_tick', tickBody({ pending_approvals: { [ISSUE]: 1 } }))
    await afk.ok('status_tick', tickBody())
    await afk.ok('tick_gate', tickBody())
    expect((await afk.ok('status_read')).slots.pending_approvals).toEqual({ [ISSUE]: 1 })
  })

  it('ignores an issue with no slot (freed since the tick read it) without failing the tick', async () => {
    const { afk } = await running()
    const tick = await afk.ok('status_tick', tickBody({ pending_approvals: { 'deanjstone/argus#99': 1, [ISSUE]: 1 } }))
    expect(tick.recorded).toBe(true)
    expect((await afk.ok('status_read')).slots.pending_approvals).toEqual({ [ISSUE]: 1 })
  })

  it('records nothing for a thread that does not hold the lease', async () => {
    const { afk } = await running()
    const stray = await afk.ok('status_tick', tickBody({ thread_id: 'thread-afk-stray', pending_approvals: { [ISSUE]: 1 } }))
    expect(stray.recorded).toBe(false)
    expect((await afk.ok('status_read')).slots.pending_approvals).toEqual({})
  })

  it.each([
    ['a negative count', { [ISSUE]: -1 }],
    ['a fractional count', { [ISSUE]: 1.5 }],
    ['a key that is not an issue', { 'not an issue': 1 }],
  ])('refuses %s', async (_label, pending_approvals) => {
    const { afk } = await running()
    expect((await afk.call('status_tick', tickBody({ pending_approvals }))).isError).toBe(true)
  })

  it('a rejected tick changes no count', async () => {
    const { afk } = await running()
    await afk.ok('status_tick', tickBody({ pending_approvals: { [ISSUE]: 1 } }))
    expect((await afk.call('status_tick', tickBody({ pending_approvals: { [OTHER]: 1, 'not an issue': 1 } }))).isError).toBe(true)
    expect((await afk.ok('status_read')).slots.pending_approvals).toEqual({ [ISSUE]: 1 })
  })
})

/**
 * argus-config#1688: a worker parked on an approval prompt is still resident and resumes the moment the owner answers.
 * On 25 Nov 2026 three such slots were parked on WSL2 (cap 2), the tick filled the two "free" slots, and clearing the
 * prompts put five workers live on a 5 GB host.
 */
describe('a slot parked on an approval prompt keeps its place under the caps', () => {
  const THIRD = 'deanjstone/argus#7'
  const capTwo = { slot_cap: 2, host_caps: { wsl2: 2 } }

  it('holds the place when a tick reported the prompt, and refuses the start that would overcommit the host', async () => {
    const { afk } = await running()
    await afk.ok('status_tick', tickBody({ ...capTwo, pending_approvals: { [ISSUE]: 1 } }))
    const parked = await afk.ok('slot_park', { issue: ISSUE, note: 'approval waiting in T3 thread worker-1' })
    expect(parked.slot).toMatchObject({ state: 'parked', holds_place: true, pending_approvals: 0 })

    const refused = await afk.call('slot_start', { issue: THIRD, thread_id: 'worker-3' })
    expect(refused.isError).toBe(true)
    expect(text(refused)).toMatch(/the effective slot cap 2 is reached \(2 running\)/)
    expect((await afk.ok('status_read')).slots).toMatchObject({ used: 2, free: 0, parked: 1, holding: 1, hosts: { wsl2: { used: 2 } } })
  })

  it('holds the place when the parking tick passes the count it read itself', async () => {
    const { afk } = await running()
    await afk.ok('status_tick', tickBody(capTwo))
    const parked = await afk.ok('slot_park', { issue: ISSUE, pending_approvals: 1 })
    expect(parked.slot).toMatchObject({ state: 'parked', holds_place: true })
    expect((await afk.call('slot_start', { issue: THIRD, thread_id: 'worker-3' })).isError).toBe(true)
  })

  it('gives the place up when the worker waits on no prompt, as before', async () => {
    const { afk } = await running()
    await afk.ok('status_tick', tickBody(capTwo))
    expect((await afk.ok('slot_park', { issue: ISSUE, note: 'needs:owner' })).slot).toMatchObject({ holds_place: false })
    expect((await afk.ok('slot_start', { issue: THIRD, thread_id: 'worker-3' })).slot).toMatchObject({ state: 'running' })
    expect((await afk.ok('status_read')).slots).toMatchObject({ used: 2, parked: 1, holding: 0 })
  })

  it('returns the same worker to running after the un-park without a cap check, and frees the place when it ends', async () => {
    const { afk, as } = await running()
    await afk.ok('status_tick', tickBody({ ...capTwo, pending_approvals: { [ISSUE]: 1 } }))
    await afk.ok('slot_park', { issue: ISSUE })
    const aquila = await as('direction')
    expect((await aquila.ok('slot_unpark', { issue: ISSUE })).slot).toMatchObject({ state: 'ready', holds_place: true })
    expect((await afk.call('slot_start', { issue: THIRD, thread_id: 'worker-3' })).isError).toBe(true)

    expect((await afk.ok('slot_start', { issue: ISSUE, thread_id: 'worker-1' })).slot).toMatchObject({ state: 'running', holds_place: false })
    await afk.ok('slot_close', { issue: ISSUE, verified: 'Verified: merged' })
    expect((await afk.ok('slot_start', { issue: THIRD, thread_id: 'worker-3' })).slot).toMatchObject({ state: 'running' })
  })

  it('checks the caps when a ready slot that held its place restarts on another worker thread', async () => {
    const { afk, as } = await running()
    await afk.ok('status_tick', tickBody({ ...capTwo, pending_approvals: { [ISSUE]: 1 } }))
    await afk.ok('slot_park', { issue: ISSUE })
    await (await as('direction')).ok('slot_unpark', { issue: ISSUE })
    const refused = await afk.call('slot_start', { issue: ISSUE, thread_id: 'worker-9' })
    expect(refused.isError).toBe(true)
    expect(text(refused)).toMatch(/slot cap 2 is reached/)
  })

  it('refuses a negative or fractional pending_approvals on slot_park', async () => {
    const { afk } = await running()
    expect((await afk.call('slot_park', { issue: ISSUE, pending_approvals: -1 })).isError).toBe(true)
    expect((await afk.call('slot_park', { issue: ISSUE, pending_approvals: 0.5 })).isError).toBe(true)
  })
})

describe('a slot with pending approvals clears when it is parked, closed, freed or restarted', () => {
  it('slot_park clears the count', async () => {
    const { afk } = await running()
    await afk.ok('status_tick', tickBody({ pending_approvals: { [ISSUE]: 1 } }))
    await afk.ok('slot_park', { issue: ISSUE, note: 'approval waiting in T3 thread worker-1' })
    expect((await afk.ok('status_read')).slots.pending_approvals).toEqual({})
    expect((await afk.ok('slot_list', { state: 'parked' })).slots[0]).toMatchObject({ pending_approvals: 0 })
  })

  it('slot_close and slot_free remove the slot, so its count goes with it', async () => {
    const { afk } = await running()
    await afk.ok('status_tick', tickBody({ pending_approvals: { [ISSUE]: 1, [OTHER]: 1 } }))
    await afk.ok('slot_close', { issue: ISSUE, verified: 'Verified: merged' })
    await afk.ok('slot_free', { issue: OTHER, reason: 'worker gone' })
    expect((await afk.ok('status_read')).slots.pending_approvals).toEqual({})
  })

  it('a ready slot restarted by slot_start begins at 0', async () => {
    const { afk, as } = await running()
    const aquila = await as('direction')
    await afk.ok('status_tick', tickBody({ pending_approvals: { [ISSUE]: 1 } }))
    await afk.ok('slot_park', { issue: ISSUE })
    await aquila.ok('slot_unpark', { issue: ISSUE })
    const restarted = await afk.ok('slot_start', { issue: ISSUE, thread_id: 'worker-3' })
    expect(restarted.slot).toMatchObject({ state: 'running', pending_approvals: 0 })
  })
})

describe('POST /wake/check: pending_approvals', () => {
  it('a running slot with pending_approvals 1 wakes the AFK thread, even with nothing else changed', async () => {
    const { afk, wake } = await running()
    await afk.ok('status_tick', tickBody({ pending_approvals: { [ISSUE]: 1 } }))
    expect((await wake()).body).toEqual({ wake: true, reason: 'pending_approvals', recorded: false })
  })

  it('without one, a quiet tick stays quiet', async () => {
    const { clock, wake } = await running()
    clock.advance(30 * MINUTE)
    expect((await wake()).body).toEqual({ wake: false, reason: 'quiet', recorded: true })
  })

  it('wakes whatever the window pressure, since parking costs no slot', async () => {
    const { afk, wake } = await running()
    await afk.ok('status_tick', tickBody({ window_used_percent: 96, pending_approvals: { [ISSUE]: 1 } }))
    expect((await wake({ window_used_percent: 96 })).body).toMatchObject({ wake: true, reason: 'pending_approvals' })
  })

  it('keeps waking until the count is cleared, then goes quiet again', async () => {
    const { afk, wake, clock } = await running()
    await afk.ok('status_tick', tickBody({ pending_approvals: { [ISSUE]: 1 } }))
    clock.advance(5 * MINUTE)
    expect((await wake()).body.reason).toBe('pending_approvals')
    await afk.ok('status_tick', tickBody({ pending_approvals: { [ISSUE]: 0 } }))
    clock.advance(30 * MINUTE)
    expect((await wake()).body).toEqual({ wake: false, reason: 'quiet', recorded: true })
  })

  it('is cleared by parking, closing or freeing the slot', async () => {
    const { afk, wake, clock } = await running()
    await afk.ok('status_tick', tickBody({ pending_approvals: { [ISSUE]: 1, [OTHER]: 1 } }))
    await afk.ok('slot_park', { issue: ISSUE })
    await afk.ok('slot_free', { issue: OTHER, reason: 'worker gone' })
    await afk.ok('status_tick', tickBody())
    clock.advance(30 * MINUTE)
    expect((await wake()).body).toEqual({ wake: false, reason: 'quiet', recorded: true })
  })

  it('a wake for it is answered like any other, and an unanswered one alone leaves liveness late', async () => {
    const { afk, wake, clock, as } = await running()
    const direction = await as('direction')
    await afk.ok('status_tick', tickBody({ pending_approvals: { [ISSUE]: 1 } }))
    expect((await wake()).body.reason).toBe('pending_approvals')
    clock.advance(11 * MINUTE)
    expect((await direction.ok('status_read')).liveness.state).toBe('late')
  })

  it('does not wake Aquila: the direction role has no pending_approvals reason', async () => {
    const { afk, as, post } = await running()
    const direction = await as('direction')
    await direction.ok('status_tick', { thread_id: 'thread-aquila-0001', directives_version: 'v1', needs_owner: [], window_used_percent: 20 })
    await afk.ok('status_tick', tickBody({ pending_approvals: { [ISSUE]: 1 } }))
    const body = { role: 'direction', host: 'wsl2', thread_id: 'thread-aquila-0001', directives_version: 'v1', needs_owner: [], window_used_percent: 20 }
    expect((await post('/wake/check', body, TOKENS.direction)).body.reason).not.toBe('pending_approvals')
  })
})

describe('backwards compatibility', () => {
  it('a caller that has never sent pending_approvals sees the same tick results, with every slot at 0', async () => {
    const { afk } = await running()
    const tick = await afk.ok('status_tick', tickBody())
    expect(tick).toMatchObject({ recorded: true, slots: { cap: 3, used: 2, free: 1, parked: 0, ready: 0, pending_approvals: {} } })
    for (const slot of (await afk.ok('slot_list')).slots) expect(slot.pending_approvals).toBe(0)
  })

  it('upgrades a version-5 db in place: slots keep their rows and read 0, and the migration is the only change', { timeout: MIGRATION_TEST_TIMEOUT_MS }, async () => {
    const path = tempDbPath()
    const v5 = new DatabaseSync(path)
    for (const step of MIGRATIONS.slice(0, 5)) v5.exec(step as string)
    v5.exec('PRAGMA user_version = 5')
    v5.prepare("INSERT INTO slots (issue, thread_id, state, host, started_at, updated_at) VALUES (?, 'worker-1', 'running', 'wsl2', 1, 1)").run(ISSUE)
    v5.close()

    const { as } = world({ path })
    const afk = await as('afk')
    expect((await afk.ok('slot_list')).slots).toEqual([expect.objectContaining({ issue: ISSUE, state: 'running', pending_approvals: 0 })])

    const upgraded = new DatabaseSync(path)
    expect(Number((upgraded.prepare('PRAGMA user_version').get() as { user_version: number }).user_version)).toBe(MIGRATIONS.length)
    upgraded.close()
  })

  it('reopening an upgraded db re-applies nothing', async () => {
    const w = world()
    const afk = await w.as('afk')
    await afk.ok('slot_start', { issue: ISSUE, thread_id: 'worker-1' })
    await afk.ok('status_tick', tickBody({ pending_approvals: { [ISSUE]: 1 } }))
    w.restart()
    const again = await w.as('afk')
    expect((await again.ok('slot_list')).slots[0]).toMatchObject({ pending_approvals: 1 })
  })
})
