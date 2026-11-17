import { describe, expect, it } from 'vitest'

import { MINUTE, text, world } from './helpers.js'

const ISSUE = 'deanjstone/argus#701'
const OTHER = 'deanjstone/homelab#88'

interface Slot {
  issue: string
  thread_id: string
  state: string
  started_at: string
  report: { outcome: string; note: string | null; pr: string | null; at: string } | null
}

async function slots(caller: { ok: (name: string, args?: Record<string, unknown>) => Promise<any> }, state?: string) {
  const result = await caller.ok('slot_list', state ? { state } : {})
  return result.slots as Slot[]
}

describe('slot lifecycle', () => {
  it('starts a slot: the issue is held by its worker thread from the moment it starts', async () => {
    const { as, clock } = world()
    const afk = await as('afk')
    await afk.ok('slot_start', { issue: ISSUE, thread_id: 'worker-1' })

    expect(await slots(afk)).toEqual([
      expect.objectContaining({ issue: ISSUE, thread_id: 'worker-1', state: 'running', started_at: clock.iso(), report: null }),
    ])
  })

  it('refuses a second slot for an issue that already holds one', async () => {
    const { as } = world()
    const afk = await as('afk')
    await afk.ok('slot_start', { issue: ISSUE, thread_id: 'worker-1' })

    const again = await afk.call('slot_start', { issue: ISSUE, thread_id: 'worker-2' })
    expect(again.isError).toBe(true)
    expect(text(again)).toMatch(/already/)
    expect((await slots(afk))[0]?.thread_id).toBe('worker-1')
  })

  it('refuses an issue that is not owner/repo#number', async () => {
    const { as } = world()
    const afk = await as('afk')
    const result = await afk.call('slot_start', { issue: 'argus 701', thread_id: 'worker-1' })
    expect(result.isError).toBe(true)
    expect(text(result)).toMatch(/owner\/repo#number/)
  })

  it('parks, un-parks and resumes: a parked issue waits for an answer, a ready one for a free slot', async () => {
    const { as, clock } = world()
    const afk = await as('afk')
    const aquila = await as('direction')
    await afk.ok('slot_start', { issue: ISSUE, thread_id: 'worker-1' })

    await afk.ok('slot_park', { issue: ISSUE, note: 'needs:owner — deploy approval' })
    expect(await slots(afk, 'parked')).toEqual([expect.objectContaining({ issue: ISSUE, state: 'parked' })])

    const early = await afk.call('slot_start', { issue: ISSUE, thread_id: 'worker-2' })
    expect(early.isError).toBe(true)
    expect(text(early)).toMatch(/parked/)

    await aquila.ok('slot_unpark', { issue: ISSUE, note: 'owner answered: yes' })
    expect(await slots(afk, 'ready')).toEqual([expect.objectContaining({ issue: ISSUE, state: 'ready' })])

    clock.advance(10 * MINUTE)
    await afk.ok('slot_start', { issue: ISSUE, thread_id: 'worker-2' })
    expect(await slots(afk)).toEqual([
      expect.objectContaining({ issue: ISSUE, thread_id: 'worker-2', state: 'running', started_at: clock.iso() }),
    ])
  })

  it('only un-parks a parked slot', async () => {
    const { as } = world()
    const afk = await as('afk')
    const aquila = await as('direction')
    await afk.ok('slot_start', { issue: ISSUE, thread_id: 'worker-1' })

    const running = await aquila.call('slot_unpark', { issue: ISSUE })
    expect(running.isError).toBe(true)
    const missing = await aquila.call('slot_unpark', { issue: OTHER })
    expect(missing.isError).toBe(true)
    expect(text(missing)).toMatch(/no slot/i)
  })

  it('lets the worker holding a slot report completion, without moving the slot', async () => {
    const { as, clock } = world()
    const afk = await as('afk')
    const worker = await as('worker')
    await afk.ok('slot_start', { issue: ISSUE, thread_id: 'worker-1' })

    clock.advance(25 * MINUTE)
    await worker.ok('slot_report', {
      issue: ISSUE,
      thread_id: 'worker-1',
      outcome: 'complete',
      note: 'merged',
      pr: 'https://github.com/deanjstone/argus/pull/790',
    })

    expect(await slots(afk)).toEqual([
      expect.objectContaining({
        state: 'running',
        report: { outcome: 'complete', note: 'merged', pr: 'https://github.com/deanjstone/argus/pull/790', at: clock.iso() },
      }),
    ])
  })

  it('refuses a report from a thread that does not hold the slot, or for an issue with no running slot', async () => {
    const { as } = world()
    const afk = await as('afk')
    const worker = await as('worker')
    await afk.ok('slot_start', { issue: ISSUE, thread_id: 'worker-1' })

    const wrongThread = await worker.call('slot_report', { issue: ISSUE, thread_id: 'worker-9', outcome: 'complete' })
    expect(wrongThread.isError).toBe(true)
    expect(text(wrongThread)).toMatch(/worker-1/)

    const noSlot = await worker.call('slot_report', { issue: OTHER, thread_id: 'worker-1', outcome: 'complete' })
    expect(noSlot.isError).toBe(true)

    await afk.ok('slot_park', { issue: ISSUE })
    const parked = await worker.call('slot_report', { issue: ISSUE, thread_id: 'worker-1', outcome: 'complete' })
    expect(parked.isError).toBe(true)
    expect((await slots(afk))[0]?.report).toBeNull()
  })

  it('closes a verified slot, which frees it', async () => {
    const { as } = world()
    const afk = await as('afk')
    await afk.ok('slot_start', { issue: ISSUE, thread_id: 'worker-1' })

    const closed = await afk.ok('slot_close', { issue: ISSUE, verified: 'Verified: verify-claim merged #790 ok; CI run 123 green' })
    expect(closed.slot).toMatchObject({ issue: ISSUE, thread_id: 'worker-1' })
    expect(await slots(afk)).toEqual([])

    await afk.ok('slot_start', { issue: ISSUE, thread_id: 'worker-2' })
    expect(await slots(afk)).toHaveLength(1)
  })

  it('answers slot_close with the closed state, not the pre-close row (argus#1191)', async () => {
    const { as, clock } = world()
    const afk = await as('afk')
    await afk.ok('slot_start', { issue: ISSUE, thread_id: 'worker-1' })
    clock.advance(5 * MINUTE)
    const verified = 'Verified: verify-claim merged #790 ok; CI run 123 green'

    const closed = await afk.ok('slot_close', { issue: ISSUE, verified })

    expect(closed.slot).toMatchObject({
      issue: ISSUE,
      thread_id: 'worker-1',
      state: 'closed',
      previous_state: 'running',
      verified,
      closed_at: clock.iso(),
    })
    expect(await slots(afk)).toEqual([])
  })

  it('answers slot_free with the freed state and its reason (argus#1191)', async () => {
    const { as, clock } = world()
    const afk = await as('afk')
    await afk.ok('slot_start', { issue: ISSUE, thread_id: 'worker-1' })
    await afk.ok('slot_park', { issue: ISSUE })
    clock.advance(MINUTE)

    const freed = await afk.ok('slot_free', { issue: ISSUE, reason: 'worker thread gone' })

    expect(freed.slot).toMatchObject({
      issue: ISSUE,
      state: 'freed',
      previous_state: 'parked',
      reason: 'worker thread gone',
      freed_at: clock.iso(),
    })
    expect(await slots(afk)).toEqual([])
  })

  it('refuses to close a slot without a Verified: line, or one that is not running', async () => {
    const { as } = world()
    const afk = await as('afk')
    await afk.ok('slot_start', { issue: ISSUE, thread_id: 'worker-1' })

    const unverified = await afk.call('slot_close', { issue: ISSUE, verified: 'looks done' })
    expect(unverified.isError).toBe(true)
    expect(text(unverified)).toMatch(/Verified:/)

    await afk.ok('slot_park', { issue: ISSUE })
    const parked = await afk.call('slot_close', { issue: ISSUE, verified: 'Verified: ok' })
    expect(parked.isError).toBe(true)
    expect(await slots(afk)).toHaveLength(1)
  })

  it('closes a ready slot that has a Verified: line, recording previous_state ready (argus#1197)', async () => {
    const { as, clock } = world()
    const afk = await as('afk')
    const aquila = await as('direction')
    await afk.ok('slot_start', { issue: ISSUE, thread_id: 'worker-1' })
    await afk.ok('slot_park', { issue: ISSUE })
    await aquila.ok('slot_unpark', { issue: ISSUE })
    expect((await slots(afk))[0]?.state).toBe('ready')
    clock.advance(MINUTE)

    const unverified = await afk.call('slot_close', { issue: ISSUE, verified: 'looks done' })
    expect(unverified.isError).toBe(true)
    expect(text(unverified)).toMatch(/Verified:/)
    expect(await slots(afk)).toHaveLength(1)

    const closed = await afk.ok('slot_close', { issue: ISSUE, verified: 'Verified: ok' })

    expect(closed.slot).toMatchObject({ issue: ISSUE, state: 'closed', previous_state: 'ready', verified: 'Verified: ok', closed_at: clock.iso() })
    expect(await slots(afk)).toEqual([])
  })

  it('closes a ready slot even when the caps are full, since nothing runs (argus#1197)', async () => {
    const { as } = world()
    const afk = await as('afk')
    const aquila = await as('direction')
    await afk.ok('slot_start', { issue: ISSUE, thread_id: 'worker-1' })
    await afk.ok('slot_park', { issue: ISSUE })
    await aquila.ok('slot_unpark', { issue: ISSUE })
    await afk.ok('slot_start', { issue: OTHER, thread_id: 'worker-2' })

    await afk.ok('slot_close', { issue: ISSUE, verified: 'Verified: ok' })

    expect((await slots(afk)).map((slot) => slot.issue)).toEqual([OTHER])
  })

  it('still refuses to close a parked or awaiting_ci slot (argus#1197)', async () => {
    const { as } = world()
    const afk = await as('afk')
    const worker = await as('worker')
    await afk.ok('slot_start', { issue: ISSUE, thread_id: 'worker-1' })
    await afk.ok('slot_start', { issue: OTHER, thread_id: 'worker-2' })
    await afk.ok('slot_park', { issue: ISSUE })
    await worker.ok('slot_await_ci', { issue: OTHER, thread_id: 'worker-2', ref: '09dba31f2c9a4f0f8a3d3d1d7c5a6b7e8f901234' })

    const parked = await afk.call('slot_close', { issue: ISSUE, verified: 'Verified: ok' })
    const awaiting = await afk.call('slot_close', { issue: OTHER, verified: 'Verified: ok' })

    expect(parked.isError).toBe(true)
    expect(text(parked)).toMatch(/parked/)
    expect(awaiting.isError).toBe(true)
    expect(text(awaiting)).toMatch(/awaiting_ci/)
    expect(await slots(afk)).toHaveLength(2)
  })

  it('frees a slot in any state without closing the issue', async () => {
    const { as } = world()
    const afk = await as('afk')
    await afk.ok('slot_start', { issue: ISSUE, thread_id: 'worker-1' })
    await afk.ok('slot_start', { issue: OTHER, thread_id: 'worker-2' })
    await afk.ok('slot_park', { issue: OTHER })

    await afk.ok('slot_free', { issue: ISSUE, reason: 'worker thread gone' })
    await afk.ok('slot_free', { issue: OTHER, reason: 'question withdrawn' })
    expect(await slots(afk)).toEqual([])

    const missing = await afk.call('slot_free', { issue: ISSUE, reason: 'again' })
    expect(missing.isError).toBe(true)
  })

  it('keeps every slot across a server restart', async () => {
    const { as, restart } = world()
    const afk = await as('afk')
    await afk.ok('slot_start', { issue: ISSUE, thread_id: 'worker-1' })
    await afk.ok('slot_start', { issue: OTHER, thread_id: 'worker-2' })
    await afk.ok('slot_park', { issue: OTHER })

    restart()

    const after = await as('afk')
    expect((await slots(after)).map((slot) => [slot.issue, slot.state])).toEqual([
      [ISSUE, 'running'],
      [OTHER, 'parked'],
    ])
  })
})
