import { describe, expect, it } from 'vitest'

import { openStore, Refused, type SlotState, type Store } from '../src/store.js'

import { AFK_THREAD, AQUILA_THREAD, testClock } from './helpers.js'

/**
 * A bounded model check of the slot lifecycle, run against the real store on a real SQLite db. The model keeps its
 * own copy of every slot's state and says, from the README's diagram and cap rules, what each operation must do.
 * Every reachable slot state up to DEPTH operations from an empty db is visited, then a long seeded walk. After each
 * operation the store's answer and its reports must match the model, and the cap properties must hold.
 * `verify-loop-state-slots` in `.claude/skills/` says how to read a failure.
 */

const TOTAL_CAP = 2
const HOST_CAPS = { wsl2: 1, homelab: 2 } as const
const AWAITING_CAP = 3
type Host = keyof typeof HOST_CAPS

interface Issue {
  /** The name a trace uses. */
  name: string
  issue: string
  host: Host
  /** Started with `budget_exempt` (an efficiency:orchestrator issue). */
  flagged: boolean
  /** In the directives' `budget_exempt_issues`. */
  listed: boolean
}

const capped = (name: string, number: number, host: Host): Issue => ({ name, issue: `o/work#${number}`, host, flagged: false, listed: false })
/** Two capped issues per host, two listed and two flagged: enough for every cap and every one-at-a-time rule to bind. */
const ISSUES: readonly Issue[] = [
  capped('wsl2-a', 1, 'wsl2'),
  capped('wsl2-b', 2, 'wsl2'),
  capped('homelab-a', 3, 'homelab'),
  capped('homelab-b', 4, 'homelab'),
  { name: 'listed-a', issue: 'o/listed#10', host: 'wsl2', flagged: false, listed: true },
  { name: 'listed-b', issue: 'o/listed#11', host: 'homelab', flagged: false, listed: true },
  { name: 'flagged-a', issue: 'o/flagged#20', host: 'wsl2', flagged: true, listed: false },
  { name: 'flagged-b', issue: 'o/flagged#21', host: 'wsl2', flagged: true, listed: false },
]

const OPS = ['start', 'prompt', 'park', 'unpark', 'await_ci', 'resume_ci', 'resume_report_only', 'close', 'free'] as const
type Op = (typeof OPS)[number]

interface Action {
  op: Op
  issue: Issue
}

const ACTIONS: readonly Action[] = ISSUES.flatMap((issue) => OPS.map((op) => ({ op, issue })))
const say = (action: Action) => `${action.op} ${action.issue.name}`

/**
 * What the model holds for a slot.
 * - `reportOnly`: resumed past the caps to post its Resolution (argus/37).
 * - `prompted`: its worker waits on a tool-approval prompt, and the tick has reported that (`pending_approvals`).
 * - `held`: parked while prompted. The worker is still resident and resumes the moment the owner answers, so the
 *   slot keeps its place under the caps until it runs again or is freed (argus-config#1688).
 */
interface ModelSlot {
  state: SlotState
  reportOnly: boolean
  prompted: boolean
  held: boolean
}
type Model = Map<Issue, ModelSlot>

const runningIn = (model: Model) => [...model].filter(([, slot]) => slot.state === 'running').map(([issue]) => issue)
/** The slots holding a place under the caps: the running ones, and the ones parked on an approval prompt. */
const placedIn = (model: Model) => [...model].filter(([, slot]) => slot.state === 'running' || slot.held).map(([issue]) => issue)
const isCapped = (issue: Issue) => !issue.flagged && !issue.listed

/** Whether the caps leave running room for `issue`, counting every slot that holds a place as the README says. */
function hasRoom(model: Model, issue: Issue): boolean {
  const running = placedIn(model).filter((other) => other !== issue)
  // argus#87: flagged and listed issues share one running place, so either kind waits for the other.
  if (!isCapped(issue)) return !running.some((other) => !isCapped(other))
  const cappedRunning = running.filter(isCapped)
  return cappedRunning.length < TOTAL_CAP && cappedRunning.filter((other) => other.host === issue.host).length < HOST_CAPS[issue.host]
}

