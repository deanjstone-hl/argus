import type { CheckInput } from '@argus/watchtower-contract'

import { resolveTargets } from './check-targets.js'
import { describeError } from './describe-error.js'
import type { CheckTarget, RecordOptions } from './post-check.js'

// Every target is written whatever the others do, so a hub that is down never
// costs a D1 write nor the other way round. A failure is reported once, naming
// the target(s) that failed.
export async function recordToTargets(targets: CheckTarget[], input: CheckInput, options: RecordOptions = {}): Promise<void> {
  const results = await Promise.allSettled(targets.map((target) => target.record(input, options)))
  const failures = results.flatMap((result, index) =>
    result.status === 'rejected' ? [`${targets[index]?.name}: ${describeError(result.reason)}`] : [],
  )
  if (failures.length > 0) throw new Error(failures.join('; '))
}

let targets: CheckTarget[] | undefined

// Resolved from the environment on first use, so a bad flag stops the collector
// at start (index.ts calls this) and the poller's tests need no env.
export function checkTargets(): CheckTarget[] {
  targets ??= resolveTargets(process.env)
  return targets
}

export function recordCheck(input: CheckInput, options: RecordOptions = {}): Promise<void> {
  return recordToTargets(checkTargets(), input, options)
}
