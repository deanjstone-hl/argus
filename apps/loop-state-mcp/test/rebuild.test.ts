import { describe, expect, it } from 'vitest'

import { fakeGitHub, fakeT3, observe } from './fakes.js'
import { AFK_THREAD, AQUILA_THREAD, MINUTE, text, world } from './helpers.js'

const PARKED = 'deanjstone/argus#701'
const BUSY = 'deanjstone/argus#702'
const QUIET = 'deanjstone/homelab#88'
const ABANDONED = 'deanjstone/myargus#309'
const OWNER_ONLY = 'deanjstone/argus-config#661'

const aquilaTick = { thread_id: AQUILA_THREAD, directives_version: 'v1', needs_owner: [] }
const afkTick = { thread_id: AFK_THREAD, directives_version: 'v1', needs_owner: [] }

type Caller = { ok: (name: string, args?: Record<string, unknown>) => Promise<any> }
const slotsOf = async (caller: Caller) =>
  ((await caller.ok('slot_list')).slots as { issue: string; thread_id: string; state: string; started_at: string }[]).map(
    ({ issue, thread_id, state }) => [issue, state, thread_id],
  )

/** The world at the cut: the loop's issues on GitHub and its workers in T3, with an empty db. */
function cutWorld() {
  const github = fakeGitHub()
  const t3 = fakeT3()
  github.assign(PARKED, { needsOwner: true, claimedBy: 'worker-y' })
  t3.thread('worker-y', 'idle')
  github.assign(BUSY)
  t3.thread('worker-z', 'running', BUSY)
  github.assign(QUIET, { claimedBy: 'worker-q' })
  t3.thread('worker-q', 'idle')
  github.assign(ABANDONED, { claimedBy: 'worker-gone' })
  t3.thread('worker-gone', 'settled')
  github.open(OWNER_ONLY, { needsOwner: true })
  return { github, t3 }
}

