// Pure verification logic for the Supabase -> D1 data migration (argus#252).
// Kept free of any network/DB code so it's unit-testable against fixtures.

export interface RowCountResult {
  ok: boolean;
  sourceCount: number;
  destCount: number;
}

export function verifyRowCounts(sourceCount: number, destCount: number): RowCountResult {
  return { ok: sourceCount === destCount, sourceCount, destCount };
}

export interface ServiceCheckRow {
  id: string;
  service_key: string;
  host: string;
  status: string;
  detail: unknown;
  checked_at: string;
}

export interface SpotCheckMismatch {
  id: string;
  field: keyof ServiceCheckRow;
  sourceValue: unknown;
  destValue: unknown;
}

export interface SpotCheckResult {
  ok: boolean;
  checked: number;
  mismatches: SpotCheckMismatch[];
}

const COMPARED_FIELDS: (keyof ServiceCheckRow)[] = ["service_key", "host", "status", "checked_at"];

// Compares a sample of rows keyed by id. Every id in `sourceSample` must be
// present in `destById` with matching values on COMPARED_FIELDS, or it's a
// mismatch. `detail` (JSON) is compared via JSON.stringify equality since
// key order isn't guaranteed to round-trip identically through D1.
export function spotCheck(sourceSample: ServiceCheckRow[], destById: Map<string, ServiceCheckRow>): SpotCheckResult {
  const mismatches: SpotCheckMismatch[] = [];

  for (const sourceRow of sourceSample) {
    const destRow = destById.get(sourceRow.id);
    if (!destRow) {
      mismatches.push({ id: sourceRow.id, field: "id", sourceValue: sourceRow.id, destValue: undefined });
      continue;
    }
    for (const field of COMPARED_FIELDS) {
      if (sourceRow[field] !== destRow[field]) {
        mismatches.push({ id: sourceRow.id, field, sourceValue: sourceRow[field], destValue: destRow[field] });
      }
    }
    const sourceDetail = JSON.stringify(sourceRow.detail ?? null);
    const destDetail = JSON.stringify(destRow.detail ?? null);
    if (sourceDetail !== destDetail) {
      mismatches.push({ id: sourceRow.id, field: "detail", sourceValue: sourceRow.detail, destValue: destRow.detail });
    }
  }

  return { ok: mismatches.length === 0, checked: sourceSample.length, mismatches };
}

// ---------------------------------------------------------------------------
// Verification pipeline
//
// The comparators above are pure, but the plumbing that feeds them — parsing
// `wrangler d1 execute --json` output, building the `IN (...)` clause, decoding
// D1's TEXT-encoded `detail` back into JSON — is exactly where a corrupted
// migration would be masked by a verifier that "passed" because it never saw
// the rows. So that plumbing lives here too, behind an injected query runner,
// and is exercised in test/migration-verification.test.ts against real
// (simulated) D1 with deliberately injected mismatches.
// ---------------------------------------------------------------------------

/** Escapes a value for inline SQL. Only used to build read-side `IN (...)` clauses. */
export function sqlLiteral(value: unknown): string {
  if (value === null || value === undefined) return "NULL";
  return `'${String(value).replace(/'/g, "''")}'`;
}

/**
 * Unwraps `wrangler d1 execute --remote --json`'s envelope:
 * `[{ results: [...], success: true, meta: {...} }]`.
 *
 * Strict on purpose — an unparseable or unexpected envelope throws rather than
 * degrading to "zero rows", which would otherwise read as a clean spot-check
 * over an empty sample.
 */
export function parseD1ExecuteJson(stdout: string): Record<string, unknown>[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch (err) {
    throw new Error(`d1 execute returned non-JSON output: ${(err as Error).message}`);
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error("d1 execute returned no statement results");
  }
  const results = (parsed[0] as { results?: unknown }).results;
  if (!Array.isArray(results)) {
    throw new Error("d1 execute result had no `results` array");
  }
  return results as Record<string, unknown>[];
}

/** Runs one read-only SQL statement and returns its rows. */
export type D1QueryRunner = (sql: string) => Promise<Record<string, unknown>[]>;

export interface VerifyMigrationDeps {
  query: D1QueryRunner;
}

export interface MigrationVerificationReport {
  ok: boolean;
  rowCount: RowCountResult;
  spotCheck: SpotCheckResult;
  /** Human-readable reason(s) the run failed. Empty iff `ok`. */
  failures: string[];
}

// `detail` is a nullable TEXT column holding JSON (it was jsonb in Postgres).
// A value that doesn't decode is a corrupted destination row, not `null` —
// returning null here would let it compare equal to a genuinely null source.
function decodeDetail(raw: unknown): { ok: true; value: unknown } | { ok: false } {
  if (raw === null || raw === undefined) return { ok: true, value: null };
  if (typeof raw !== "string") return { ok: true, value: raw };
  try {
    return { ok: true, value: JSON.parse(raw) };
  } catch {
    return { ok: false };
  }
}

/**
 * Fail-closed verification of a completed Supabase -> D1 migration.
 *
 * `sourceCount` is the *total* source row count (what parity is measured
 * against); `sourceSample` is the subset to compare field-by-field. Passing the
 * sample as the count would make parity trivially satisfiable.
 */
export async function verifyMigration(
  sourceCount: number,
  sourceSample: ServiceCheckRow[],
  deps: VerifyMigrationDeps
): Promise<MigrationVerificationReport> {
  const failures: string[] = [];

  const countRows = await deps.query("SELECT COUNT(*) as count FROM service_checks");
  const destCount = Number(countRows[0]?.count ?? Number.NaN);
  const rowCount = verifyRowCounts(sourceCount, destCount);
  if (!rowCount.ok) {
    failures.push(`row-count parity: source=${rowCount.sourceCount} dest=${rowCount.destCount}`);
  }

  // An empty sample would make spotCheck vacuously ok; that is a verifier
  // failure, not a pass.
  if (sourceSample.length === 0) {
    failures.push("spot-check sample was empty");
  }

  const idsClause = sourceSample.map((r) => sqlLiteral(r.id)).join(",");
  const destRaw = idsClause
    ? await deps.query(
        `SELECT id, service_key, host, status, detail, checked_at FROM service_checks WHERE id IN (${idsClause})`
      )
    : [];

  const destById = new Map<string, ServiceCheckRow>();
  for (const raw of destRaw) {
    const id = String(raw.id);
    const detail = decodeDetail(raw.detail);
    if (!detail.ok) {
      failures.push(`row ${id}: destination detail is not valid JSON (${JSON.stringify(raw.detail)})`);
      continue; // leave it absent so spotCheck also reports it as missing
    }
    destById.set(id, {
      id,
      service_key: raw.service_key as string,
      host: raw.host as string,
      status: raw.status as string,
      detail: detail.value,
      checked_at: raw.checked_at as string,
    });
  }

  const spot = spotCheck(sourceSample, destById);
  if (!spot.ok) {
    failures.push(`spot-check: ${spot.mismatches.length} mismatch(es) across ${spot.checked} row(s)`);
  }

  return { ok: failures.length === 0, rowCount, spotCheck: spot, failures };
}