/** What the README says `action` does to the model: the slot's next state (null: gone), or `refused`. */
function expected(model: Model, { op, issue }: Action): ModelSlot | null | 'refused' | 'unchanged' {
  const slot = model.get(issue)
  const state = slot?.state
  const plain = { reportOnly: false, prompted: false, held: false }
  const running: ModelSlot = { state: 'running', ...plain }
  switch (op) {
    case 'start':
      // A held slot never gave up its place, so the same worker goes back to running without a cap check.
      if (state === 'ready' && slot?.held) return running
      return (state === undefined || state === 'ready') && hasRoom(model, issue) ? running : 'refused'
    case 'prompt':
      return slot !== undefined && state === 'running' ? { ...slot, prompted: true } : 'unchanged'
    case 'park':
      return slot !== undefined && state === 'running' ? { state: 'parked', ...plain, held: slot.prompted } : 'refused'
    case 'unpark':
      return slot !== undefined && state === 'parked' ? { state: 'ready', ...plain, held: slot.held } : 'refused'
    case 'await_ci': {
      const awaiting = [...model.values()].filter((other) => other.state === 'awaiting_ci').length
      return state === 'running' && awaiting < AWAITING_CAP ? { state: 'awaiting_ci', ...plain } : 'refused'
    }
    case 'resume_ci':
      if (state !== 'awaiting_ci') return 'refused'
      return hasRoom(model, issue) ? running : { state: 'ready', ...plain }
    case 'resume_report_only':
      return state === 'awaiting_ci' ? { state: 'running', ...plain, reportOnly: true } : 'refused'
    case 'close':
      return state === 'running' || state === 'ready' ? null : 'refused'
    case 'free':
      return state === undefined ? 'refused' : null
  }
}

const AFK = { caller_thread_id: AFK_THREAD }
const TICK = { thread_id: AFK_THREAD, directives_version: 'v1', needs_owner: [] as string[], total_cap: TOTAL_CAP, host_caps: { ...HOST_CAPS } }
const WORKER = (issue: Issue) => `worker-${issue.name}`

function perform(store: Store, { op, issue }: Action): void {
  switch (op) {
    case 'start':
      store.slotStart('afk', issue.issue, WORKER(issue), issue.host, AFK_THREAD, issue.flagged)
      return
    case 'prompt':
      store.statusTick('afk', { ...TICK, pending_approvals: { [issue.issue]: 1 } })
      return
    case 'park':
      store.slotPark('afk', issue.issue, 'question on the issue', AFK)
      return
    case 'unpark':
      store.slotUnpark('direction', issue.issue, 'answered')
      return
    case 'await_ci':
      store.slotAwaitCi('worker', { issue: issue.issue, thread_id: WORKER(issue), ref: 'https://github.com/o/work/pull/1' })
      return
    case 'resume_ci':
      store.slotResumeCi('direction', issue.issue, 'checks red')
      return
    case 'resume_report_only':
      store.slotResumeCi('direction', issue.issue, 'checks green', true)
      return
    case 'close':
      store.slotClose('afk', issue.issue, 'Verified: model', AFK)
      return
    case 'free':
      store.slotFree('afk', issue.issue, 'model', AFK)
      return
  }
}

function accepted(work: () => void): boolean {
  try {
    work()
    return true
  } catch (error) {
    if (error instanceof Refused) return false
    throw error
  }
}

function boot(): Store {
  const clock = testClock()
  const store = openStore({ path: ':memory:', now: clock.now, warn: () => {} })
  store.leaseMove('direction', { role: 'afk', to_thread_id: AFK_THREAD })
  store.leaseMove('direction', { role: 'direction', to_thread_id: AQUILA_THREAD })
  store.ownerTurn('direction', { caller_thread_id: AQUILA_THREAD })
  store.directivesSet('direction', {
    record: {
      cadence_minutes: 30,
      max_slots: TOTAL_CAP,
      repo_holds: [],
      take_next: [],
      ordering: [],
      awaiting_ci_cap: AWAITING_CAP,
      budget_exempt_issues: ISSUES.filter((issue) => issue.listed).map((issue) => issue.issue),
    },
    reason: 'slot model',
    expected_version: 0,
    caller_thread_id: AQUILA_THREAD,
  })
  store.statusTick('afk', TICK)
  return store
}

