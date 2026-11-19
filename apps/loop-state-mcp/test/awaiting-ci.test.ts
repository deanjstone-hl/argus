import { DatabaseSync } from 'node:sqlite'

import { describe, expect, it } from 'vitest'

import { fakeGitHub, fakeT3, observe } from './fakes.js'
import { MIGRATIONS } from '../src/store.js'
import { AFK_THREAD, AQUILA_THREAD, MIGRATION_TEST_TIMEOUT_MS, tempDbPath, text, world } from './helpers.js'

/**
 * argus-config#1169: a worker whose PR is open and whose checks have started reports awaiting_ci
 * and ends its turn. The slot stops counting toward every cap while it waits; at most
 * `awaiting_ci_cap` (default 3) slots wait at once. Aquila moves it back to running when the
 * checks finish, or to ready when the caps leave no room, and wakes the worker.
 */

const A = 'deanjstone/argus#701'
const B = 'deanjstone/argus#702'
const C = 'deanjstone/argus#703'
const D = 'deanjstone/argus#704'
const PR = 'https://github.com/deanjstone/argus/pull/9001'

const tick = (extra: Record<string, unknown> = {}) => ({ thread_id: AFK_THREAD, directives_version: 'v1', needs_owner: [] as string[], ...extra })
const MINIMAL = { cadence_minutes: 30, max_slots: 4, repo_holds: [], take_next: [], ordering: [] }

type Slot = { issue: string; thread_id: string; state: string; ci_ref: string | null; note: string | null }
type Caller = { ok: (name: string, args?: Record<string, unknown>) => Promise<any>; call: (name: string, args?: Record<string, unknown>) => Promise<any> }
const slotOf = async (caller: Caller, issue: string) => ((await caller.ok('slot_list')).slots as Slot[]).find((slot) => slot.issue === issue)

async function started(issues: string[]) {
  const w = world()
  const afk = await w.as('afk')
  const worker = await w.as('worker')
  const aquila = await w.as('direction')
  for (const [index, issue] of issues.entries()) await afk.ok('slot_start', { issue, thread_id: `worker-${index + 1}` })
  return { ...w, afk, worker, aquila }
}

const awaitCi = (worker: Caller, issue: string, thread = 'worker-1', extra: Record<string, unknown> = {}) =>
  worker.call('slot_await_ci', { issue, thread_id: thread, ref: PR, ...extra })

