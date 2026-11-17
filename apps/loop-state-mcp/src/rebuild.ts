import type { SlotState } from './store.js'

/**
 * Rebuild-from-GitHub (argus-config#668): the slots the world says exist, from the public
 * mirror (GitHub assignee and `needs:owner`) and the T3 thread list, set against the slots
 * the db holds. Pure: the store applies the plan, or only reports it in compare-only mode.
 * `~/.cache/backlog-loop/watch.txt` is never an input.
 */

/** A thread's state as `t3_thread_list` shows it. A thread missing from the list counts as gone. */
export const THREAD_STATES = ['running', 'idle', 'settled', 'archived'] as const
export type ThreadState = (typeof THREAD_STATES)[number]

/** One open issue from the calling thread's `gh search`: assigned to the loop, and/or labelled `needs:owner`. */
export interface IssueObservation {
  issue: string
  assigned: boolean
  needs_owner: boolean
  /** The worker thread named in the issue's claim line, if it has one. */
  claimed_by?: string
}

/** One thread from `t3_thread_list`, with the issue it works on when its title or branch names one. */
export interface ThreadObservation {
  thread_id: string
  state: ThreadState
  issue?: string
}

export interface World {
  issues: IssueObservation[]
  threads: ThreadObservation[]
}

export interface SlotView {
  state: SlotState
  thread_id: string
}

export interface RebuildChange {
  issue: string
  action: 'add' | 'update' | 'remove'
  from: SlotView | null
  to: SlotView | null
}

export interface RebuildPlan {
  changes: RebuildChange[]
  /** Assigned with no live worker and nothing parked or un-parked: the AFK loop restarts or unassigns it. */
  orphaned: { issue: string; reason: string }[]
  /** Assigned, but no claim line, T3 thread or slot ties it to a worker: not guessed, not seeded. */
  unresolved: { issue: string; reason: string }[]
  /** Running slots whose worker thread is idle: the AFK tick nudges these. */
  idle_workers: { issue: string; thread_id: string }[]
}

const isAlive = (state: ThreadState | undefined) => state === 'running' || state === 'idle'

export function planRebuild(current: (SlotView & { issue: string })[], world: World): RebuildPlan {
  const held = new Map(current.map((slot) => [slot.issue, slot]))
  const threads = new Map(world.threads.map((thread) => [thread.thread_id, thread]))
  const plan: RebuildPlan = { changes: [], orphaned: [], unresolved: [], idle_workers: [] }
  const seen = new Set<string>()

  /** The issue's worker: its claim line, then a T3 thread on it (live ones first), then the slot the db holds. */
  function workerOf(issue: IssueObservation): string | null {
    if (issue.claimed_by) return issue.claimed_by
    const linked = world.threads.filter((thread) => thread.issue === issue.issue)
    const thread = linked.find((candidate) => isAlive(candidate.state)) ?? linked[0]
    return thread?.thread_id ?? held.get(issue.issue)?.thread_id ?? null
  }

  function target(issue: IssueObservation): SlotView | null {
    const worker = workerOf(issue)
    if (worker === null) {
      plan.unresolved.push({ issue: issue.issue, reason: 'no worker thread is tied to it: no claim line, T3 thread or slot' })
      return null
    }
    if (issue.needs_owner) return { state: 'parked', thread_id: worker }

    const slot = held.get(issue.issue)
    if (slot?.state === 'awaiting_ci' && slot.thread_id === worker) {
      // argus-config#1169: an awaiting worker is idle by design. It stays awaiting while its thread lives,
      // and is not nudged; a gone worker falls through to orphaned.
      if (isAlive(threads.get(worker)?.state)) return { state: 'awaiting_ci', thread_id: worker }
    } else if (slot && slot.state !== 'running' && slot.thread_id === worker) {
      // The question was answered (needs:owner is gone): un-parked work waits for a free slot.
      return { state: 'ready', thread_id: worker }
    }

    const state = threads.get(worker)?.state
    if (!isAlive(state)) {
      plan.orphaned.push({ issue: issue.issue, reason: `worker thread ${worker} is ${state ?? 'not in the T3 thread list'}` })
      return null
    }
    if (state === 'idle') plan.idle_workers.push({ issue: issue.issue, thread_id: worker })
    return { state: 'running', thread_id: worker }
  }

  for (const issue of world.issues) {
    if (!issue.assigned || seen.has(issue.issue)) continue
    seen.add(issue.issue)
    const to = target(issue)
    const slot = held.get(issue.issue)
    const from = slot ? { state: slot.state, thread_id: slot.thread_id } : null
    if (!to) {
      if (from) plan.changes.push({ issue: issue.issue, action: 'remove', from, to: null })
    } else if (!from) {
      plan.changes.push({ issue: issue.issue, action: 'add', from: null, to })
    } else if (from.state !== to.state || from.thread_id !== to.thread_id) {
      plan.changes.push({ issue: issue.issue, action: 'update', from, to })
    }
  }

  // A slot whose issue is closed, or no longer assigned to the loop.
  for (const slot of current) {
    if (!seen.has(slot.issue)) {
      plan.changes.push({ issue: slot.issue, action: 'remove', from: { state: slot.state, thread_id: slot.thread_id }, to: null })
    }
  }
  return plan
}
