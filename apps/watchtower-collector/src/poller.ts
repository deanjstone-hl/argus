import { describeError } from './describe-error.js'
import { recordCheck } from './record-check.js'
import { CheckError, type Adapter, type HealthResult } from './adapter.js'

export async function recordResult(adapter: Adapter, result: HealthResult): Promise<void> {
  try {
    await recordCheck({
      service_key: adapter.key,
      host: adapter.host,
      status: result.status,
      detail: result.detail ?? null,
    })
  } catch (error) {
    console.error(`[poller] failed to record ${adapter.key}:`, describeError(error))
  }
}

export async function runCheck(adapter: Adapter): Promise<HealthResult> {
  try {
    return await adapter.check()
  } catch (error) {
    return {
      status: error instanceof CheckError ? error.status : (adapter.failureStatus ?? 'down'),
      detail: { error: error instanceof Error ? error.message : String(error) },
    }
  }
}

async function pollOnce(adapter: Adapter): Promise<void> {
  const result = await runCheck(adapter)
  console.log(`[poller] ${adapter.key} -> ${result.status}`)
  await recordResult(adapter, result)
}

// Adapters used to start together and, sharing 30s/60s/300s intervals, kept
// firing together: every fifth minute all of them ran at once, with a
// systemctl or ccusage child process behind many of them, and that burst was
// what the unit's cgroup peaked on. Each adapter now starts at its own offset
// in this window (the shortest default interval, so every card reports within
// 30s of a start) and keeps that phase, so the polls never realign.
export const FIRST_POLL_WINDOW_MS = 30_000

export function firstPollDelayMs(index: number, count: number, windowMs = FIRST_POLL_WINDOW_MS): number {
  return Math.floor((index * windowMs) / Math.max(count, 1))
}

export function startPolling(adapters: Adapter[], options: { windowMs?: number } = {}): () => void {
  const handles = adapters.map((adapter, index) => {
    const delay = firstPollDelayMs(index, adapters.length, options.windowMs)
    let interval: ReturnType<typeof setInterval> | undefined
    const start = setTimeout(() => {
      void pollOnce(adapter)
      interval = setInterval(() => void pollOnce(adapter), adapter.intervalMs)
    }, delay)
    return () => {
      clearTimeout(start)
      if (interval) clearInterval(interval)
    }
  })

  return () => {
    for (const stop of handles) stop()
  }
}