describe('slot_await_ci', () => {
  it('moves a running slot to awaiting_ci and records what it waits on', async () => {
    const { worker } = await started([A])

    const result = await worker.ok('slot_await_ci', { issue: A, thread_id: 'worker-1', ref: PR, note: 'checks started' })

    expect(result.slot).toMatchObject({ issue: A, state: 'awaiting_ci', ci_ref: PR, note: 'checks started', thread_id: 'worker-1' })
    expect(await slotOf(worker, A)).toMatchObject({ state: 'awaiting_ci', ci_ref: PR })
  })

  it('accepts a trunk SHA as the ref', async () => {
    const { worker } = await started([A])
    const sha = '09dba31f2c9a4f0f8a3d3d1d7c5a6b7e8f901234'
    expect((await worker.ok('slot_await_ci', { issue: A, thread_id: 'worker-1', ref: sha })).slot.ci_ref).toBe(sha)
  })

  it('refuses a ref that names no PR URL or SHA', async () => {
    const { worker } = await started([A])
    const refused = await awaitCi(worker, A, 'worker-1', { ref: 'soon' })
    expect(refused.isError).toBe(true)
    expect(text(refused)).toMatch(/ref/)
    expect((await slotOf(worker, A))?.state).toBe('running')
  })

  it('refuses a thread that does not hold the slot, and a slot that is not running', async () => {
    const { worker, afk } = await started([A])
    const stranger = await awaitCi(worker, A, 'worker-9')
    expect(stranger.isError).toBe(true)
    expect(text(stranger)).toMatch(/held by thread worker-1/)

    await afk.ok('slot_park', { issue: A, note: 'needs:owner' })
    const parked = await awaitCi(worker, A)
    expect(parked.isError).toBe(true)
    expect(text(parked)).toMatch(/parked, not running/)
  })

  it('is a worker tool: the afk loop and Aquila cannot call it', async () => {
    const { afk, aquila } = await started([A])
    expect(await afk.call('slot_await_ci', { issue: A, thread_id: 'worker-1', ref: PR })).toMatchObject({ isError: true })
    expect(await aquila.call('slot_await_ci', { issue: A, thread_id: 'worker-1', ref: PR })).toMatchObject({ isError: true })
  })

  it('leaves the awaiting slot out of used and every cap, and counts it in status_read', async () => {
    const { afk, worker } = await started([A])
    await afk.ok('status_tick', tick({ total_cap: 1, host_caps: { wsl2: 1 } }))
    await worker.ok('slot_await_ci', { issue: A, thread_id: 'worker-1', ref: PR })

    const { slots } = await afk.ok('status_read')
    expect(slots).toMatchObject({ cap: 1, used: 0, free: 1, awaiting_ci: 1, awaiting_ci_cap: 3, hosts: { wsl2: { used: 0, cap: 1 } } })

    // The freed slot fills as normal.
    expect((await afk.call('slot_start', { issue: B, thread_id: 'worker-2' })).isError).toBeFalsy()
  })

  it('refuses the report past the awaiting cap (default 3): the worker keeps its slot and waits as before', async () => {
    const { worker } = await started([A, B, C, D])
    for (const [index, issue] of [A, B, C].entries()) await worker.ok('slot_await_ci', { issue, thread_id: `worker-${index + 1}`, ref: PR })

    const refused = await awaitCi(worker, D, 'worker-4')
    expect(refused.isError).toBe(true)
    expect(text(refused)).toMatch(/3 slots already await CI \(cap 3\)/)
    expect((await slotOf(worker, D))?.state).toBe('running')
  })

  it('takes the cap from the directives key awaiting_ci_cap', async () => {
    const { worker, aquila } = await started([A, B])
    await aquila.ok('owner_turn', { caller_thread_id: AQUILA_THREAD })
    await aquila.ok('directives_set', {
      record: { ...MINIMAL, awaiting_ci_cap: 1 },
      reason: 'test',
      expected_version: 0,
      caller_thread_id: AQUILA_THREAD,
    })

    await worker.ok('slot_await_ci', { issue: A, thread_id: 'worker-1', ref: PR })
    const refused = await awaitCi(worker, B, 'worker-2')
    expect(refused.isError).toBe(true)
    expect(text(refused)).toMatch(/cap 1/)
    expect((await aquila.ok('status_read')).slots.awaiting_ci_cap).toBe(1)
  })

  it('an awaiting_ci_cap of 0 turns the state off', async () => {
    const { worker, aquila } = await started([A])
    await aquila.ok('owner_turn', { caller_thread_id: AQUILA_THREAD })
    await aquila.ok('directives_set', { record: { ...MINIMAL, awaiting_ci_cap: 0 }, reason: 'test', expected_version: 0, caller_thread_id: AQUILA_THREAD })
    expect((await awaitCi(worker, A)).isError).toBe(true)
  })

  it('does not let an awaiting slot be reported on, parked or closed', async () => {
    const { worker, afk } = await started([A])
    await worker.ok('slot_await_ci', { issue: A, thread_id: 'worker-1', ref: PR })

    expect((await worker.call('slot_report', { issue: A, thread_id: 'worker-1', outcome: 'complete' })).isError).toBe(true)
    expect((await afk.call('slot_park', { issue: A })).isError).toBe(true)
    expect((await afk.call('slot_close', { issue: A, verified: 'Verified: x' })).isError).toBe(true)
    expect((await afk.call('slot_start', { issue: A, thread_id: 'worker-2' })).isError).toBe(true)
  })

  it('can be freed like any other slot', async () => {
    const { worker, afk } = await started([A])
    await worker.ok('slot_await_ci', { issue: A, thread_id: 'worker-1', ref: PR })
    await afk.ok('slot_free', { issue: A, reason: 'worker gone' })
    expect(await slotOf(afk, A)).toBeUndefined()
  })

  it('filters slot_list by the new state', async () => {
    const { worker, afk } = await started([A, B])
    await worker.ok('slot_await_ci', { issue: A, thread_id: 'worker-1', ref: PR })
    expect(((await afk.ok('slot_list', { state: 'awaiting_ci' })).slots as Slot[]).map((slot) => slot.issue)).toEqual([A])
  })
})

