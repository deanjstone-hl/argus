import type { MemoryReconcileDetail, MemoryReconcileReport } from '@argus/watchtower-contract'
import { CheckError } from './adapter.js'

// The memory-reconcile card, from the heartbeat memory-mcp's reconciler
// writes after every run: the same file the session-start `Memory refusals:`
// line reads. A refusal is a write or deletion it will not settle on its
// own, so any refusal needs the owner and degrades the card.

// The timer fires every 20 minutes; three missed runs is not a slow one.
export const MEMORY_RECONCILE_STALE_MS = 3 * 20 * 60_000

export interface MemoryReconcileResult {
  status: 'healthy' | 'degraded' | 'down'
  detail: MemoryReconcileDetail
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const textOrNull = (value: unknown) => (typeof value === 'string' && value !== '' ? value : null)
const numberOrNull = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : null)

export function evaluateMemoryReconcile(report: MemoryReconcileReport, now: number): MemoryReconcileResult {
  if (report.error !== null) throw new CheckError('degraded', `heartbeat ${report.path} unreadable: ${report.error}`)
  if (report.heartbeat === null) throw new CheckError('degraded', `no heartbeat at ${report.path}: memory-reconcile has not run on this machine`)
  const heartbeat = report.heartbeat
  const lastRunAt = isRecord(heartbeat) ? textOrNull(heartbeat.lastRunAt) : null
  if (!isRecord(heartbeat) || lastRunAt === null || Number.isNaN(Date.parse(lastRunAt))) {
    throw new CheckError('degraded', `heartbeat ${report.path} has no lastRunAt`)
  }

  const refusals = (Array.isArray(heartbeat.refusals) ? heartbeat.refusals : []).filter(isRecord).map((refusal) => ({
    key: textOrNull(refusal.key) ?? 'unknown',
    reason: textOrNull(refusal.reason) ?? 'unknown',
    seenAt: textOrNull(refusal.seenAt),
  }))
  const ok = typeof heartbeat.ok === 'boolean' ? heartbeat.ok : null
  const detail: MemoryReconcileDetail = {
    path: report.path,
    lastRunAt,
    ok,
    lastError: textOrNull(heartbeat.error),
    written: numberOrNull(heartbeat.written),
    deleted: numberOrNull(heartbeat.deleted),
    refusals,
    staleAfterMs: MEMORY_RECONCILE_STALE_MS,
  }

  const stale = now - Date.parse(lastRunAt) > MEMORY_RECONCILE_STALE_MS
  const status = ok === false ? 'down' : stale || refusals.length > 0 ? 'degraded' : 'healthy'
  return { status, detail }
}
