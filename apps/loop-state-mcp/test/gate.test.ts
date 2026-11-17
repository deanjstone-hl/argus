import { describe, expect, it } from 'vitest'

import { AFK_THREAD, AQUILA_THREAD, MINUTE, world } from './helpers.js'

const ISSUE = 'deanjstone/argus#701'
const QUEUE = ['deanjstone/argus#682', 'deanjstone/myargus#309']
const afkTick = { thread_id: AFK_THREAD, directives_version: 'v1', needs_owner: QUEUE }

describe('quiet-tick gate', () => {
  it('treats the first tick as changed: there is nothing to compare against', async () => {
    const { as } = world()
    const gate = await (await as('afk')).ok('tick_gate', afkTick)
    expect(gate).toMatchObject({ changed: true, reasons: ['first_tick'], recorded: false, since: null })
  })

  it('records a quiet tick itself, so a quiet tick needs no status_tick', async () => {
    const { as, clock } = world()
    const afk = await as('afk')
    await afk.ok('status_tick', { ...afkTick, slot_cap: 3, window_used_percent: 40 })
    const lastTick = clock.iso()

    clock.advance(30 * MINUTE)
    const gate = await afk.ok('tick_gate', { ...afkTick, window_used_percent: 41 })
    expect(gate).toEqual({
      changed: false,
      reasons: [],
      changes: [],
      recorded: true,
      since: lastTick,
      holds_lease: true,
      lease_holder: AFK_THREAD,
    })

    const status = await afk.ok('status_read')
    expect(status).toMatchObject({
      last_tick_at: clock.iso(),
      pressure: { level: 'normal', window_used_percent: 41 },
      slots: { cap: 3 },
      liveness: { state: 'alive' },
    })
  })

  it('reads the needs:owner queue as a set: order does not count as a change', async () => {
    const { as } = world()
    const afk = await as('afk')
    await afk.ok('status_tick', afkTick)
    const gate = await afk.ok('tick_gate', { ...afkTick, needs_owner: [...QUEUE].reverse() })
    expect(gate.changed).toBe(false)
  })

  it('reports a needs:owner change and a directives change, and records nothing', async () => {
    const { as, clock } = world()
    const afk = await as('afk')
    await afk.ok('status_tick', afkTick)
    const lastTick = clock.iso()

    clock.advance(30 * MINUTE)
    const gate = await afk.ok('tick_gate', { ...afkTick, directives_version: 'v2', needs_owner: [QUEUE[0]] })
    expect(gate).toMatchObject({ changed: true, reasons: ['directives', 'needs_owner'], recorded: false })
    expect((await afk.ok('status_read')).last_tick_at).toBe(lastTick)
  })

  it('reports a move up the window ladder, but not a move within one level', async () => {
    const { as } = world()
    const afk = await as('afk')
    await afk.ok('status_tick', { ...afkTick, window_used_percent: 71 })
    expect((await afk.ok('tick_gate', { ...afkTick, window_used_percent: 84 })).changed).toBe(false)
    expect(await afk.ok('tick_gate', { ...afkTick, window_used_percent: 86 })).toMatchObject({ changed: true, reasons: ['pressure'] })
  })

  it('reports slot activity by others since the last tick: a worker report, an un-park', async () => {
    const { as, clock } = world()
    const afk = await as('afk')
    const aquila = await as('direction')
    const worker = await as('worker')
    await afk.ok('slot_start', { issue: ISSUE, thread_id: 'worker-1' })
    await afk.ok('slot_start', { issue: 'deanjstone/argus#702', thread_id: 'worker-2' })
    await afk.ok('slot_park', { issue: 'deanjstone/argus#702' })
    await afk.ok('status_tick', afkTick)

    clock.advance(5 * MINUTE)
    await worker.ok('slot_report', { issue: ISSUE, thread_id: 'worker-1', outcome: 'complete' })
    await aquila.ok('slot_unpark', { issue: 'deanjstone/argus#702' })

    const gate = await afk.ok('tick_gate', afkTick)
    expect(gate).toMatchObject({ changed: true, reasons: ['slot_reported', 'slot_unparked'], recorded: false })
    expect(gate.changes).toEqual([
      { kind: 'slot_reported', issue: ISSUE, role: 'worker', at: clock.iso() },
      { kind: 'slot_unparked', issue: 'deanjstone/argus#702', role: 'direction', at: clock.iso() },
    ])
  })

  it('does not count the AFK thread\'s own writes before its status_tick as changes', async () => {
    const { as } = world()
    const afk = await as('afk')
    await afk.ok('status_tick', afkTick)
    await afk.ok('slot_start', { issue: ISSUE, thread_id: 'worker-1' })
    await afk.ok('status_tick', afkTick)

    expect((await afk.ok('tick_gate', afkTick)).changed).toBe(false)
  })

  it('keeps a cursor per role: Aquila sees AFK slot moves the AFK thread already absorbed', async () => {
    const { as } = world()
    const afk = await as('afk')
    const aquila = await as('direction')
    const aquilaTick = { thread_id: AQUILA_THREAD, directives_version: 'v1', needs_owner: QUEUE }
    await aquila.ok('status_tick', aquilaTick)
    await afk.ok('status_tick', afkTick)

    await afk.ok('slot_start', { issue: ISSUE, thread_id: 'worker-1', caller_thread_id: AFK_THREAD })
    await afk.ok('status_tick', afkTick)

    expect((await afk.ok('tick_gate', afkTick)).changed).toBe(false)
    expect(await aquila.ok('tick_gate', aquilaTick)).toMatchObject({ changed: true, reasons: ['slot_started'] })
  })

  it('advances the cursor on a full tick, so a change is reported once', async () => {
    const { as } = world()
    const afk = await as('afk')
    const worker = await as('worker')
    await afk.ok('slot_start', { issue: ISSUE, thread_id: 'worker-1' })
    await afk.ok('status_tick', afkTick)
    await worker.ok('slot_report', { issue: ISSUE, thread_id: 'worker-1', outcome: 'needs_owner', note: 'deploy approval' })

    expect((await afk.ok('tick_gate', afkTick)).changed).toBe(true)
    await afk.ok('slot_park', { issue: ISSUE })
    await afk.ok('status_tick', afkTick)
    expect((await afk.ok('tick_gate', afkTick)).changed).toBe(false)
  })

  it('survives a restart: the gate compares against the tick recorded before it', async () => {
    const { as, restart } = world()
    await (await as('afk')).ok('status_tick', afkTick)
    restart()
    expect((await (await as('afk')).ok('tick_gate', afkTick)).changed).toBe(false)
  })
})
