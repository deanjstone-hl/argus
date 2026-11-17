import { createExecutionContext, createScheduledController, env, waitOnExecutionContext } from 'cloudflare:test'
import { beforeEach, describe, expect, it } from 'vitest'
import worker, { pruneServiceChecks, RETENTION_DAYS } from '../src/worker/index'

const NOW = new Date('2026-10-16T12:00:00.000Z')
const DAY_MS = 24 * 60 * 60 * 1000

function isoDaysBefore(days: number): string {
  return new Date(NOW.getTime() - days * DAY_MS).toISOString()
}

async function insertHistory(id: string, checkedAt: string): Promise<void> {
  await env.DB.prepare(
    'INSERT INTO service_checks (id, service_key, host, status, detail, checked_at) VALUES (?, ?, ?, ?, NULL, ?)',
  )
    .bind(id, 'systemd:paperless', 'homelab', 'healthy', checkedAt)
    .run()
}

async function remainingIds(): Promise<string[]> {
  const { results } = await env.DB.prepare('SELECT id FROM service_checks ORDER BY id').all<{ id: string }>()
  return results.map((row) => row.id)
}

beforeEach(async () => {
  await env.DB.exec('DELETE FROM service_checks')
  await env.DB.exec('DELETE FROM service_checks_latest')
})

describe('pruneServiceChecks', () => {
  it('keeps two days of history', () => {
    expect(RETENTION_DAYS).toBe(2)
  })

  it('deletes history older than the retention window and keeps newer rows', async () => {
    await insertHistory('old', isoDaysBefore(RETENTION_DAYS + 1))
    await insertHistory('edge', isoDaysBefore(RETENTION_DAYS - 0.01))
    await insertHistory('new', isoDaysBefore(1))

    const deleted = await pruneServiceChecks(env.DB, NOW)

    expect(deleted).toBe(1)
    expect(await remainingIds()).toEqual(['edge', 'new'])
  })

  // Rows migrated from Supabase carry a "+00:00" offset rather than "Z"; the
  // cutoff comparison is lexical, so both formats must sort correctly.
  it('prunes Supabase-era "+00:00" timestamps as well as Worker "Z" ones', async () => {
    await insertHistory('supabase-old', '2026-07-10T22:44:03.665798+00:00')
    await insertHistory('worker-new', isoDaysBefore(1))

    await pruneServiceChecks(env.DB, NOW)

    expect(await remainingIds()).toEqual(['worker-new'])
  })

  it('deletes in bounded batches and stops at the per-run cap', async () => {
    for (let i = 0; i < 7; i++) {
      await insertHistory(`old-${i}`, isoDaysBefore(30 + i))
    }

    const deleted = await pruneServiceChecks(env.DB, NOW, { batchSize: 2, maxBatches: 2 })

    expect(deleted).toBe(4)
    expect(await remainingIds()).toHaveLength(3)

    const rest = await pruneServiceChecks(env.DB, NOW, { batchSize: 2, maxBatches: 10 })
    expect(rest).toBe(3)
    expect(await remainingIds()).toEqual([])
  })

  // A service that stopped reporting still shows its last state on the
  // dashboard, as it did before retention existed.
  it('never prunes service_checks_latest', async () => {
    await insertHistory('old', isoDaysBefore(60))
    await env.DB.prepare(
      'INSERT INTO service_checks_latest (service_key, host, status, detail, checked_at) VALUES (?, ?, ?, NULL, ?)',
    )
      .bind('systemd:paperless', 'homelab', 'down', isoDaysBefore(60))
      .run()

    await pruneServiceChecks(env.DB, NOW)

    const latest = await env.DB.prepare('SELECT COUNT(*) AS n FROM service_checks_latest').first<{ n: number }>()
    expect(latest?.n).toBe(1)
    expect(await remainingIds()).toEqual([])
  })
})

describe('scheduled handler', () => {
  it('prunes expired history on the cron trigger', async () => {
    await insertHistory('old', new Date(Date.now() - (RETENTION_DAYS + 1) * DAY_MS).toISOString())
    await insertHistory('new', new Date().toISOString())

    const ctx = createExecutionContext()
    await worker.scheduled(createScheduledController({ cron: '17 * * * *' }), env as unknown as Env, ctx)
    await waitOnExecutionContext(ctx)

    expect(await remainingIds()).toEqual(['new'])
  })
})