describe('slot_resume_ci', () => {
  it('moves the slot back to running when the caps have room, and drops the ci ref', async () => {
    const { worker, aquila, afk } = await started([A])
    await afk.ok('status_tick', tick({ total_cap: 1 }))
    await worker.ok('slot_await_ci', { issue: A, thread_id: 'worker-1', ref: PR })

    const result = await aquila.ok('slot_resume_ci', { issue: A, note: 'checks green' })

    expect(result).toMatchObject({ resumed: true, slot: { issue: A, state: 'running', thread_id: 'worker-1', ci_ref: null, note: 'checks green' } })
    expect((await afk.ok('status_read')).slots).toMatchObject({ used: 1, awaiting_ci: 0 })
  })

  it('moves the slot to ready when the total cap is full, so it waits for a free slot', async () => {
    const { worker, aquila, afk } = await started([A])
    await afk.ok('status_tick', tick({ total_cap: 1 }))
    await worker.ok('slot_await_ci', { issue: A, thread_id: 'worker-1', ref: PR })
    await afk.ok('slot_start', { issue: B, thread_id: 'worker-2' })

    const result = await aquila.ok('slot_resume_ci', { issue: A, note: 'checks red: test' })

    expect(result).toMatchObject({ resumed: false, slot: { issue: A, state: 'ready', thread_id: 'worker-1', note: 'checks red: test' } })
    expect(result.reason).toMatch(/effective slot cap 1 is reached \(1 running\)/)
    expect((await afk.ok('status_read')).slots).toMatchObject({ used: 1, ready: 1, awaiting_ci: 0 })
  })

  it('moves the slot to ready when its host cap is full', async () => {
    const { worker, aquila, afk } = await started([A])
    await afk.ok('status_tick', tick({ total_cap: 3, host_caps: { wsl2: 1 } }))
    await worker.ok('slot_await_ci', { issue: A, thread_id: 'worker-1', ref: PR })
    await afk.ok('slot_start', { issue: B, thread_id: 'worker-2' })

    const result = await aquila.ok('slot_resume_ci', { issue: A })
    expect(result).toMatchObject({ resumed: false, slot: { state: 'ready' } })
    expect(result.reason).toMatch(/wsl2 slot cap 1 is reached/)
  })

  it('is not held back by pressure: the worker is already running work', async () => {
    const { worker, aquila, afk } = await started([A])
    await afk.ok('status_tick', tick({ total_cap: 2, pressure: 'no_new_slots' }))
    await worker.ok('slot_await_ci', { issue: A, thread_id: 'worker-1', ref: PR })
    expect(await aquila.ok('slot_resume_ci', { issue: A })).toMatchObject({ resumed: true })
  })

  it('refuses a slot that is not awaiting CI', async () => {
    const { aquila } = await started([A])
    const refused = await aquila.call('slot_resume_ci', { issue: A })
    expect(refused.isError).toBe(true)
    expect(text(refused)).toMatch(/running, not awaiting_ci/)
  })

  it('is Aquila\'s tool alone', async () => {
    const { worker, afk, aquila } = await started([A])
    await worker.ok('slot_await_ci', { issue: A, thread_id: 'worker-1', ref: PR })
    expect((await afk.call('slot_resume_ci', { issue: A })).isError).toBe(true)
    expect((await worker.call('slot_resume_ci', { issue: A })).isError).toBe(true)
    expect(await slotOf(aquila, A)).toMatchObject({ state: 'awaiting_ci' })
  })

  it('lets the resumed worker report and close as before', async () => {
    const { worker, aquila, afk } = await started([A])
    await worker.ok('slot_await_ci', { issue: A, thread_id: 'worker-1', ref: PR })
    await aquila.ok('slot_resume_ci', { issue: A })
    await worker.ok('slot_report', { issue: A, thread_id: 'worker-1', outcome: 'complete', pr: PR })
    await afk.ok('slot_close', { issue: A, verified: 'Verified: merged' })
    expect(await slotOf(afk, A)).toBeUndefined()
  })
})

/**
 * argus/37: a green trunk slot has nothing left to build, only a Resolution to post, so Aquila
 * resumes it with report_only and the caps (total, effective and host) do not hold it back. A
 * checks-red resume does real work and stays capped.
 */
describe('slot_resume_ci with report_only', () => {
  const SHA = '0a69f4f0d1c2b3a4958677665544332211009988'

  // A awaits CI on a trunk push while B fills the one total slot and the one wsl2 slot.
  async function fullCaps() {
    const world = await started([A, B])
    await world.afk.ok('status_tick', tick({ total_cap: 1, host_caps: { wsl2: 1 } }))
    await world.worker.ok('slot_await_ci', { issue: A, thread_id: 'worker-1', ref: SHA })
    return world
  }

  it('moves a green slot to running although the total cap and the host cap are full', async () => {
    const { aquila, afk } = await fullCaps()

    const result = await aquila.ok('slot_resume_ci', { issue: A, note: 'checks green', report_only: true })

    expect(result).toMatchObject({ resumed: true, slot: { issue: A, state: 'running', ci_ref: null, note: 'checks green' } })
    expect(result.reason).toBeUndefined()
    expect((await afk.ok('status_read')).slots).toMatchObject({ used: 2, free: 0, ready: 0, awaiting_ci: 0 })
  })

  it('leaves a red resume capped: it goes to ready, and report_only is refused for it', async () => {
    const { aquila } = await fullCaps()

    const refused = await aquila.call('slot_resume_ci', { issue: A, note: 'checks red: test', report_only: true })
    expect(refused.isError).toBe(true)
    expect(text(refused)).toMatch(/report_only.*checks green/)
    expect(await slotOf(aquila, A)).toMatchObject({ state: 'awaiting_ci', ci_ref: SHA })

    const capped = await aquila.ok('slot_resume_ci', { issue: A, note: 'checks red: test' })
    expect(capped).toMatchObject({ resumed: false, slot: { state: 'ready' } })
    expect(capped.reason).toMatch(/effective slot cap 1 is reached/)
  })

  it('refuses report_only with no note, or a note that does not say checks green', async () => {
    const { aquila } = await fullCaps()
    expect((await aquila.call('slot_resume_ci', { issue: A, report_only: true })).isError).toBe(true)
    expect((await aquila.call('slot_resume_ci', { issue: A, note: 'probably fine', report_only: true })).isError).toBe(true)
    expect(await slotOf(aquila, A)).toMatchObject({ state: 'awaiting_ci' })
  })

  it('still caps a green resume without report_only', async () => {
    const { aquila } = await fullCaps()
    expect(await aquila.ok('slot_resume_ci', { issue: A, note: 'checks green' })).toMatchObject({ resumed: false, slot: { state: 'ready' } })
  })
})

