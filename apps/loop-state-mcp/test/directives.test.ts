import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import { AFK_THREAD, AQUILA_THREAD, MINUTE, text, world } from './helpers.js'

// argus#1067 (map argus-config#1048): the AFK directives are a record in loop-state that the
// owner sets through Aquila, with history. A write is accepted only from the thread holding
// the direction lease, in a turn the owner is driving (owner_turn within the presence window).

const V20 = JSON.parse(readFileSync(new URL('./fixtures/directives-v20.json', import.meta.url), 'utf8')) as Record<string, unknown>
const { version: _version, ...RECORD } = V20

const STRAY = 'thread-stray'
const tick = (thread_id: string) => ({ thread_id, directives_version: 'v1', needs_owner: [] as string[] })

const MINIMAL = { cadence_minutes: 30, max_slots: 2, repo_holds: [], take_next: [], ordering: [] }

async function ownerPresent(world_: ReturnType<typeof world>) {
  const aquila = await world_.as('direction')
  await aquila.ok('owner_turn', { caller_thread_id: AQUILA_THREAD })
  return aquila
}

const set = (aquila: Awaited<ReturnType<ReturnType<typeof world>['as']>>, args: Record<string, unknown> = {}) =>
  aquila.call('directives_set', { record: MINIMAL, reason: 'test', expected_version: 0, caller_thread_id: AQUILA_THREAD, ...args })

describe('who sees the tools', () => {
  it('offers the read to the AFK loop and Aquila, the write to Aquila alone, and neither to a worker', async () => {
    const w = world()
    expect(await (await w.as('afk')).tools()).toContain('directives_read')
    expect(await (await w.as('afk')).tools()).not.toContain('directives_set')
    expect(await (await w.as('direction')).tools()).toEqual(expect.arrayContaining(['directives_read', 'directives_set']))
    const worker = await w.as('worker')
    expect(await worker.tools()).not.toContain('directives_read')
    expect(await worker.tools()).not.toContain('directives_set')
  })
})

describe('directives_read', () => {
  it('says there is no record before one is set', async () => {
    const aquila = await world().as('direction')
    expect(await aquila.ok('directives_read')).toEqual({ directives: null })
  })

  it('returns the current record with its version, who set it, when and why', async () => {
    const w = world()
    const aquila = await ownerPresent(w)
    await aquila.ok('directives_set', { record: RECORD, reason: 'owner pick order', expected_version: 0, caller_thread_id: AQUILA_THREAD })

    const afk = await w.as('afk')
    const read = await afk.ok('directives_read')
    expect(read.directives).toEqual({
      version: 1,
      record: RECORD,
      set_at: w.clock.iso(),
      set_by: AQUILA_THREAD,
      source: 'owner',
      reason: 'owner pick order',
    })
  })

  it('refuses a version that was never recorded', async () => {
    const aquila = await world().as('direction')
    const result = await aquila.call('directives_read', { version: 3 })
    expect(result.isError).toBe(true)
    expect(text(result)).toMatch(/no directives version 3/)
  })
})