describe('rebuild-from-GitHub', () => {
  it('reconstructs slots from a described world, compare-only by default', async () => {
    const { as } = world({ leases: { direction: AQUILA_THREAD } })
    const aquila = await as('direction')
    const { github, t3 } = cutWorld()

    const report = await aquila.ok('slot_rebuild', observe(github, t3))

    expect(report.applied).toBe(false)
    expect(report.agrees).toBe(false)
    expect(report.changes).toEqual([
      { issue: PARKED, action: 'add', from: null, to: { state: 'parked', thread_id: 'worker-y' } },
      { issue: BUSY, action: 'add', from: null, to: { state: 'running', thread_id: 'worker-z' } },
      { issue: QUIET, action: 'add', from: null, to: { state: 'running', thread_id: 'worker-q' } },
    ])
    expect(report.idle_workers).toEqual([{ issue: QUIET, thread_id: 'worker-q' }])
    expect(report.orphaned).toEqual([{ issue: ABANDONED, reason: expect.stringMatching(/worker-gone.*settled/) }])
    expect(report.unresolved).toEqual([])
  })

  it('writes nothing in compare-only mode: no slot, and nothing for a gate to see', async () => {
    const { as } = world({ leases: { direction: AQUILA_THREAD } })
    const aquila = await as('direction')
    await aquila.ok('status_tick', aquilaTick)
    const { github, t3 } = cutWorld()

    await aquila.ok('slot_rebuild', { ...observe(github, t3), apply: false })

    expect(await slotsOf(aquila)).toEqual([])
    expect((await aquila.ok('tick_gate', aquilaTick)).changed).toBe(false)
  })

  it('seeds the db at the cut, and a second compare then agrees with GitHub', async () => {
    const { as } = world({ leases: { direction: AQUILA_THREAD } })
    const aquila = await as('direction')
    const { github, t3 } = cutWorld()

    const seeded = await aquila.ok('slot_rebuild', { ...observe(github, t3), apply: true })
    expect(seeded.applied).toBe(true)
    expect(await slotsOf(aquila)).toEqual([
      [PARKED, 'parked', 'worker-y'],
      [BUSY, 'running', 'worker-z'],
      [QUIET, 'running', 'worker-q'],
    ])

    const check = await aquila.ok('slot_rebuild', observe(github, t3))
    expect(check).toMatchObject({ applied: false, agrees: true, changes: [] })
    expect(check.orphaned).toHaveLength(1)
  })

  it('leaves an assigned issue it cannot tie to a thread unresolved, not guessed', async () => {
    const { as } = world({ leases: { direction: AQUILA_THREAD } })
    const aquila = await as('direction')
    const github = fakeGitHub()
    github.assign(PARKED, { needsOwner: true })

    const report = await aquila.ok('slot_rebuild', { ...observe(github, fakeT3()), apply: true })
    expect(report.changes).toEqual([])
    expect(report.unresolved).toEqual([{ issue: PARKED, reason: expect.stringMatching(/no worker thread/) }])
    expect(await slotsOf(aquila)).toEqual([])
  })

  it('lets Aquila write a rebuild only while no AFK thread holds the lease: the running loop writes its own slots', async () => {
    const { as } = world()
    const aquila = await as('direction')
    const { github, t3 } = cutWorld()

    const refused = await aquila.call('slot_rebuild', { ...observe(github, t3), apply: true })
    expect(refused.isError).toBe(true)
    expect(text(refused)).toMatch(/afk lease is held by thread-afk-0001/)
    expect(await slotsOf(aquila)).toEqual([])

    expect((await aquila.ok('slot_rebuild', observe(github, t3))).changes).toHaveLength(3)
  })

  it('is not offered to a worker', async () => {
    const { as } = world()
    expect(await (await as('worker')).tools()).not.toContain('slot_rebuild')
  })

  it('reconciles after an outage: closes, parks, answers and dead workers that happened while the db was down', async () => {
    const { as, clock } = world()
    const afk = await as('afk')
    const aquila = await as('direction')
    await afk.ok('slot_start', { issue: PARKED, thread_id: 'worker-1' })
    await afk.ok('slot_park', { issue: PARKED })
    await afk.ok('slot_start', { issue: BUSY, thread_id: 'worker-2' })
    await afk.ok('slot_start', { issue: QUIET, thread_id: 'worker-3' })
    await afk.ok('slot_start', { issue: ABANDONED, thread_id: 'worker-4' })
    const quietStarted = clock.iso()
    await afk.ok('status_tick', afkTick)
    await aquila.ok('status_tick', aquilaTick)

    // The db is unreachable for two hours. Workers carry on and GitHub keeps the mirror.
    clock.advance(120 * MINUTE)
    const github = fakeGitHub()
    const t3 = fakeT3()
    github.assign(PARKED) // Aquila relayed the owner's answer and removed needs:owner
    t3.thread('worker-1', 'idle', PARKED)
    github.assign(BUSY, { needsOwner: true }) // the worker parked on a question
    t3.thread('worker-2', 'idle', BUSY)
    github.assign(QUIET) // still working
    t3.thread('worker-3', 'running', QUIET)
    github.assign(ABANDONED) // the worker thread died
    t3.thread('worker-4', 'archived', ABANDONED)
    // the fifth issue the loop had closed during the outage is simply gone from GitHub

    const report = await afk.ok('slot_rebuild', { ...observe(github, t3), apply: true, caller_thread_id: AFK_THREAD })

    expect(report.changes).toEqual([
      { issue: PARKED, action: 'update', from: { state: 'parked', thread_id: 'worker-1' }, to: { state: 'ready', thread_id: 'worker-1' } },
      { issue: BUSY, action: 'update', from: { state: 'running', thread_id: 'worker-2' }, to: { state: 'parked', thread_id: 'worker-2' } },
      { issue: ABANDONED, action: 'remove', from: { state: 'running', thread_id: 'worker-4' }, to: null },
    ])
    expect(report.orphaned).toEqual([{ issue: ABANDONED, reason: expect.stringMatching(/worker-4.*archived/) }])
    expect(await slotsOf(afk)).toEqual([
      [PARKED, 'ready', 'worker-1'],
      [BUSY, 'parked', 'worker-2'],
      [QUIET, 'running', 'worker-3'],
    ])
    const quiet = ((await afk.ok('slot_list')).slots as { issue: string; started_at: string }[]).find((slot) => slot.issue === QUIET)
    expect(quiet?.started_at).toBe(quietStarted)

    // The reconcile is slot activity Aquila's gate sees.
    expect(await aquila.ok('tick_gate', aquilaTick)).toMatchObject({ changed: true, reasons: ['slot_rebuilt'] })
  })

  it('removes a slot whose issue was closed during the outage', async () => {
    const { as } = world()
    const afk = await as('afk')
    await afk.ok('slot_start', { issue: BUSY, thread_id: 'worker-2' })

    const report = await afk.ok('slot_rebuild', { issues: [], threads: [], apply: true })
    expect(report.changes).toEqual([
      { issue: BUSY, action: 'remove', from: { state: 'running', thread_id: 'worker-2' }, to: null },
    ])
    expect(await slotsOf(afk)).toEqual([])
  })

  it('keeps a ready slot ready: un-parked work waits for a free slot even though its old worker is still alive', async () => {
    const { as } = world()
    const afk = await as('afk')
    const aquila = await as('direction')
    await afk.ok('slot_start', { issue: PARKED, thread_id: 'worker-1' })
    await afk.ok('slot_park', { issue: PARKED })
    await aquila.ok('slot_unpark', { issue: PARKED })
    const github = fakeGitHub()
    const t3 = fakeT3()
    github.assign(PARKED, { claimedBy: 'worker-1' })
    t3.thread('worker-1', 'idle')

    expect(await afk.ok('slot_rebuild', observe(github, t3))).toMatchObject({ agrees: true, changes: [] })
  })
})
