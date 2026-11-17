import { describe, expect, it } from 'vitest'

import { AFK_THREAD, AQUILA_THREAD, MINUTE, TOKENS, world } from './helpers.js'

/**
 * argus#1167: POST /wake/check wakes the orchestrator only when it can act. A free slot does
 * not wake while the host's own gates are closed (`host_gates_ok: false`); the ledger's noise
 * events are never the only reason to wake; a pressure flip must hold for a dwell first.
 */
const modelTick = (thread_id: string, extra: Record<string, unknown> = {}) => ({
  thread_id,
  directives_version: 'v1',
  needs_owner: [] as string[],
  ...extra,
})

const check = (role: 'afk' | 'direction', thread_id: string, extra: Record<string, unknown> = {}) => ({
  role,
  host: 'wsl2',
  thread_id,
  directives_version: 'v1',
  needs_owner: [] as string[],
  window_used_percent: 20,
  ...(role === 'afk' ? { takeable: 0 } : {}),
  ...extra,
})

async function ticked(options: Parameters<typeof world>[0] = {}) {
  const w = world(options)
  const afk = await w.as('afk')
  const aquila = await w.as('direction')
  await afk.ok('status_tick', modelTick(AFK_THREAD, { slot_cap: 1, window_used_percent: 20 }))
  await aquila.ok('status_tick', modelTick(AQUILA_THREAD, { window_used_percent: 20 }))
  const wake = (body: Record<string, unknown>) => w.post('/wake/check', body, TOKENS[body.role as 'afk' | 'direction'])
  return { ...w, afk, aquila, wake }
}

describe('POST /wake/check: host_gates_ok', () => {
  it('a free slot with takeable work does not wake while host_gates_ok is false, and the quiet tick is recorded', async () => {
    const { wake, afk, clock } = await ticked()
    clock.advance(30 * MINUTE)
    expect((await wake(check('afk', AFK_THREAD, { takeable: 3, host_gates_ok: false }))).body).toEqual({ wake: false, reason: 'quiet', recorded: true })
    expect((await afk.ok('status_read')).last_tick_recorded_by).toBe('client')
  })

  it('wakes for the same free slot when host_gates_ok is true, and when it is left out', async () => {
    const { wake } = await ticked()
    expect((await wake(check('afk', AFK_THREAD, { takeable: 3, host_gates_ok: true }))).body).toEqual({ wake: true, reason: 'free_slot', recorded: false })
    expect((await wake(check('afk', AFK_THREAD, { takeable: 3 }))).body).toEqual({ wake: true, reason: 'free_slot', recorded: false })
  })

  it('also stops the budget-exempt free_slot wake at no_new_slots', async () => {
    const { wake, afk } = await ticked()
    await afk.ok('status_tick', modelTick(AFK_THREAD, { slot_cap: 1, window_used_percent: 88 }))
    const body = check('afk', AFK_THREAD, { window_used_percent: 88, takeable: 3, takeable_exempt: 1 })
    expect((await wake({ ...body, host_gates_ok: false })).body).toMatchObject({ wake: false })
    expect((await wake({ ...body, host_gates_ok: true })).body).toMatchObject({ wake: true, reason: 'free_slot' })
  })

  it('does not hide the other reasons: pending approvals and a changed directives version still wake', async () => {
    const { wake, afk } = await ticked()
    await afk.ok('slot_start', { issue: 'deanjstone/argus#5', thread_id: 'worker-1' })
    await afk.ok('status_tick', modelTick(AFK_THREAD, { slot_cap: 1, window_used_percent: 20, pending_approvals: { 'deanjstone/argus#5': 1 } }))
    expect((await wake(check('afk', AFK_THREAD, { takeable: 3, host_gates_ok: false }))).body.reason).toBe('pending_approvals')
    expect((await wake(check('afk', AFK_THREAD, { directives_version: 'v2', host_gates_ok: false }))).body.reason).toBe('changed:directives')
  })

  it.each([['a string', 'yes'], ['a number', 1]])('refuses %s with 400', async (_label, value) => {
    const { wake } = await ticked()
    const result = await wake(check('afk', AFK_THREAD, { host_gates_ok: value }))
    expect(result.status).toBe(400)
    expect(result.body).toHaveProperty('error')
  })

  it('is accepted and ignored on a direction check', async () => {
    const { wake } = await ticked()
    expect((await wake(check('direction', AQUILA_THREAD, { host_gates_ok: false }))).body).toEqual({ wake: false, reason: 'quiet', recorded: true })
  })
})