describe('directives_set: who may write', () => {
  it('records the record from the direction lease holder while the owner is present, numbering it 1', async () => {
    const w = world()
    const aquila = await ownerPresent(w)
    const result = await aquila.ok('directives_set', { record: RECORD, reason: 'first', expected_version: 0, caller_thread_id: AQUILA_THREAD })
    expect(result.directives).toMatchObject({ version: 1, source: 'owner', set_by: AQUILA_THREAD, reason: 'first' })
    expect(result.directives.record).toEqual(RECORD)
  })

  it('refuses when the owner has not taken a turn', async () => {
    const aquila = await world().as('direction')
    const result = await set(aquila)
    expect(result.isError).toBe(true)
    expect(text(result)).toMatch(/owner is not present/)
    expect(await aquila.ok('directives_read')).toEqual({ directives: null })
  })

  it('refuses once the owner has been away longer than the presence window', async () => {
    const w = world()
    const aquila = await ownerPresent(w)
    w.clock.advance(31 * MINUTE)
    const result = await set(aquila)
    expect(result.isError).toBe(true)
    expect(text(result)).toMatch(/owner is not present/)
  })

  it('refuses after the owner steps away', async () => {
    const w = world()
    const aquila = await w.as('direction')
    await aquila.ok('owner_turn', { caller_thread_id: AQUILA_THREAD, stepping_away: true })
    const result = await set(aquila)
    expect(result.isError).toBe(true)
    expect(text(result)).toMatch(/owner is not present/)
  })

  it('refuses a thread that does not hold the direction lease, naming the holder, even with the owner present', async () => {
    const w = world()
    const aquila = await ownerPresent(w)
    const result = await set(aquila, { caller_thread_id: STRAY })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain(AQUILA_THREAD)
    expect(text(result)).toMatch(/direction lease/)
    expect(await aquila.ok('directives_read')).toEqual({ directives: null })
  })

  it("tells Aquila's next gate about a refused write, as a lease conflict", async () => {
    const w = world()
    const aquila = await ownerPresent(w)
    await aquila.ok('status_tick', tick(AQUILA_THREAD))
    await set(aquila, { caller_thread_id: STRAY })
    expect(await aquila.ok('tick_gate', tick(AQUILA_THREAD))).toMatchObject({ changed: true, reasons: expect.arrayContaining(['lease_conflict']) })
  })

  it('refuses a call that names no caller_thread_id, with no grace period', async () => {
    const w = world()
    const aquila = await ownerPresent(w)
    const result = await aquila.call('directives_set', { record: MINIMAL, reason: 'x', expected_version: 0 })
    expect(result.isError).toBe(true)
    expect(text(result)).toMatch(/caller_thread_id/)
  })

  it('refuses when nobody holds the direction lease', async () => {
    const w = world({ leases: {} })
    const aquila = await w.as('direction')
    const result = await set(aquila)
    expect(result.isError).toBe(true)
    expect(text(result)).toMatch(/no thread holds the direction lease/)
  })

  it('wakes the AFK loop gate with a directives_set change', async () => {
    const w = world()
    const aquila = await ownerPresent(w)
    const afk = await w.as('afk')
    await afk.ok('status_tick', tick(AFK_THREAD))
    await aquila.ok('directives_set', { record: MINIMAL, reason: 'x', expected_version: 0, caller_thread_id: AQUILA_THREAD })
    expect(await afk.ok('tick_gate', tick(AFK_THREAD))).toMatchObject({ changed: true, reasons: ['directives_set'] })
  })
})

describe('directives_set: versions and history', () => {
  it('numbers each write one above the last and keeps every version', async () => {
    const w = world()
    const aquila = await ownerPresent(w)
    await aquila.ok('directives_set', { record: MINIMAL, reason: 'first', expected_version: 0, caller_thread_id: AQUILA_THREAD })
    w.clock.advance(MINUTE)
    const next = { ...MINIMAL, max_slots: 1 }
    const second = await aquila.ok('directives_set', { record: next, reason: 'cap to 1', expected_version: 1, caller_thread_id: AQUILA_THREAD })
    expect(second.directives.version).toBe(2)

    const read = await aquila.ok('directives_read', { history: true })
    expect(read.directives).toMatchObject({ version: 2, record: next })
    expect(read.history.map((entry: any) => [entry.version, entry.reason, entry.source])).toEqual([
      [2, 'cap to 1', 'owner'],
      [1, 'first', 'owner'],
    ])
    expect(read.history[0]).not.toHaveProperty('record')
    expect((await aquila.ok('directives_read', { version: 1 })).directives).toMatchObject({ version: 1, record: MINIMAL })
  })

  it('refuses a write made against a stale version, naming the current one', async () => {
    const w = world()
    const aquila = await ownerPresent(w)
    await aquila.ok('directives_set', { record: MINIMAL, reason: 'first', expected_version: 0, caller_thread_id: AQUILA_THREAD })
    const result = await set(aquila, { expected_version: 0 })
    expect(result.isError).toBe(true)
    expect(text(result)).toMatch(/current version is 1/)
    expect((await aquila.ok('directives_read', { history: true })).history).toHaveLength(1)
  })

  it('survives a restart', async () => {
    const w = world()
    const aquila = await ownerPresent(w)
    await aquila.ok('directives_set', { record: RECORD, reason: 'first', expected_version: 0, caller_thread_id: AQUILA_THREAD })
    w.restart()
    expect((await (await w.as('afk')).ok('directives_read')).directives).toMatchObject({ version: 1, record: RECORD })
  })

  it('requires a reason', async () => {
    const w = world()
    const aquila = await ownerPresent(w)
    const result = await set(aquila, { reason: '  ' })
    expect(result.isError).toBe(true)
    expect(text(result)).toMatch(/reason/)
  })
})

