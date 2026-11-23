import { describe, expect, it } from 'vitest'

import { openStore, Refused, type Store } from '../src/store.js'

import { MINUTE, testClock } from './helpers.js'

/**
 * A bounded model check of the direction lease between its WSL2 primary and the homelab standby, run against the
 * real store on a real SQLite db. Every sequence of primary behaviours up to DEPTH steps is played, then a set of
 * long seeded walks. The standby and both pollers act as the charter says they do. After each step the properties
 * below must hold. `verify-loop-state-leases` in `.claude/skills/` says how to read a failure.
 */

const PRIMARY = 'thread-aquila-wsl2'
const STANDBY = 'thread-aquila-homelab'
const STEP_MS = 10 * MINUTE
const CADENCE_MS = 30 * MINUTE

/** What the primary does in one step: a model tick, owner-driven work, nothing but its poller, or nothing at all. */
const PRIMARY_ACTIONS = ['tick', 'work', 'busy', 'down'] as const
type PrimaryAction = (typeof PRIMARY_ACTIONS)[number]

/** The evidence a thread is alive: a model tick or work it did. A poller's client tick is not the thread's own act. */
const EVIDENCE: readonly PrimaryAction[] = ['tick', 'work']

/** A failover needs the primary silent this long: two cadences. The store's grace sits on top of it. */
const FAILOVER_SILENCE_MS = 2 * CADENCE_MS
/** A primary down this long has lost the lease: two cadences, the grace, and two polling steps. */
const DEAD_HOLDER_MS = 2 * CADENCE_MS + 5 * MINUTE + 2 * STEP_MS

interface ModelState {
  at: number
  lastEvidence: number
  downSince: number | null
  failovers: number
}

interface Violation {
  property: string
  trace: string[]
}

const wakeInput = (host: 'wsl2' | 'homelab', thread_id: string) => ({ role: 'direction' as const, host, thread_id, directives_version: 'v1', needs_owner: [] })
const tickInput = (thread_id: string) => ({ thread_id, directives_version: 'v1', needs_owner: [] as string[] })

function attempt(work: () => unknown): boolean {
  try {
    work()
    return true
  } catch (error) {
    if (error instanceof Refused) return false
    throw error
  }
}

function boot(): { store: Store; clock: ReturnType<typeof testClock> } {
  const clock = testClock()
  const store = openStore({ path: ':memory:', now: clock.now, warn: () => {} })
  store.leaseMove('direction', { role: 'direction', to_thread_id: PRIMARY, host: 'wsl2' })
  store.statusTick('direction', tickInput(PRIMARY))
  return { store, clock }
}

const holderOf = (store: Store) => store.leaseRead('direction').leases.direction?.thread_id ?? null

/** One step: the clock moves, the primary acts, its poller runs unless it is down, then the standby's poller. */
function step(store: Store, clock: ReturnType<typeof testClock>, model: ModelState, action: PrimaryAction, log: string[]): string | null {
  clock.advance(STEP_MS)
  model.at += STEP_MS
  const primaryHolds = holderOf(store) === PRIMARY

  if (action === 'tick' && primaryHolds) store.statusTick('direction', tickInput(PRIMARY))
  if (action === 'work' && primaryHolds) store.ownerTurn('direction', { caller_thread_id: PRIMARY })
  if (EVIDENCE.includes(action) && primaryHolds) model.lastEvidence = model.at
  model.downSince = action === 'down' ? (model.downSince ?? model.at) : null

  if (action !== 'down') {
    const wake = store.wakeCheck('direction', wakeInput('wsl2', PRIMARY))
    if (wake.reason === 'reclaim' && attempt(() => store.leaseReclaim('direction', { role: 'direction', from_thread_id: STANDBY, to_thread_id: PRIMARY, host: 'wsl2' }))) {
      store.statusTick('direction', tickInput(PRIMARY))
      model.lastEvidence = model.at
      log.push(`t+${model.at / MINUTE}m primary reclaims`)
    }
  }

  const standbyWake = store.wakeCheck('direction', wakeInput('homelab', STANDBY))
  if (standbyWake.reason === 'failover') {
    const silentFor = model.at - model.lastEvidence
    if (attempt(() => store.leaseFailover('direction', { role: 'direction', from_thread_id: PRIMARY, to_thread_id: STANDBY }))) {
      model.failovers += 1
      log.push(`t+${model.at / MINUTE}m standby fails over (primary's last tick or work ${silentFor / MINUTE}m ago)`)
      if (silentFor < FAILOVER_SILENCE_MS) return 'no failover while the primary ticked or worked within two cadences'
    }
  }
  if (holderOf(store) === STANDBY) store.statusTick('direction', tickInput(STANDBY))

  const holder = holderOf(store)
  if (holder !== PRIMARY && holder !== STANDBY) return 'the lease is held by the primary or the standby, never nobody'
  if (model.downSince !== null && model.at - model.downSince >= DEAD_HOLDER_MS && holder === PRIMARY) {
    return 'a primary down for two cadences, the grace and two polls has lost the lease'
  }
  if (action !== 'down' && holder === STANDBY && log.at(-1)?.includes('fails over') !== true) {
    return 'a primary that is up takes its lease back on its next poll'
  }
  return null
}