/** Applies one action to the store and the model. Returns the first broken property, or null. */
function step(store: Store, model: Model, action: Action): string | null {
  const want = expected(model, action)
  const took = accepted(() => perform(store, action))
  if (took !== (want !== 'refused')) {
    return want === 'refused' ? `${say(action)} is refused by the slot diagram and the caps, but the store accepted it` : `${say(action)} is allowed by the slot diagram and the caps, but the store refused it`
  }
  if (want === null) model.delete(action.issue)
  else if (want !== 'refused' && want !== 'unchanged') model.set(action.issue, want)

  const shown = new Map(store.slotList('afk').map((slot) => [slot.issue, slot]))
  for (const issue of ISSUES) {
    const state = model.get(issue)?.state
    if (shown.get(issue.issue)?.state !== state) {
      return `after ${say(action)}, ${issue.name} is ${shown.get(issue.issue)?.state ?? 'gone'} in slot_list but ${state ?? 'gone'} by the slot diagram`
    }
    if (state !== undefined && shown.get(issue.issue)?.budget_exempt !== (issue.flagged || issue.listed)) {
      return `slot_list shows budget_exempt ${String(shown.get(issue.issue)?.budget_exempt)} for ${issue.name}, a ${issue.listed ? 'listed' : issue.flagged ? 'flagged' : 'capped'} issue`
    }
  }

  const running = runningIn(model)
  const placed = placedIn(model)
  // The workers resident on a host: the ones running work, and the ones waiting on an approval prompt.
  const working = placed.filter((issue) => model.get(issue)?.reportOnly !== true)
  const cappedWorking = working.filter(isCapped)
  if (cappedWorking.length > TOTAL_CAP) return `${cappedWorking.length} capped workers are resident, past the total cap ${TOTAL_CAP}`
  for (const host of Object.keys(HOST_CAPS) as Host[]) {
    const here = cappedWorking.filter((issue) => issue.host === host).length
    if (here > HOST_CAPS[host]) return `${here} capped workers are resident on ${host}, past its cap ${HOST_CAPS[host]}`
  }
  if (working.filter((issue) => !isCapped(issue)).length > 1) return 'two budget-exempt slots (flagged or listed) run work at once'

  const { slots } = store.statusRead('afk')
  const count = (state: SlotState) => [...model.values()].filter((slot) => slot.state === state).length
  if (slots.used !== placed.length) {
    return `status_read counts ${slots.used} slots used, the slot diagram ${placed.length}: a running slot and a slot parked on an approval prompt hold a place, nothing else does`
  }
  const held = [...model.values()].filter((slot) => slot.held).length
  if (slots.holding !== held) return `status_read counts ${slots.holding} parked or ready slots holding their place, the slot diagram ${held}`
  if (slots.parked !== count('parked') || slots.ready !== count('ready') || slots.awaiting_ci !== count('awaiting_ci')) {
    return 'status_read parked, ready and awaiting_ci counts differ from the slot diagram'
  }
  const exemptRunning = placed.filter((issue) => issue.flagged || issue.listed).length
  if (slots.budget_exempt_running !== exemptRunning) {
    return `status_read budget_exempt_running is ${slots.budget_exempt_running}, but ${exemptRunning} budget-exempt slots hold a place: the tick would launch a worker that slot_start refuses`
  }
  return null
}

interface Violation {
  property: string
  trace: string[]
}

const explain = (violation: Violation | null) => (violation === null ? 'none' : `${violation.property}\n  ${violation.trace.join('\n  ')}`)

/** Plays one sequence from an empty db. */
function play(actions: readonly Action[]): Violation | null {
  const store = boot()
  const model: Model = new Map()
  const trace: string[] = []
  try {
    for (const action of actions) {
      trace.push(say(action))
      const broken = step(store, model, action)
      if (broken !== null) return { property: broken, trace }
    }
    return null
  } finally {
    store.close()
  }
}

const signature = (model: Model) =>
  ISSUES.map((issue) => {
    const slot = model.get(issue)
    return `${slot?.state ?? '-'}${slot?.reportOnly ? '!' : ''}${slot?.prompted ? '?' : ''}${slot?.held ? '+' : ''}`
  }).join(',')

/**
 * Breadth-first over the slot states reachable within `depth` operations. One store serves the whole search: to
 * stand in a state it frees every slot and replays the shortest path there, so a state is visited once, and every
 * action is tried from it, refused ones included.
 */
