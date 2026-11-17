import { DatabaseSync } from 'node:sqlite'

import { describe, expect, it } from 'vitest'

import { MIGRATIONS } from '../src/store.js'
import { AFK_THREAD, MIGRATION_TEST_TIMEOUT_MS, tempDbPath, world } from './helpers.js'

describe('schema migrations', { timeout: MIGRATION_TEST_TIMEOUT_MS }, () => {
  it('upgrades a db written by the first version without losing its slots or status', async () => {
    const path = tempDbPath()
    const v1 = new DatabaseSync(path)
    v1.exec(MIGRATIONS[0] as string)
    v1.exec('PRAGMA user_version = 1')
    v1.prepare("INSERT INTO slots (issue, thread_id, state, started_at, updated_at) VALUES ('deanjstone/argus#701', 'worker-1', 'parked', 1, 1)").run()
    v1.close()

    const { as } = world({ path })
    const afk = await as('afk')
    expect((await afk.ok('slot_list')).slots).toEqual([expect.objectContaining({ issue: 'deanjstone/argus#701', state: 'parked' })])
    expect((await afk.ok('status_tick', { thread_id: AFK_THREAD, directives_version: 'v1', needs_owner: [] })).recorded).toBe(true)
    expect((await (await as('direction')).ok('ledger_read')).children).toEqual([])

    const upgraded = new DatabaseSync(path)
    expect(Number((upgraded.prepare('PRAGMA user_version').get() as { user_version: number }).user_version)).toBe(MIGRATIONS.length)
    upgraded.close()
  })

  it('upgrades a db written by the current deployed schema (version 4) in place, keeping slots, leases and status history', async () => {
    const path = tempDbPath()
    const v4 = new DatabaseSync(path)
    for (const step of MIGRATIONS.slice(0, 4)) v4.exec(step as string)
    v4.exec('PRAGMA user_version = 4')
    const tickedAt = Date.parse('2026-10-17T23:45:00Z')
    v4.prepare("INSERT INTO slots (issue, thread_id, state, host, started_at, updated_at) VALUES ('deanjstone/argus#701', 'worker-1', 'running', 'homelab', 1, 1)").run()
    v4.prepare("INSERT INTO leases (role, thread_id, moved_at, primary_thread_id) VALUES ('afk', ?, 1, ?)").run(AFK_THREAD, AFK_THREAD)
    v4.prepare("INSERT INTO events (at, kind, role, issue, thread_id, detail, scope) VALUES (1, 'slot_started', 'afk', 'deanjstone/argus#701', 'worker-1', '{}', 'loop')").run()
    v4.prepare(
      `INSERT INTO loop_status (role, thread_id, last_tick_at, event_cursor, directives_version, needs_owner, slot_cap, errors, pressure, window_used_percent)
       VALUES ('afk', ?, ?, 1, 'v1', '[]', 2, '[]', 'normal', 20)`,
    ).run(AFK_THREAD, tickedAt)
    v4.close()

    const { as } = world({ path, leases: {} })
    const afk = await as('afk')
    expect((await afk.ok('slot_list')).slots).toEqual([expect.objectContaining({ issue: 'deanjstone/argus#701', state: 'running', host: 'homelab' })])
    expect((await afk.ok('lease_read')).leases.afk).toMatchObject({ thread_id: AFK_THREAD, primary_thread_id: AFK_THREAD })
    const status = await afk.ok('status_read')
    expect(status).toMatchObject({
      thread_id: AFK_THREAD,
      last_tick_at: new Date(tickedAt).toISOString(),
      last_model_tick_at: new Date(tickedAt).toISOString(),
      last_tick_recorded_by: 'model',
      directives_version: 'v1',
      slots: { cap: 2, used: 1 },
    })
    // The old baseline still gates: nothing changed since that tick.
    expect(await afk.ok('tick_gate', { thread_id: AFK_THREAD, directives_version: 'v1', needs_owner: [] })).toMatchObject({ changed: false, recorded: true })

    const upgraded = new DatabaseSync(path)
    expect(Number((upgraded.prepare('PRAGMA user_version').get() as { user_version: number }).user_version)).toBe(MIGRATIONS.length)
    upgraded.close()
  })

  it('adds primary_host to a lease written before it existed, as null, and lets lease_move set it', async () => {
    const path = tempDbPath()
    const before = new DatabaseSync(path)
    for (const step of MIGRATIONS.slice(0, MIGRATIONS.length - 1)) before.exec(step as string)
    before.exec(`PRAGMA user_version = ${MIGRATIONS.length - 1}`)
    before.prepare("INSERT INTO leases (role, thread_id, moved_at, primary_thread_id) VALUES ('afk', ?, 1, ?)").run(AFK_THREAD, AFK_THREAD)
    before.close()

    const { as } = world({ path, leases: {} })
    const aquila = await as('direction')
    expect((await aquila.ok('lease_read')).leases.afk).toMatchObject({ thread_id: AFK_THREAD, primary_thread_id: AFK_THREAD, primary_host: null })
    await aquila.ok('lease_release', { role: 'afk', from_thread_id: AFK_THREAD, old_schedule_task_deleted: true })
    await aquila.ok('lease_move', { role: 'afk', to_thread_id: AFK_THREAD, host: 'wsl2' })
    expect((await aquila.ok('lease_read')).leases.afk.primary_host).toBe('wsl2')
  })
})
