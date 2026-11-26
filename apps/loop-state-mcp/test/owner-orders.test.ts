import { describe, expect, it } from 'vitest'

import { directivesProblems, DEFAULT_OWNER_QUIET_HOURS, liveStandingOrders, ownerQuietHours } from '../src/directives.js'

import { AQUILA_THREAD, text, world } from './helpers.js'

// argus#72 (argus-config#1622): `standing_orders` keeps an order the owner gave through a relay past the
// one tick it was given in; `owner_quiet_hours` is the window the tick stays quiet in overnight, which the
// owner can change.

const MINIMAL = { cadence_minutes: 30, max_slots: 2, repo_holds: [], take_next: [], ordering: [] }
const ORDER = { order: 'Name threads <issue>: <title>', owner_quote: 'name every thread after its issue', at: '2026-11-21T17:22:00+11:00' }

const problems = (extra: Record<string, unknown>) => directivesProblems({ ...MINIMAL, ...extra })

describe('standing_orders validation', () => {
  it('accepts an order with no end', () => expect(problems({ standing_orders: [ORDER] })).toEqual([]))
  it('accepts an order with an end', () => expect(problems({ standing_orders: [{ ...ORDER, until: '2026-12-01T00:00:00+11:00' }] })).toEqual([]))
  it('accepts an empty list', () => expect(problems({ standing_orders: [] })).toEqual([]))
  it('accepts an order whose end has passed: it stays on record and is only ignored', () =>
    expect(problems({ standing_orders: [{ ...ORDER, until: '2026-11-22T00:00:00+11:00' }] })).toEqual([]))

  it('refuses a value that is not a list', () => expect(problems({ standing_orders: ORDER })).toEqual(['standing_orders must be a list']))
  it('refuses an entry that is not a mapping', () => expect(problems({ standing_orders: ['x'] })).toEqual(['standing_orders[0]: must be a mapping of order, owner_quote, at and until']))
  it.each(['order', 'owner_quote', 'at'])('refuses an entry missing %s', (field) => {
    const { [field]: _gone, ...entry } = ORDER as Record<string, unknown>
    expect(problems({ standing_orders: [entry] })).toEqual([`standing_orders[0]: missing field: ${field}`])
  })
  it('refuses a blank order', () => expect(problems({ standing_orders: [{ ...ORDER, order: '  ' }] })).toEqual(['standing_orders[0]: order must be a non-empty string']))
  it('refuses a blank owner_quote', () => expect(problems({ standing_orders: [{ ...ORDER, owner_quote: '' }] })).toEqual(['standing_orders[0]: owner_quote must be a non-empty string']))
  it('refuses an unknown field', () => expect(problems({ standing_orders: [{ ...ORDER, why: 'x' }] })).toEqual(['standing_orders[0]: unknown field: why']))
  it('refuses an at with no offset', () =>
    expect(problems({ standing_orders: [{ ...ORDER, at: '2026-11-21T17:22:00' }] })).toEqual([
      'standing_orders[0]: at must be an ISO date-time with an offset, e.g. 2026-11-23T05:33:00+11:00',
    ]))
  it('refuses an until that is not a date-time', () =>
    expect(problems({ standing_orders: [{ ...ORDER, until: 'tomorrow' }] })).toEqual([
      'standing_orders[0]: until must be an ISO date-time with an offset, e.g. 2026-11-23T05:33:00+11:00',
    ]))
  it('refuses an until at or before at', () =>
    expect(problems({ standing_orders: [{ ...ORDER, until: ORDER.at }] })).toEqual(['standing_orders[0]: until must be after at']))
  it('names the entry that is wrong', () =>
    expect(problems({ standing_orders: [ORDER, { ...ORDER, order: '' }] })).toEqual(['standing_orders[1]: order must be a non-empty string']))
})

describe('owner_quiet_hours validation', () => {
  it.each(['22:00-07:00', '00:00-23:59', '09:00-17:00', '23:30-00:30'])('accepts %s, wrapping past midnight or not', (window) =>
    expect(problems({ owner_quiet_hours: window })).toEqual([]),
  )
  it.each(['22:00', '22:00-24:00', '7:00-22:00', '22:00-07:60', '22:00 - 07:00', 'night', 700, null])('refuses %j', (window) =>
    expect(problems({ owner_quiet_hours: window })).toEqual(['owner_quiet_hours must be HH:MM-HH:MM (Sydney time, start and end differ), e.g. 22:00-07:00']),
  )
  it('refuses an empty window, where start equals end', () =>
    expect(problems({ owner_quiet_hours: '07:00-07:00' })).toEqual(['owner_quiet_hours must be HH:MM-HH:MM (Sydney time, start and end differ), e.g. 22:00-07:00']))
  it('is a record key only: it is not a host gate or an override', () => {
    expect(problems({ host_gates: { wsl2: { owner_quiet_hours: '22:00-07:00' } } })).not.toEqual([])
    expect(problems({ overrides: [{ key: 'owner_quiet_hours', value: '22:00-07:00', until: '2026-11-30T00:00:00+11:00', reason: 'x' }] })).not.toEqual([])
  })
})

