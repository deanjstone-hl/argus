import type { IssueObservation, ThreadObservation, ThreadState } from '../src/rebuild.js'

/**
 * In-memory stand-ins for GitHub and T3. A test describes the world through them ("issue X
 * assigned with needs:owner", "worker thread Y idle"), and the calling thread's view of it is
 * what `slot_rebuild` takes: the open issues from `gh search`, the threads from `t3_thread_list`.
 * Nothing here touches the network.
 */
export function fakeGitHub() {
  const issues = new Map<string, IssueObservation>()
  return {
    /** An open issue assigned to the loop, as a claim leaves it. */
    assign(issue: string, options: { needsOwner?: boolean; claimedBy?: string } = {}) {
      issues.set(issue, {
        issue,
        assigned: true,
        needs_owner: options.needsOwner ?? false,
        ...(options.claimedBy ? { claimed_by: options.claimedBy } : {}),
      })
    },
    /** An open issue nobody assigned, such as an owner-queue item outside the loop. */
    open(issue: string, options: { needsOwner?: boolean } = {}) {
      issues.set(issue, { issue, assigned: false, needs_owner: options.needsOwner ?? false })
    },
    label(issue: string, needsOwner: boolean) {
      const current = issues.get(issue)
      if (!current) throw new Error(`fake GitHub has no open ${issue}`)
      issues.set(issue, { ...current, needs_owner: needsOwner })
    },
    close(issue: string) {
      issues.delete(issue)
    },
    issues: (): IssueObservation[] => [...issues.values()],
  }
}

export function fakeT3() {
  const threads = new Map<string, ThreadObservation>()
  return {
    thread(threadId: string, state: ThreadState, issue?: string) {
      threads.set(threadId, { thread_id: threadId, state, ...(issue ? { issue } : {}) })
    },
    settle(threadId: string) {
      const current = threads.get(threadId)
      if (!current) throw new Error(`fake T3 has no thread ${threadId}`)
      threads.set(threadId, { ...current, state: 'settled' })
    },
    threads: (): ThreadObservation[] => [...threads.values()],
  }
}

/** The calling thread's observation of the world, as `slot_rebuild` takes it. */
export const observe = (github: ReturnType<typeof fakeGitHub>, t3: ReturnType<typeof fakeT3>) => ({
  issues: github.issues(),
  threads: t3.threads(),
})
