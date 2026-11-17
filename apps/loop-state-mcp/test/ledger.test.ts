import { describe, expect, it } from 'vitest'

import { AFK_THREAD, AQUILA_THREAD, MINUTE, text, world } from './helpers.js'

const aquilaTick = { thread_id: AQUILA_THREAD, directives_version: 'v1', needs_owner: [] as string[] }
const afkTick = { thread_id: AFK_THREAD, directives_version: 'v1', needs_owner: [] as string[] }

const LEDGER_TOOLS = ['child_close', 'child_start', 'ledger_read', 'notify_claim', 'outage_observe', 'owner_turn', 'away_note']

describe("Aquila's ledger", () => {
  it('is written and read by Aquila alone', async () => {
    const { as } = world()
    const afk = await as('afk')
    const worker = await as('worker')
    for (const caller of [afk, worker]) {
      const tools = await caller.tools()
      for (const name of LEDGER_TOOLS) expect(tools, name).not.toContain(name)
    }
    const refused = await afk.call('child_start', { thread_id: 'child-1', purpose: 'research' })
    expect(refused.isError).toBe(true)
    expect((await (await as('direction')).ok('ledger_read')).children).toEqual([])
  })

  it('tracks the children Aquila started until each is closed', async () => {
    const { as, clock } = world()
    const aquila = await as('direction')
    const startedAt = clock.iso()
    await aquila.ok('child_start', { thread_id: 'child-1', purpose: 'investigate red CI on main', issue: 'deanjstone/argus#801' })
    await aquila.ok('child_start', { thread_id: 'child-2', purpose: 'research the window signal' })
    expect((await aquila.call('child_start', { thread_id: 'child-1', purpose: 'again' })).isError).toBe(true)

    clock.advance(20 * MINUTE)
    const closed = await aquila.ok('child_close', { thread_id: 'child-1', outcome: 'done', note: 'fixed in argus#802' })
    expect(closed.child).toMatchObject({ thread_id: 'child-1', outcome: 'done', closed_at: clock.iso() })
    expect((await aquila.call('child_close', { thread_id: 'child-1', outcome: 'done' })).isError).toBe(true)
    expect((await aquila.call('child_close', { thread_id: 'child-9', outcome: 'done' })).isError).toBe(true)

    const ledger = await aquila.ok('ledger_read')
    expect(ledger.children).toEqual([
      { thread_id: 'child-2', purpose: 'research the window signal', issue: null, started_at: startedAt, closed_at: null, outcome: null, note: null },
    ])
    expect((await aquila.ok('ledger_read', { include_closed: true })).children.map((child: { thread_id: string }) => child.thread_id)).toEqual([
      'child-1',
      'child-2',
    ])
  })

  it('records last_owner_turn, and the owner is present for 30 minutes after it', async () => {
    const { as, clock } = world()
    const aquila = await as('direction')
    expect((await aquila.ok('ledger_read')).owner).toEqual({ last_turn_at: null, present: false, stepped_away: false })

    await aquila.ok('owner_turn')
    const turn = clock.iso()
    clock.advance(29 * MINUTE)
    expect((await aquila.ok('ledger_read')).owner).toEqual({ last_turn_at: turn, present: true, stepped_away: false })
    clock.advance(2 * MINUTE)
    expect((await aquila.ok('ledger_read')).owner).toMatchObject({ last_turn_at: turn, present: false })
  })

  it('switches to away at once when the owner says they are stepping away', async () => {
    const { as, clock } = world()
    const aquila = await as('direction')
    await aquila.ok('owner_turn')
    await aquila.ok('owner_turn', { stepping_away: true })
    expect((await aquila.ok('ledger_read')).owner).toEqual({ last_turn_at: clock.iso(), present: false, stepped_away: true })
  })

  it('keeps a "since you left" record and hands it over once, on the owner\'s next turn', async () => {
    const { as, clock } = world()
    const aquila = await as('direction')
    await aquila.ok('owner_turn', { stepping_away: true })

    clock.advance(40 * MINUTE)
    await aquila.ok('away_note', { text: 'launched child-1 for red CI on main', issue: 'deanjstone/argus#801' })
    clock.advance(30 * MINUTE)
    await aquila.ok('away_note', { text: 'merged argus#802 on green' })
    expect((await aquila.ok('ledger_read')).since_you_left).toHaveLength(2)

    const back = await aquila.ok('owner_turn')
    expect(back.since_you_left).toEqual([
      { at: '2026-10-18T00:40:00.000Z', text: 'launched child-1 for red CI on main', issue: 'deanjstone/argus#801' },
      { at: '2026-10-18T01:10:00.000Z', text: 'merged argus#802 on green', issue: null },
    ])
    expect(back.owner).toMatchObject({ present: true })
    expect((await aquila.ok('owner_turn')).since_you_left).toEqual([])
    expect((await aquila.ok('ledger_read')).since_you_left).toEqual([])
    expect((await aquila.call('away_note', { text: ' ' })).isError).toBe(true)
  })

  it('notifies each item once, with at most one push per class per tick', async () => {
    const { as } = world()
    const aquila = await as('direction')
    const queue = ['deanjstone/argus#682', 'deanjstone/argus#687']
    await aquila.ok('status_tick', aquilaTick)

    expect(await aquila.ok('notify_claim', { class: 'needs_owner', items: queue })).toEqual({ push: true, items: queue, deferred: [] })
    // A second push of the same class in the same tick waits for the next tick, unrecorded.
    expect(await aquila.ok('notify_claim', { class: 'needs_owner', items: [...queue, 'deanjstone/argus#688'] })).toEqual({
      push: false,
      items: [],
      deferred: ['deanjstone/argus#688'],
    })
    // Another class has its own push this tick.
    expect((await aquila.ok('notify_claim', { class: 'window', items: ['window-85:2026-10-18T05'] })).push).toBe(true)

    await aquila.ok('status_tick', aquilaTick)
    expect(await aquila.ok('notify_claim', { class: 'needs_owner', items: [...queue, 'deanjstone/argus#688'] })).toEqual({
      push: true,
      items: ['deanjstone/argus#688'],
      deferred: [],
    })
    await aquila.ok('status_tick', aquilaTick)
    expect(await aquila.ok('notify_claim', { class: 'needs_owner', items: queue })).toEqual({ push: false, items: [], deferred: [] })
    expect((await aquila.call('notify_claim', { class: 'needs_owner', items: ['  '] })).isError).toBe(true)
  })

  it('notifies a stall once per outage, and once on recovery', async () => {
    const { as, clock } = world()
    const aquila = await as('direction')
    expect(await aquila.ok('outage_observe', { stalled: false })).toEqual({ notify: null, outage: null })

    const opened = clock.iso()
    expect(await aquila.ok('outage_observe', { stalled: true, reason: 'AFK loop missed 2 ticks' })).toEqual({
      notify: 'outage',
      outage: { reason: 'AFK loop missed 2 ticks', opened_at: opened, closed_at: null },
    })
    clock.advance(30 * MINUTE)
    expect((await aquila.ok('outage_observe', { stalled: true, reason: 'loop-state db unreachable' })).notify).toBeNull()
    expect((await aquila.ok('ledger_read')).outage).toEqual({ reason: 'AFK loop missed 2 ticks', opened_at: opened, closed_at: null })

    clock.advance(30 * MINUTE)
    expect(await aquila.ok('outage_observe', { stalled: false })).toEqual({
      notify: 'recovery',
      outage: { reason: 'AFK loop missed 2 ticks', opened_at: opened, closed_at: clock.iso() },
    })
    expect((await aquila.ok('outage_observe', { stalled: false })).notify).toBeNull()
    expect((await aquila.ok('ledger_read')).outage).toBeNull()
    expect((await aquila.ok('outage_observe', { stalled: true, reason: 'lease conflict' })).notify).toBe('outage')
    expect(text(await aquila.call('outage_observe', { stalled: true }))).toMatch(/reason/)
  })

  it('does not wake the AFK loop, and survives a restart', async () => {
    const { as, restart } = world()
    const afk = await as('afk')
    const aquila = await as('direction')
    await afk.ok('status_tick', afkTick)
    await aquila.ok('child_start', { thread_id: 'child-1', purpose: 'research' })
    await aquila.ok('owner_turn')
    await aquila.ok('notify_claim', { class: 'needs_owner', items: ['deanjstone/argus#682'] })
    await aquila.ok('outage_observe', { stalled: true, reason: 'AFK loop missed 2 ticks' })
    expect((await afk.ok('tick_gate', afkTick)).changed).toBe(false)

    restart()
    const again = await as('direction')
    const ledger = await again.ok('ledger_read')
    expect(ledger.children).toHaveLength(1)
    expect(ledger.outage).not.toBeNull()
    expect((await again.ok('notify_claim', { class: 'needs_owner', items: ['deanjstone/argus#682'] })).items).toEqual([])
  })
})