function search(depth: number): { violation: Violation | null; states: number } {
  const store = boot()
  const paths = new Map<string, Action[]>([[signature(new Map()), []]])
  let frontier: Action[][] = [[]]
  const goTo = (path: readonly Action[]): Model | Violation => {
    for (const slot of store.slotList('afk')) store.slotFree('afk', slot.issue, 'model reset', AFK)
    const model: Model = new Map()
    for (const [index, action] of path.entries()) {
      const broken = step(store, model, action)
      if (broken !== null) return { property: broken, trace: path.slice(0, index + 1).map(say) }
    }
    return model
  }
  try {
    for (let level = 0; level < depth; level += 1) {
      const next: Action[][] = []
      for (const path of frontier) {
        // An action that changed no slot left the store standing in the same state, so the next one needs no replay.
        let standing: Model | null = null
        for (const action of ACTIONS) {
          const model: Model | Violation = standing ?? goTo(path)
          if (!(model instanceof Map)) return { violation: model, states: paths.size }
          const before = signature(model)
          const broken = step(store, model, action)
          if (broken !== null) return { violation: { property: broken, trace: [...path, action].map(say) }, states: paths.size }
          const after = signature(model)
          standing = after === before ? model : null
          if (after !== before && !paths.has(after)) {
            paths.set(after, [...path, action])
            next.push([...path, action])
          }
        }
      }
      frontier = next
    }
    return { violation: null, states: paths.size }
  } finally {
    store.close()
  }
}

/** One long seeded walk on one store: it reaches the deep states the bounded search does not. */
function walk(seed: number, length: number): Violation | null {
  let state = seed >>> 0
  const next = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    return state
  }
  const store = boot()
  const model: Model = new Map()
  const trace: string[] = []
  try {
    for (let index = 0; index < length; index += 1) {
      const action = ACTIONS[(next() >>> 8) % ACTIONS.length] as Action
      const before = signature(model)
      const broken = step(store, model, action)
      if (signature(model) !== before || broken !== null) trace.push(say(action))
      if (broken !== null) return { property: broken, trace: [`(seed ${seed}: the last operations that changed a slot)`, ...trace.slice(-12)] }
    }
    return null
  } finally {
    store.close()
  }
}

const DEPTH = Number(process.env['SLOT_MODEL_DEPTH'] ?? 4)
const WALK_STEPS = Number(process.env['SLOT_MODEL_WALK_STEPS'] ?? 20_000)

const issueNamed = (name: string) => ISSUES.find((issue) => issue.name === name) as Issue
const act = (op: Op, name: string): Action => ({ op, issue: issueNamed(name) })

describe('slot lifecycle model', () => {
  it('replays argus#77: a running budget_exempt_issues slot is budget-exempt in slot_list and status_read', () => {
    expect(explain(play([act('start', 'listed-a'), act('start', 'listed-b')]))).toBe('none')
  })

  it('replays argus#1197: a slot that went ready from awaiting_ci closes without a start', () => {
    const sequence = [act('start', 'wsl2-a'), act('await_ci', 'wsl2-a'), act('start', 'wsl2-b'), act('resume_ci', 'wsl2-a'), act('close', 'wsl2-a')]
    expect(explain(play(sequence))).toBe('none')
  })

  it('replays argus/37: a green report-only resume runs past a full cap, and a red one waits ready', () => {
    const fill = [act('start', 'homelab-a'), act('await_ci', 'homelab-a'), act('start', 'wsl2-a'), act('start', 'homelab-b')]
    expect(explain(play([...fill, act('resume_report_only', 'homelab-a'), act('start', 'wsl2-b')]))).toBe('none')
    expect(explain(play([...fill, act('resume_ci', 'homelab-a'), act('start', 'homelab-a')]))).toBe('none')
  })

  it('replays argus-config#1688: a slot parked on an approval prompt keeps its place, so no start overcommits the host', () => {
    const parkedOnPrompt = [act('start', 'wsl2-a'), act('prompt', 'wsl2-a'), act('park', 'wsl2-a')]
    // wsl2 has one place and its worker still sits on the prompt: a second wsl2 start must be refused.
    expect(explain(play([...parkedOnPrompt, act('start', 'wsl2-b')]))).toBe('none')
    // The owner answers, Aquila un-parks, and the same worker runs again without waiting for a free slot.
    expect(explain(play([...parkedOnPrompt, act('start', 'homelab-a'), act('unpark', 'wsl2-a'), act('start', 'wsl2-a'), act('start', 'homelab-b')]))).toBe('none')
    // A slot parked on a question, its worker's turn over, gives its place up as before.
    expect(explain(play([act('start', 'wsl2-a'), act('park', 'wsl2-a'), act('start', 'wsl2-b')]))).toBe('none')
  })

  it(`holds every property in every slot state within ${DEPTH} operations of an empty db`, () => {
    const { violation, states } = search(DEPTH)
    expect(explain(violation)).toBe('none')
    expect(states).toBeGreaterThan(100)
  }, 900_000)

  it(`holds every property along a seeded walk of ${WALK_STEPS} operations`, () => {
    expect(explain(walk(1, WALK_STEPS))).toBe('none')
  }, 900_000)
})