describe('liveStandingOrders', () => {
  const at = (iso: string) => Date.parse(iso)
  const record = (standing_orders: unknown) => ({ ...MINIMAL, standing_orders })

  it('returns an order with no end, whenever it is asked', () => expect(liveStandingOrders(record([ORDER]), at('2027-06-01T00:00:00Z'))).toEqual([ORDER]))
  it('returns an order before its end', () => {
    const order = { ...ORDER, until: '2026-12-01T00:00:00+11:00' }
    expect(liveStandingOrders(record([order]), at('2026-11-30T12:00:00+11:00'))).toEqual([order])
  })
  it('ignores an order once its end has passed, at the end itself too', () => {
    const order = { ...ORDER, until: '2026-12-01T00:00:00+11:00' }
    expect(liveStandingOrders(record([order]), at('2026-12-01T00:00:00+11:00'))).toEqual([])
    expect(liveStandingOrders(record([order]), at('2026-12-02T00:00:00+11:00'))).toEqual([])
  })
  it('keeps the live orders and drops the expired ones, in order', () => {
    const live = { ...ORDER, order: 'b' }
    const expired = { ...ORDER, order: 'a', until: '2026-11-22T00:00:00+11:00' }
    expect(liveStandingOrders(record([expired, live]), at('2026-11-23T00:00:00+11:00'))).toEqual([live])
  })
  it('ignores a malformed entry rather than returning it', () => {
    expect(liveStandingOrders(record([{ order: 'x' }, 'y', ORDER]), at('2026-11-23T00:00:00+11:00'))).toEqual([ORDER])
  })
  it('returns nothing for a record with no standing_orders, or no record', () => {
    expect(liveStandingOrders(MINIMAL, 0)).toEqual([])
    expect(liveStandingOrders(null, 0)).toEqual([])
    expect(liveStandingOrders(record('x'), 0)).toEqual([])
  })
})

describe('ownerQuietHours', () => {
  it('defaults to 22:00-07:00', () => {
    expect(DEFAULT_OWNER_QUIET_HOURS).toBe('22:00-07:00')
    expect(ownerQuietHours(MINIMAL)).toBe('22:00-07:00')
    expect(ownerQuietHours(null)).toBe('22:00-07:00')
  })
  it('returns the owner’s window when one is set', () => expect(ownerQuietHours({ ...MINIMAL, owner_quiet_hours: '23:00-06:30' })).toBe('23:00-06:30'))
  it('falls back to the default for a malformed window', () => expect(ownerQuietHours({ ...MINIMAL, owner_quiet_hours: 'night' })).toBe('22:00-07:00'))
})

describe('directives_set and directives_read carry both keys', () => {
  it('stores and returns standing_orders and owner_quiet_hours as written', async () => {
    const w = world()
    const aquila = await w.as('direction')
    await aquila.ok('owner_turn', { caller_thread_id: AQUILA_THREAD })
    const record = { ...MINIMAL, standing_orders: [ORDER, { ...ORDER, order: 'CI first', until: '2026-12-01T00:00:00+11:00' }], owner_quiet_hours: '23:00-06:30' }
    const set = await aquila.call('directives_set', { record, reason: 'test', expected_version: 0, caller_thread_id: AQUILA_THREAD })
    expect(set.isError).toBeFalsy()
    const read = (await aquila.ok('directives_read')) as { directives: { record: Record<string, unknown> } }
    expect(read.directives.record['standing_orders']).toEqual(record.standing_orders)
    expect(read.directives.record['owner_quiet_hours']).toBe('23:00-06:30')
  })

  it('refuses a malformed value with the reason, and writes nothing', async () => {
    const w = world()
    const aquila = await w.as('direction')
    await aquila.ok('owner_turn', { caller_thread_id: AQUILA_THREAD })
    const record = { ...MINIMAL, standing_orders: [{ ...ORDER, at: 'yesterday' }], owner_quiet_hours: '25:00-07:00' }
    const set = await aquila.call('directives_set', { record, reason: 'test', expected_version: 0, caller_thread_id: AQUILA_THREAD })
    expect(set.isError).toBe(true)
    expect(text(set)).toMatch(/standing_orders\[0\]: at must be an ISO date-time/)
    expect(text(set)).toMatch(/owner_quiet_hours must be HH:MM-HH:MM/)
    expect(await aquila.ok('directives_read')).toEqual({ directives: null })
  })

  it('takes a standing order through a patch, as it takes any list', async () => {
    const w = world()
    const aquila = await w.as('direction')
    await aquila.ok('owner_turn', { caller_thread_id: AQUILA_THREAD })
    await aquila.ok('directives_set', { record: MINIMAL, reason: 'test', expected_version: 0, caller_thread_id: AQUILA_THREAD })
    const patched = await aquila.call('directives_set', { patch: { add: { standing_orders: [ORDER] } }, reason: 'order', expected_version: 1, caller_thread_id: AQUILA_THREAD })
    expect(patched.isError).toBeFalsy()
    const read = (await aquila.ok('directives_read')) as { directives: { record: Record<string, unknown> } }
    expect(read.directives.record['standing_orders']).toEqual([ORDER])
  })
})