describe('slot_rebuild with an awaiting slot', () => {
  it('keeps awaiting_ci for a live worker on an assigned issue, and does not nudge it as idle', async () => {
    const { worker, aquila } = await started([A])
    await worker.ok('slot_await_ci', { issue: A, thread_id: 'worker-1', ref: PR })
    const github = fakeGitHub()
    const t3 = fakeT3()
    github.assign(A, { claimedBy: 'worker-1' })
    t3.thread('worker-1', 'idle', A)

    const report = await aquila.ok('slot_rebuild', observe(github, t3))

    expect(report.changes).toEqual([])
    expect(report.idle_workers).toEqual([])
  })

  it('still ready-ises an awaiting slot whose issue is needs:owner, and removes one whose worker is gone', async () => {
    const { worker, aquila } = await started([A, B])
    await worker.ok('slot_await_ci', { issue: A, thread_id: 'worker-1', ref: PR })
    await worker.ok('slot_await_ci', { issue: B, thread_id: 'worker-2', ref: PR })
    const github = fakeGitHub()
    const t3 = fakeT3()
    github.assign(A, { needsOwner: true, claimedBy: 'worker-1' })
    t3.thread('worker-1', 'idle', A)
    github.assign(B, { claimedBy: 'worker-2' })
    t3.thread('worker-2', 'settled', B)

    const report = await aquila.ok('slot_rebuild', observe(github, t3))

    expect(report.changes.map((change: { issue: string; action: string; to: { state: string } | null }) => [change.issue, change.action, change.to?.state ?? null])).toEqual([
      [A, 'update', 'parked'],
      [B, 'remove', null],
    ])
  })
})

describe('the awaiting_ci migration', { timeout: MIGRATION_TEST_TIMEOUT_MS }, () => {
  it('keeps every slot, with its host, approvals and report, and then accepts the new state', async () => {
    const path = tempDbPath()
    const before = new DatabaseSync(path)
    const previous = MIGRATIONS.length - 1
    for (const step of MIGRATIONS.slice(0, previous)) before.exec(step as string)
    before.exec(`PRAGMA user_version = ${previous}`)
    before.prepare(
      `INSERT INTO slots (issue, thread_id, state, host, started_at, updated_at, pending_approvals, budget_exempt, report_outcome, report_pr, reported_at)
       VALUES (?, 'worker-1', 'running', 'homelab', 1, 2, 2, 1, 'complete', 'https://github.com/deanjstone/argus/pull/1', 3)`,
    ).run(A)
    before.prepare("INSERT INTO slots (issue, thread_id, state, started_at, updated_at, note) VALUES (?, 'worker-2', 'parked', 1, 1, 'needs:owner')").run(B)
    before.close()

    const { as } = world({ path })
    const worker = await as('worker')
    const slots = (await worker.ok('slot_list')).slots as Slot[]
    expect(slots.map((slot) => [slot.issue, slot.state])).toEqual([[A, 'running'], [B, 'parked']])
    expect(slots[0]).toMatchObject({ host: 'homelab', pending_approvals: 2, budget_exempt: true, ci_ref: null, report: { outcome: 'complete' } })

    await worker.ok('slot_await_ci', { issue: A, thread_id: 'worker-1', ref: PR })
    expect(await slotOf(worker, A)).toMatchObject({ state: 'awaiting_ci', ci_ref: PR })

    const after = new DatabaseSync(path)
    expect(Number((after.prepare('PRAGMA user_version').get() as { user_version: number }).user_version)).toBe(MIGRATIONS.length)
    after.close()
  })
})