describe('POST /wake/check: noise events are never the only reason', () => {
  it.each([
    ['owner_turn', async (aquila: any) => aquila.ok('owner_turn', { caller_thread_id: AQUILA_THREAD })],
    ['away_noted', async (aquila: any) => aquila.ok('away_note', { text: 'launched child-1' })],
    ['notified', async (aquila: any) => aquila.ok('notify_claim', { class: 'needs_owner', items: ['deanjstone/argus#1'] })],
    ['child_started', async (aquila: any) => aquila.ok('child_start', { thread_id: 'child-1', purpose: 'research' })],
    [
      'child_closed',
      async (aquila: any) => {
        await aquila.ok('child_start', { thread_id: 'child-1', purpose: 'research' })
        await aquila.ok('child_close', { thread_id: 'child-1', outcome: 'done' })
      },
    ],
  ])('a lone %s event leaves the direction check quiet, recorded by the client', async (_kind, act) => {
    const { wake, aquila, clock } = await ticked()
    clock.advance(30 * MINUTE)
    await act(aquila)
    expect((await wake(check('direction', AQUILA_THREAD))).body).toEqual({ wake: false, reason: 'quiet', recorded: true })
    // The events were consumed by the client's quiet tick: the next poll is quiet too.
    clock.advance(30 * MINUTE)
    expect((await wake(check('direction', AQUILA_THREAD))).body).toEqual({ wake: false, reason: 'quiet', recorded: true })
  })

  it('noise next to a real reason wakes, and the reason names only the real one', async () => {
    const { wake, aquila, afk } = await ticked()
    await aquila.ok('owner_turn', { caller_thread_id: AQUILA_THREAD })
    await afk.ok('slot_start', { issue: 'deanjstone/argus#5', thread_id: 'worker-1', caller_thread_id: AFK_THREAD })
    expect((await wake(check('direction', AQUILA_THREAD))).body).toEqual({ wake: true, reason: 'changed:slot_started', recorded: false })
  })

  it('noise next to a changed directives version names only directives', async () => {
    const { wake, aquila } = await ticked()
    await aquila.ok('owner_turn', { caller_thread_id: AQUILA_THREAD })
    expect((await wake(check('direction', AQUILA_THREAD, { directives_version: 'v2' }))).body).toEqual({ wake: true, reason: 'changed:directives', recorded: false })
  })

  it('an outage edge still wakes with noise pending', async () => {
    const { wake, aquila, clock } = await ticked()
    clock.advance(70 * MINUTE)
    await aquila.ok('owner_turn', { caller_thread_id: AQUILA_THREAD })
    expect((await wake(check('direction', AQUILA_THREAD))).body).toEqual({ wake: true, reason: 'outage_opened', recorded: false })
  })

  it("the model's tick_gate still reports the noise, unchanged", async () => {
    const { aquila, clock } = await ticked()
    clock.advance(30 * MINUTE)
    await aquila.ok('owner_turn', { caller_thread_id: AQUILA_THREAD })
    expect(await aquila.ok('tick_gate', modelTick(AQUILA_THREAD, { window_used_percent: 20 }))).toMatchObject({ changed: true, reasons: ['owner_turn'] })
  })
})