describe('directives_set: the record is validated as the directives file is', () => {
  const refused = async (record: unknown, pattern: RegExp) => {
    const w = world()
    const aquila = await ownerPresent(w)
    const result = await set(aquila, { record })
    expect(result.isError).toBe(true)
    expect(text(result)).toMatch(pattern)
    expect(await aquila.ok('directives_read')).toEqual({ directives: null })
  }

  it('accepts the live v20 directives', async () => {
    const w = world()
    const aquila = await ownerPresent(w)
    expect((await set(aquila, { record: RECORD })).isError).toBeFalsy()
  })

  it('refuses a missing required key', () => refused({ max_slots: 2 }, /missing key: cadence_minutes/))
  it('refuses an unknown key', () => refused({ ...MINIMAL, max_slot: 2 }, /unknown key: max_slot/))
  it('refuses a version in the record: the server numbers versions', () => refused({ ...MINIMAL, version: 5 }, /version is assigned by the server/))
  it('refuses a record that is not an object', () => refused(['x'], /record/))
  it('refuses max_slots that is not a positive integer', () => refused({ ...MINIMAL, max_slots: 0 }, /max_slots must be a positive integer/))
  it('refuses a host cap above max_slots', () => refused({ ...MINIMAL, host_caps: { homelab: 3 } }, /host_caps\.homelab/))
  it('refuses a repo hold without a reason', () => refused({ ...MINIMAL, repo_holds: [{ repo: 'a/b', reason: ' ' }] }, /repo_holds\[0\]: reason/))
  it('refuses a malformed take_next entry', () => refused({ ...MINIMAL, take_next: ['argus#1'] }, /take_next\[0\]/))
  it('refuses a memory pressure above 100', () => refused({ ...MINIMAL, max_memory_pressure: 101 }, /max_memory_pressure/))
  it('refuses a disk percentage of 0', () => refused({ ...MINIMAL, max_disk_percent: 0 }, /max_disk_percent must be a percentage/))
  it('refuses a disk percentage above 100', () => refused({ ...MINIMAL, max_disk_percent: 101 }, /max_disk_percent must be a percentage/))
  it('refuses a host_gates disk percentage of 0', () =>
    refused({ ...MINIMAL, host_gates: { wsl2: { max_disk_percent: 0 } } }, /host_gates\.wsl2\.max_disk_percent must be a percentage/))
  it('refuses a host_gates disk percentage above 100', () =>
    refused({ ...MINIMAL, host_gates: { wsl2: { max_disk_percent: 101 } } }, /host_gates\.wsl2\.max_disk_percent must be a percentage/))
  it('refuses an override of the disk percentage of 0', () =>
    refused({ ...MINIMAL, overrides: [{ key: 'max_disk_percent', value: 0, until: '2026-11-06T00:00:00+11:00', reason: 'x' }] }, /overrides\[0\]: max_disk_percent must be a percentage/))
  it('refuses an override of the disk percentage above 100', () =>
    refused({ ...MINIMAL, overrides: [{ key: 'max_disk_percent', value: 101, until: '2026-11-06T00:00:00+11:00', reason: 'x' }] }, /overrides\[0\]: max_disk_percent must be a percentage/))
  it('refuses a reserve_percent of 100',() => refused({ ...MINIMAL, reserve_percent: 100 }, /reserve_percent/))
  it('refuses an unknown order group', () => refused({ ...MINIMAL, order_groups: ['bug', 'nope'] }, /order_groups\[1\]/))
  it('refuses a repeated map', () => refused({ ...MINIMAL, map_order: ['a/b#1', 'a/b#1'] }, /map_order must not repeat/))
  it('refuses a malformed trunk repo', () => refused({ ...MINIMAL, trunk_repos: ['nonsense'] }, /trunk_repos\[0\]/))
  it('refuses a host_gates entry for an unknown host', () => refused({ ...MINIMAL, host_gates: { mars: { max_load: 2 } } }, /host_gates/))
  it('refuses an override with a bad until', () =>
    refused({ ...MINIMAL, overrides: [{ key: 'max_slots', value: 1, until: 'tomorrow', reason: 'x' }] }, /overrides\[0\]: until/))
  it('refuses an override of a key that cannot be overridden', () =>
    refused({ ...MINIMAL, overrides: [{ key: 'ordering', value: [], until: '2026-11-06T00:00:00+11:00', reason: 'x' }] }, /overrides\[0\]: key must be one of/))

  it('lists every problem at once', async () => {
    const w = world()
    const aquila = await ownerPresent(w)
    const result = await set(aquila, { record: { max_slots: 0, bogus: 1 } })
    expect(text(result)).toMatch(/missing key: cadence_minutes/)
    expect(text(result)).toMatch(/unknown key: bogus/)
    expect(text(result)).toMatch(/max_slots must be a positive integer/)
  })

  it('accepts a valid override', async () => {
    const w = world()
    const aquila = await ownerPresent(w)
    const record = { ...MINIMAL, overrides: [{ key: 'max_slots', value: 1, until: '2026-11-06T00:00:00+11:00', reason: 'quota' }] }
    expect((await set(aquila, { record })).isError).toBeFalsy()
  })

  it('accepts max_disk_percent at the top level', async () => {
    const aquila = await ownerPresent(world())
    expect((await set(aquila, { record: { ...MINIMAL, max_disk_percent: 90 } })).isError).toBeFalsy()
  })

  it('accepts max_disk_percent under host_gates', async () => {
    const aquila = await ownerPresent(world())
    const record = { ...MINIMAL, host_gates: { wsl2: { max_disk_percent: 85 }, homelab: { max_disk_percent: 100 } } }
    expect((await set(aquila, { record })).isError).toBeFalsy()
  })

  // argus#69 (argus-config#1427): host_gates.<host>.quiet_window, `HH:MM-HH:MM` Sydney time, the same
  // rule as argus-config's hooks/directives_effective.py parse_quiet_window.
  it.each(['04:00-05:00', '00:30-05:00', '22:00-02:00', '23:59-00:00', '00:00-23:59'])('accepts host_gates quiet_window %s', async (window) => {
    const aquila = await ownerPresent(world())
    const record = { ...MINIMAL, host_gates: { wsl2: { quiet_window: window } } }
    expect((await set(aquila, { record })).isError).toBeFalsy()
  })

  it('accepts a quiet_window beside the numeric gates, and on both hosts', async () => {
    const aquila = await ownerPresent(world())
    const record = {
      ...MINIMAL,
      host_gates: { wsl2: { max_disk_percent: 95, quiet_window: '04:00-05:00' }, homelab: { quiet_window: '00:30-05:00' } },
    }
    expect((await set(aquila, { record })).isError).toBeFalsy()
  })

  it('stores the quiet_window it accepts', async () => {
    const aquila = await ownerPresent(world())
    const record = { ...MINIMAL, host_gates: { wsl2: { max_disk_percent: 95, quiet_window: '04:00-05:00' } } }
    await set(aquila, { record })
    const read = (await aquila.ok('directives_read')) as { directives: { record: { host_gates: unknown } } }
    expect(read.directives.record.host_gates).toEqual(record.host_gates)
  })

  it('accepts a record with no quiet_window', async () => {
    const aquila = await ownerPresent(world())
    const record = { ...MINIMAL, host_gates: { wsl2: { max_disk_percent: 95 } } }
    expect((await set(aquila, { record })).isError).toBeFalsy()
  })

  it.each([
    ['too short', '4:00-05:00'],
    ['no separator', '04:00 05:00'],
    ['seconds', '04:00:00-05:00:00'],
    ['hour 24', '24:00-05:00'],
    ['hour 25', '04:00-25:00'],
    ['minute 60', '04:60-05:00'],
    ['start equals end', '04:00-04:00'],
    ['a trailing space', '04:00-05:00 '],
    ['empty', ''],
  ])('refuses a malformed host_gates quiet_window: %s', (_label, window) =>
    refused({ ...MINIMAL, host_gates: { wsl2: { quiet_window: window } } }, /host_gates\.wsl2\.quiet_window must be HH:MM-HH:MM/))

  it.each([
    ['a number', 400],
    ['null', null],
    ['a list', ['04:00-05:00']],
    ['a mapping', { start: '04:00', end: '05:00' }],
  ])('refuses a quiet_window that is %s', (_label, window) =>
    refused({ ...MINIMAL, host_gates: { wsl2: { quiet_window: window } } }, /host_gates\.wsl2\.quiet_window must be HH:MM-HH:MM/))

  it('names quiet_window among the keys a host_gates entry may carry', () =>
    refused({ ...MINIMAL, host_gates: { wsl2: { bogus: 1 } } }, /host_gates\.wsl2 must be a mapping of max_load, max_io_pressure, max_memory_pressure, max_disk_percent, quiet_window/))

  it('refuses quiet_window at the top level', () => refused({ ...MINIMAL, quiet_window: '04:00-05:00' }, /unknown key: quiet_window/))

  it('refuses quiet_window as an override key', () =>
    refused({ ...MINIMAL, overrides: [{ key: 'quiet_window', value: '04:00-05:00', until: '2026-11-06T00:00:00+11:00', reason: 'x' }] }, /overrides\[0\]: key must be one of/))

  it('accepts an override of max_disk_percent', async () => {
    const aquila = await ownerPresent(world())
    const record = { ...MINIMAL, overrides: [{ key: 'max_disk_percent', value: 95, until: '2026-11-06T00:00:00+11:00', reason: 'disk' }] }
    expect((await set(aquila, { record })).isError).toBeFalsy()
  })
})
