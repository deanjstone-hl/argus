#!/usr/bin/env -S npx tsx
// One-shot migration: Supabase `service_checks` (myargus project) -> the real
// D1 database provisioned for argus-watchtower-api (argus#252 live-provisioning
// phase). Full historical backfill, no windowing — see spec argus#252's Data
// Migration section. Safe to re-run: inserts are `INSERT OR REPLACE` keyed by
// the source row's own id, so a partial prior run is resumed, not duplicated.
//
// Writes go through the `wrangler d1 execute --remote` CLI (this machine's
// already-authenticated wrangler OAuth session) rather than the D1 REST API
// directly — the account's available Cloudflare API tokens are scoped for
// Pages/Workers deploy only, not D1 query access, so the CLI path is what's
// actually usable here without minting a new token.
//
// Required env:
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY   (myargus project, read-only use)
//   D1_DATABASE_NAME                          (argus-watchtower)
//   WRANGLER_CONFIG_PATH                      (a wrangler config whose
//     d1_databases entry has the *real* database_id — see this phase's plan
//     doc for why the tracked wrangler.jsonc's own ID is used here directly
//     instead, once merged)

import { createClient } from "@supabase/supabase-js";
import { execFile } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { parseD1ExecuteJson, verifyMigration, type ServiceCheckRow } from "./verify.js";

const execFileAsync = promisify(execFile);

const SUPABASE_URL = requireEnv("SUPABASE_URL");
const SUPABASE_SERVICE_ROLE_KEY = requireEnv("SUPABASE_SERVICE_ROLE_KEY");
const D1_DATABASE_NAME = requireEnv("D1_DATABASE_NAME");
const WRANGLER_CONFIG_PATH = requireEnv("WRANGLER_CONFIG_PATH");

// PostgREST caps .range() results at this project's configured max rows
// (1000, the Supabase default) regardless of the range requested — a larger
// value here would silently truncate to 1000 and make the "short page = last
// page" pagination check below falsely stop after page 1. Verified the hard
// way: an earlier run of this script against the real 220,006-row table
// reported a clean 1000/1000 row-count match, because both sides were
// truncated to the same wrong number.
const READ_PAGE_SIZE = 1_000;
const ROWS_PER_STATEMENT = 100; // D1 rejects a single INSERT much bigger than this ("statement too long")
const STATEMENTS_PER_FILE = 20; // rows per generated SQL file / wrangler invocation = this * ROWS_PER_STATEMENT
const SPOT_CHECK_SAMPLE_SIZE = 25;

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

async function d1Execute(sqlOrFile: { command: string } | { file: string }): Promise<string> {
  const args = ["wrangler", "d1", "execute", D1_DATABASE_NAME, "--remote", "--json", "-c", WRANGLER_CONFIG_PATH];
  if ("command" in sqlOrFile) args.push("--command", sqlOrFile.command);
  else args.push("--file", sqlOrFile.file);
  const { stdout } = await execFileAsync("npx", args, { maxBuffer: 1024 * 1024 * 64 });
  return stdout;
}

function sqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function sqlValue(value: unknown): string {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "string") return sqlString(value);
  return sqlString(String(value));
}

interface SupabaseServiceCheckRow {
  id: string;
  service_key: string;
  host: string;
  status: string;
  detail: unknown;
  checked_at: string;
}

async function readAllFromSupabase(): Promise<SupabaseServiceCheckRow[]> {
  const all: SupabaseServiceCheckRow[] = [];
  let from = 0;
  for (;;) {
    const { data, error } = await supabase
      .from("service_checks")
      .select("id, service_key, host, status, detail, checked_at")
      // Secondary sort on `id` (unique) is required, not cosmetic: checked_at
      // isn't unique (many checks land in the same millisecond), and without
      // a deterministic tiebreaker, .range() pagination can non-deterministically
      // split/drop rows whose checked_at value straddles a page boundary.
      // Verified the hard way — an earlier run with checked_at-only ordering
      // migrated 220,004 of 220,006 real rows and only the row-count check
      // caught the gap.
      .order("checked_at", { ascending: true })
      .order("id", { ascending: true })
      .range(from, from + READ_PAGE_SIZE - 1);
    if (error) throw new Error(`Supabase read failed at offset ${from}: ${error.message}`);
    if (!data || data.length === 0) break;
    all.push(...(data as SupabaseServiceCheckRow[]));
    if (data.length < READ_PAGE_SIZE) break;
    from += READ_PAGE_SIZE;
    console.log(`  read ${all.length} rows so far...`);
  }
  return all;
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function buildInsertStatement(rows: SupabaseServiceCheckRow[]): string {
  const values = rows
    .map(
      (r) =>
        `(${sqlValue(r.id)}, ${sqlValue(r.service_key)}, ${sqlValue(r.host)}, ${sqlValue(r.status)}, ${
          r.detail ? sqlValue(JSON.stringify(r.detail)) : "NULL"
        }, ${sqlValue(r.checked_at)})`,
    )
    .join(",\n");
  return `INSERT OR REPLACE INTO service_checks (id, service_key, host, status, detail, checked_at) VALUES\n${values};`;
}

// A file holds STATEMENTS_PER_FILE separate INSERT statements (not one giant
// statement — D1 rejects those past a modest size with "statement too long").
function buildInsertFile(rows: SupabaseServiceCheckRow[]): string {
  return chunk(rows, ROWS_PER_STATEMENT).map(buildInsertStatement).join("\n\n");
}

async function main(): Promise<void> {
  console.log("Reading service_checks from Supabase (myargus)...");
  const sourceRows = await readAllFromSupabase();
  console.log(`Read ${sourceRows.length} rows from Supabase.`);

  const tmpDir = await mkdtemp(join(tmpdir(), "watchtower-migrate-"));
  try {
    const rowsPerFile = ROWS_PER_STATEMENT * STATEMENTS_PER_FILE;
    const batches = chunk(sourceRows, rowsPerFile);
    console.log(`Writing to D1 in ${batches.length} file(s) of up to ${rowsPerFile} rows...`);
    let written = 0;
    for (let i = 0; i < batches.length; i++) {
      const filePath = join(tmpDir, `batch-${i}.sql`);
      await writeFile(filePath, buildInsertFile(batches[i]), "utf8");
      await d1Execute({ file: filePath });
      written += batches[i].length;
      console.log(`  wrote ${written}/${sourceRows.length} rows...`);
    }

    console.log("Verifying (fail-closed: any mismatch aborts before cutover)...");
    const sample: ServiceCheckRow[] = [];
    const step = Math.max(1, Math.floor(sourceRows.length / SPOT_CHECK_SAMPLE_SIZE));
    for (let i = 0; i < sourceRows.length && sample.length < SPOT_CHECK_SAMPLE_SIZE; i += step) {
      sample.push(sourceRows[i] as ServiceCheckRow);
    }

    const report = await verifyMigration(sourceRows.length, sample, {
      query: async (sql) => parseD1ExecuteJson(await d1Execute({ command: sql })),
    });

    console.log(`  row-count   source=${report.rowCount.sourceCount} dest=${report.rowCount.destCount} ok=${report.rowCount.ok}`);
    console.log(`  spot-check  checked=${report.spotCheck.checked} mismatches=${report.spotCheck.mismatches.length} ok=${report.spotCheck.ok}`);

    if (!report.ok) {
      console.error(JSON.stringify({ failures: report.failures, mismatches: report.spotCheck.mismatches }, null, 2));
      throw new Error(`Verification FAILED — do not cut over. ${report.failures.join("; ")}`);
    }

    console.log("Migration + verification complete.");
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
