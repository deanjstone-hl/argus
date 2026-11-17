// The negative test for the Supabase -> D1 migration's verifier (argus#252's
// Testing Decisions: "tested against a small fixture dataset with deliberately
// injected mismatches, confirming row-count and spot-check verification
// actually fails closed rather than only being exercised on already-correct
// data").
//
// Each case migrates the same fixture into real (simulated) D1, corrupts the
// destination in exactly one way, and asserts the verifier reports it. The one
// clean-run case exists to show the corruptions are what's being detected,
// rather than a verifier that fails on everything.
import { env } from 'cloudflare:workers'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  parseD1ExecuteJson,
  verifyMigration,
  type ServiceCheckRow,
  type VerifyMigrationDeps,
} from '../scripts/verify.js'

const FIXTURE: ServiceCheckRow[] = [
  {
    id: '00000000-0000-4000-8000-000000000007',
    service_key: 'syncthing',
    host: 'homelab',
    status: 'healthy',
    detail: { peers: 4, folders: ['CONTEXT', 'CORTEX'] },
    checked_at: '2026-08-01T10:00:00.000Z',
  },
  {
    id: '00000000-0000-4000-8000-000000000020',
    service_key: 'disk',
    host: 'homelab',
    status: 'degraded',
    detail: { used_pct: 91, note: "root is filling — don't ignore" },
    checked_at: '2026-08-01T10:00:18.000Z',
  },
  {
    id: '00000000-0000-4000-8000-000000000021',
    service_key: 'uptime',
    host: 'lnv-lgn5',
    status: 'down',
    detail: null,
    checked_at: '2026-08-01T10:00:36.000Z',
  },
  {
    id: '00000000-0000-4000-8000-000000000022',
    service_key: 'cloudflare',
    host: 'edge',
    status: 'unreachable',
    detail: { error: 'timeout après 30s — ünïcödé' },
    checked_at: '2026-08-01T10:00:54.000Z',
  },
]

/** Writes the fixture into D1 the way migrate-to-d1.ts does. */
async function migrateFixture(rows: ServiceCheckRow[] = FIXTURE): Promise<void> {
  for (const r of rows) {
    await env.DB.prepare(
      'INSERT OR REPLACE INTO service_checks (id, service_key, host, status, detail, checked_at) VALUES (?, ?, ?, ?, ?, ?)',
    )
      .bind(r.id, r.service_key, r.host, r.status, r.detail ? JSON.stringify(r.detail) : null, r.checked_at)
      .run()
  }
}

const deps: VerifyMigrationDeps = {
  query: async (sql) => {
    const { results } = await env.DB.prepare(sql).all()
    return results as Record<string, unknown>[]
  },
}

describe('verifyMigration — fixture dataset', () => {
  beforeEach(async () => {
    await env.DB.exec('DELETE FROM service_checks')
  })

  it('passes on a clean migration', async () => {
    await migrateFixture()

    const report = await verifyMigration(FIXTURE.length, FIXTURE, deps)

    expect(report.failures).toEqual([])
    expect(report.ok).toBe(true)
    expect(report.rowCount).toEqual({ ok: true, sourceCount: 4, destCount: 4 })
    expect(report.spotCheck.mismatches).toEqual([])
  })

  it('MISMATCH: a dropped row fails row-count parity and is named by the spot check', async () => {
    await migrateFixture(FIXTURE.filter((r) => r.id !== FIXTURE[1]!.id))

    const report = await verifyMigration(FIXTURE.length, FIXTURE, deps)

    expect(report.ok).toBe(false)
    expect(report.rowCount).toEqual({ ok: false, sourceCount: 4, destCount: 3 })
    expect(report.spotCheck.mismatches).toEqual([
      { id: FIXTURE[1]!.id, field: 'id', sourceValue: FIXTURE[1]!.id, destValue: undefined },
    ])
    expect(report.failures).toEqual([
      'row-count parity: source=4 dest=3',
      'spot-check: 1 mismatch(es) across 4 row(s)',
    ])
  })

  it('MISMATCH: a mistranslated status fails the spot check while row counts still agree', async () => {
    await migrateFixture()
    await env.DB.prepare('UPDATE service_checks SET status = ? WHERE id = ?')
      .bind('healthy', FIXTURE[1]!.id)
      .run()

    const report = await verifyMigration(FIXTURE.length, FIXTURE, deps)

    expect(report.rowCount.ok).toBe(true) // the trap a count-only verifier falls into
    expect(report.ok).toBe(false)
    expect(report.spotCheck.mismatches).toEqual([
      { id: FIXTURE[1]!.id, field: 'status', sourceValue: 'degraded', destValue: 'healthy' },
    ])
  })

  it('MISMATCH: a shifted timestamp is caught', async () => {
    await migrateFixture()
    await env.DB.prepare('UPDATE service_checks SET checked_at = ? WHERE id = ?')
      .bind('2026-08-01T11:00:00.000Z', FIXTURE[0]!.id)
      .run()

    const report = await verifyMigration(FIXTURE.length, FIXTURE, deps)

    expect(report.ok).toBe(false)
    expect(report.spotCheck.mismatches.map((m) => m.field)).toEqual(['checked_at'])
  })

  it('MISMATCH: a `detail` payload that lost a field is caught', async () => {
    await migrateFixture()
    await env.DB.prepare('UPDATE service_checks SET detail = ? WHERE id = ?')
      .bind(JSON.stringify({ peers: 4 }), FIXTURE[0]!.id)
      .run()

    const report = await verifyMigration(FIXTURE.length, FIXTURE, deps)

    expect(report.ok).toBe(false)
    expect(report.spotCheck.mismatches.map((m) => m.field)).toEqual(['detail'])
  })

  it('MISMATCH: `detail` stored as an unparseable string fails closed, not as null', async () => {
    await migrateFixture()
    // The shape a naive port produces: the jsonb value stringified by the
    // driver rather than re-encoded as JSON.
    await env.DB.prepare('UPDATE service_checks SET detail = ? WHERE id = ?')
      .bind('[object Object]', FIXTURE[3]!.id)
      .run()

    const report = await verifyMigration(FIXTURE.length, FIXTURE, deps)

    expect(report.ok).toBe(false)
    expect(report.failures[0]).toContain('destination detail is not valid JSON')
  })

  it('a null `detail` round-trips as null, not as a mismatch', async () => {
    await migrateFixture()

    const report = await verifyMigration(FIXTURE.length, [FIXTURE[2]!], deps)

    expect(report.spotCheck.mismatches).toEqual([])
    expect(report.rowCount.ok).toBe(true)
  })

  it('MISMATCH: an empty spot-check sample is a verifier failure, not a vacuous pass', async () => {
    const report = await verifyMigration(0, [], deps)

    expect(report.ok).toBe(false)
    expect(report.rowCount.ok).toBe(true) // 0 === 0
    expect(report.failures).toEqual(['spot-check sample was empty'])
  })
})

describe('parseD1ExecuteJson', () => {
  it("unwraps wrangler's statement-results envelope", () => {
    const stdout = JSON.stringify([{ results: [{ count: 220_006 }], success: true, meta: {} }])
    expect(parseD1ExecuteJson(stdout)).toEqual([{ count: 220_006 }])
  })

  it('throws rather than reporting zero rows when wrangler printed something else', () => {
    expect(() => parseD1ExecuteJson('✘ [ERROR] no such table: service_checks')).toThrow(/non-JSON output/)
    expect(() => parseD1ExecuteJson('[]')).toThrow(/no statement results/)
    expect(() => parseD1ExecuteJson(JSON.stringify([{ success: false }]))).toThrow(/no `results` array/)
  })
})
