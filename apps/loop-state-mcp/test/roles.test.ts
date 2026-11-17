import { describe, expect, it } from 'vitest'

import { parseTokens } from '../src/roles.js'
import { AFK_THREAD, AQUILA_THREAD, text, world } from './helpers.js'

const ISSUE = 'deanjstone/argus#701'
const tick = { directives_version: 'v1', needs_owner: [] }

describe('caller role', () => {
  it('refuses a caller with no token or an unknown one', async () => {
    const { connect } = world()
    await expect(connect(null)).rejects.toThrow()
    await expect(connect('not-a-token-0123456789abcdef')).rejects.toThrow()
  })

  it('gives each role its own tool surface', async () => {
    const { as } = world()
    expect(await (await as('afk')).tools()).toEqual([
      'directives_read',
      'lease_failover',
      'lease_read',
      'lease_reclaim',
      'slot_close',
      'slot_free',
      'slot_list',
      'slot_park',
      'slot_rebuild',
      'slot_start',
      'status_read',
      'status_tick',
      'tick_gate',
    ])
    expect(await (await as('direction')).tools()).toEqual([
      'away_note',
      'child_close',
      'child_start',
      'directives_read',
      'directives_set',
      'lease_failover',
      'lease_move',
      'lease_read',
      'lease_reclaim',
      'lease_release',
      'ledger_read',
      'notify_claim',
      'outage_observe',
      'owner_turn',
      'slot_list',
      'slot_rebuild',
      'slot_resume_ci',
      'slot_unpark',
      'status_read',
      'status_tick',
      'tick_gate',
    ])
    expect(await (await as('worker')).tools()).toEqual(['slot_await_ci', 'slot_list', 'slot_report', 'status_read'])
  })

  it('lets Aquila un-park and nothing else on slots', async () => {
    const { as } = world()
    const afk = await as('afk')
    const aquila = await as('direction')
    await afk.ok('slot_start', { issue: ISSUE, thread_id: 'worker-1' })

    for (const [name, args] of [
      ['slot_start', { issue: 'deanjstone/argus#702', thread_id: 'worker-2' }],
      ['slot_park', { issue: ISSUE }],
      ['slot_close', { issue: ISSUE, verified: 'Verified: ok' }],
      ['slot_free', { issue: ISSUE, reason: 'x' }],
      ['slot_report', { issue: ISSUE, thread_id: 'worker-1', outcome: 'complete' }],
      ['slot_rebuild', { issues: [], threads: [], apply: true }],
    ] as const) {
      const result = await aquila.call(name, args)
      expect(result.isError, name).toBe(true)
    }

    const listed = await afk.ok('slot_list')
    expect(listed.slots).toEqual([expect.objectContaining({ issue: ISSUE, state: 'running', report: null })])
  })

  it('lets a worker report completion and nothing else', async () => {
    const { as } = world()
    const afk = await as('afk')
    const worker = await as('worker')
    await afk.ok('slot_start', { issue: ISSUE, thread_id: 'worker-1' })
    await afk.ok('slot_park', { issue: ISSUE })

    for (const [name, args] of [
      ['slot_start', { issue: 'deanjstone/argus#702', thread_id: 'worker-1' }],
      ['slot_unpark', { issue: ISSUE }],
      ['slot_free', { issue: ISSUE, reason: 'x' }],
      ['status_tick', { thread_id: 'worker-1', ...tick }],
      ['tick_gate', { thread_id: 'worker-1', ...tick }],
    ] as const) {
      const result = await worker.call(name, args)
      expect(result.isError, name).toBe(true)
    }

    expect((await afk.ok('slot_list')).slots).toEqual([expect.objectContaining({ state: 'parked' })])
    expect((await afk.ok('status_read')).last_tick_at).toBeNull()
  })

  it('keeps the AFK thread off un-park, and each role on its own status row', async () => {
    const { as } = world()
    const afk = await as('afk')
    const aquila = await as('direction')
    await afk.ok('slot_start', { issue: ISSUE, thread_id: 'worker-1' })
    await afk.ok('slot_park', { issue: ISSUE })

    const unpark = await afk.call('slot_unpark', { issue: ISSUE })
    expect(unpark.isError).toBe(true)
    expect(text(unpark)).toMatch(/direction|not found/i)

    await aquila.ok('status_tick', { thread_id: AQUILA_THREAD, ...tick })
    expect((await afk.ok('status_read', { role: 'afk' })).last_tick_at).toBeNull()
    expect((await afk.ok('status_read', { role: 'direction' })).thread_id).toBe(AQUILA_THREAD)

    await afk.ok('status_tick', { thread_id: AFK_THREAD, ...tick })
    expect((await aquila.ok('status_read')).thread_id).toBe(AFK_THREAD)
  })
})

describe('LOOP_STATE_TOKENS', () => {
  it('maps each token to its role', () => {
    expect(parseTokens('afk=aaaaaaaaaaaaaaaaaaaaaaaaaa, worker=bbbbbbbbbbbbbbbbbbbbbbbbbb').map((entry) => entry.role)).toEqual([
      'afk',
      'worker',
    ])
  })

  it('rejects an empty spec, an unknown role, a short token and a reused token', () => {
    expect(() => parseTokens(' ')).toThrow(/empty/)
    expect(() => parseTokens('owner=aaaaaaaaaaaaaaaaaaaaaaaaaa')).toThrow(/role/)
    expect(() => parseTokens('afk=short')).toThrow(/shorter/)
    expect(() => parseTokens('afk=aaaaaaaaaaaaaaaaaaaaaaaaaa,worker=aaaaaaaaaaaaaaaaaaaaaaaaaa')).toThrow(/reuses/)
  })
})