/** Plays one sequence of primary actions; the first broken property, with the steps that led to it. */
function play(actions: readonly PrimaryAction[]): Violation | null {
  const { store, clock } = boot()
  const model: ModelState = { at: 0, lastEvidence: 0, downSince: null, failovers: 0 }
  const log: string[] = []
  try {
    for (const action of actions) {
      log.push(`t+${(model.at + STEP_MS) / MINUTE}m primary: ${action}`)
      const broken = step(store, clock, model, action, log)
      if (broken !== null) return { property: broken, trace: log }
    }
    return null
  } finally {
    store.close()
  }
}

function* sequences(depth: number): Generator<PrimaryAction[]> {
  if (depth === 0) {
    yield []
    return
  }
  for (const rest of sequences(depth - 1)) for (const action of PRIMARY_ACTIONS) yield [...rest, action]
}

function seededWalk(seed: number, length: number): PrimaryAction[] {
  let state = seed >>> 0
  const next = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    return state
  }
  const walk: PrimaryAction[] = []
  while (walk.length < length) {
    const action = PRIMARY_ACTIONS[next() % PRIMARY_ACTIONS.length] as PrimaryAction
    const run = 1 + (next() % 14)
    for (let index = 0; index < run && walk.length < length; index += 1) walk.push(action)
  }
  return walk
}

const DEPTH = Number(process.env['LEASE_MODEL_DEPTH'] ?? 4)
const WALKS = Number(process.env['LEASE_MODEL_WALKS'] ?? 120)
const WALK_LENGTH = 40

/** A primary that has only worked since its last model tick, one step before its 4-hour heartbeat wake. */
const WORKED_TO_HEARTBEAT: readonly PrimaryAction[] = Array<PrimaryAction>(23).fill('work')
/** Where the exhaustive search starts: just after a model tick, and just before the heartbeat wake. */
const STARTS: readonly (readonly PrimaryAction[])[] = [[], WORKED_TO_HEARTBEAT]

/** Every sequence up to DEPTH from each start, then WALKS seeded walks long enough to reach failover and reclaim. */
function check(): Violation | null {
  for (const start of STARTS) {
    for (let depth = 1; depth <= DEPTH; depth += 1) {
      for (const actions of sequences(depth)) {
        const violation = play([...start, ...actions])
        if (violation) return violation
      }
    }
  }
  for (let seed = 1; seed <= WALKS; seed += 1) {
    const violation = play(seededWalk(seed, WALK_LENGTH))
    if (violation) return violation
  }
  return null
}

const explain = (violation: Violation | null) => (violation === null ? 'none' : `${violation.property}\n  ${violation.trace.join('\n  ')}`)

describe('direction lease model', () => {
  it('replays argus#1041: an unanswered heartbeat wake alone does not fail a primary over', () => {
    expect(explain(play([...WORKED_TO_HEARTBEAT, 'work', 'busy', 'busy']))).toBe('none')
  })

  it('replays argus#50: a primary that keeps working past an unanswered wake keeps its lease', () => {
    expect(explain(play([...WORKED_TO_HEARTBEAT, ...Array<PrimaryAction>(8).fill('work')]))).toBe('none')
  })

  it('fails a primary down for long enough over to the standby, and the primary reclaims it once back', () => {
    expect(explain(play([...Array<PrimaryAction>(10).fill('down'), 'busy', 'tick']))).toBe('none')
  })

  it(`holds every property for every primary behaviour up to ${DEPTH} steps and ${WALKS} seeded walks`, () => {
    expect(explain(check())).toBe('none')
  }, 900_000)
})