describe('POST /wake/check: a pressure flip must hold for the dwell', () => {
  const level = async (afk: { ok: (name: string) => Promise<any> }) => (await afk.ok('status_read')).pressure.level

  it('a flip seen at one poll and gone by the next never wakes, and the recorded level stays the held one', async () => {
    const { wake, afk, clock } = await ticked()
    clock.advance(30 * MINUTE)
    expect((await wake(check('afk', AFK_THREAD, { window_used_percent: 72 }))).body).toEqual({ wake: false, reason: 'quiet', recorded: true })
    expect(await level(afk)).toBe('normal')
    clock.advance(30 * MINUTE)
    expect((await wake(check('afk', AFK_THREAD))).body).toEqual({ wake: false, reason: 'quiet', recorded: true })
    clock.advance(30 * MINUTE)
    expect((await wake(check('afk', AFK_THREAD))).body).toEqual({ wake: false, reason: 'quiet', recorded: true })
  })

  it('a flip that holds for 20 min wakes with the pressure reason', async () => {
    const { wake, clock } = await ticked()
    clock.advance(10 * MINUTE)
    expect((await wake(check('afk', AFK_THREAD, { window_used_percent: 72 }))).body).toMatchObject({ wake: false, recorded: true })
    clock.advance(19 * MINUTE)
    expect((await wake(check('afk', AFK_THREAD, { window_used_percent: 72 }))).body).toMatchObject({ wake: false, recorded: true })
    clock.advance(1 * MINUTE)
    expect((await wake(check('afk', AFK_THREAD, { window_used_percent: 72 }))).body).toEqual({ wake: true, reason: 'changed:pressure', recorded: false })
  })

  it('a different level restarts the dwell', async () => {
    const { wake, clock } = await ticked()
    clock.advance(10 * MINUTE)
    await wake(check('afk', AFK_THREAD, { window_used_percent: 88 }))
    clock.advance(15 * MINUTE)
    expect((await wake(check('afk', AFK_THREAD, { window_used_percent: 96 }))).body).toMatchObject({ wake: false })
    clock.advance(15 * MINUTE)
    expect((await wake(check('afk', AFK_THREAD, { window_used_percent: 96 }))).body).toMatchObject({ wake: false })
    clock.advance(5 * MINUTE)
    expect((await wake(check('afk', AFK_THREAD, { window_used_percent: 96 }))).body).toEqual({ wake: true, reason: 'changed:pressure', recorded: false })
  })

  it('once the model has recorded the new level, the next poll at it is quiet', async () => {
    const { wake, afk, clock } = await ticked()
    clock.advance(10 * MINUTE)
    await wake(check('afk', AFK_THREAD, { window_used_percent: 72 }))
    clock.advance(20 * MINUTE)
    expect((await wake(check('afk', AFK_THREAD, { window_used_percent: 72 }))).body.wake).toBe(true)
    await afk.ok('tick_gate', modelTick(AFK_THREAD, { window_used_percent: 72 }))
    await afk.ok('status_tick', modelTick(AFK_THREAD, { slot_cap: 1, window_used_percent: 72 }))
    clock.advance(30 * MINUTE)
    expect((await wake(check('afk', AFK_THREAD, { window_used_percent: 72 }))).body).toEqual({ wake: false, reason: 'quiet', recorded: true })
  })

  it('does not hold back a real reason: pressure flipping next to a new directives version wakes at once, naming only the real one', async () => {
    const { wake } = await ticked()
    expect((await wake(check('afk', AFK_THREAD, { window_used_percent: 72, directives_version: 'v2' }))).body).toEqual({
      wake: true,
      reason: 'changed:directives',
      recorded: false,
    })
  })

  it('a free slot does not wake on a pressure improvement that has not held: it counts the stricter of the held and current level', async () => {
    const { wake, afk, clock } = await ticked()
    await afk.ok('status_tick', modelTick(AFK_THREAD, { slot_cap: 1, window_used_percent: 88 }))
    clock.advance(10 * MINUTE)
    expect((await wake(check('afk', AFK_THREAD, { window_used_percent: 20, takeable: 3 }))).body).toMatchObject({ wake: false, recorded: true })
    clock.advance(20 * MINUTE)
    expect((await wake(check('afk', AFK_THREAD, { window_used_percent: 20, takeable: 3 }))).body).toEqual({ wake: true, reason: 'changed:pressure', recorded: false })
  })

  it('applies to the direction role too', async () => {
    const { wake, clock } = await ticked()
    clock.advance(10 * MINUTE)
    expect((await wake(check('direction', AQUILA_THREAD, { window_used_percent: 72 }))).body).toMatchObject({ wake: false, recorded: true })
    clock.advance(20 * MINUTE)
    expect((await wake(check('direction', AQUILA_THREAD, { window_used_percent: 72 }))).body).toEqual({ wake: true, reason: 'changed:pressure', recorded: false })
  })

  it('a dwell of 0 wakes at the first poll, as before', async () => {
    const { wake } = await ticked({ pressureDwellMs: 0 })
    expect((await wake(check('afk', AFK_THREAD, { window_used_percent: 72 }))).body).toEqual({ wake: true, reason: 'changed:pressure', recorded: false })
  })
})

describe('POST /wake/check: the dwell needs a held level to flip back to', () => {
  it('a first pressure reading after an unknown one wakes at once', async () => {
    const w = world()
    const afk = await w.as('afk')
    await afk.ok('status_tick', modelTick(AFK_THREAD, { slot_cap: 1 }))
    expect((await w.post('/wake/check', check('afk', AFK_THREAD), TOKENS.afk)).body).toEqual({ wake: true, reason: 'changed:pressure', recorded: false })
  })
})
