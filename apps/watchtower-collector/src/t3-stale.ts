import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { T3StaleDetail, T3StaleReport } from '@argus/watchtower-contract'
import { CheckError, type Adapter, type HealthResult } from './adapter.js'

const execFileAsync = promisify(execFile)

// The T3 cards run argus-config's hooks/t3-stale.py --no-state, the very
// check behind the work order's `t3 stale:` error line (argus-config#1287),
// rather than a second copy of its rules: the host's active T3 against the
// newest release on its channel, and whole days behind. The hook decides
// `stale` (behind_days >= T3_STALE_DAYS, default 3); the card follows it. With
// --no-state it sends no message and writes no record, so it is safe to poll.

// Under the dashboard's STALE_AFTER_MS (15 minutes), as the vault cards are.
export const T3_STALE_INTERVAL_MS = 300_000

export interface T3StaleDeps {
  hookPath: string
  // The hook's stdout for one host.
  run: (hookPath: string, host: string) => Promise<string>
}

export function defaultT3StaleDeps(hookPath: string): T3StaleDeps {
  return {
    hookPath,
    // Two gh calls when the release feed is not cached, each up to 60 s.
    run: async (hook, host) =>
      (
        await execFileAsync('python3', ['-I', hook, '--no-state', '--host', host], {
          env: { ...process.env, LOOP_WAKE_HOST: host },
          timeout: 150_000,
        })
      ).stdout,
  }
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error))

export async function runT3StaleCheck(host: string, deps: T3StaleDeps): Promise<T3StaleReport> {
  let output: string
  try {
    output = await deps.run(deps.hookPath, host)
  } catch (error) {
    return { reading: null, error: message(error) }
  }
  try {
    return { reading: JSON.parse(output) as unknown, error: null }
  } catch {
    return { reading: null, error: `output was not JSON: ${output.trim().slice(0, 200) || 'empty'}` }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function evaluateT3Stale(report: T3StaleReport): HealthResult {
  if (report.error !== null) throw new CheckError('degraded', `t3-stale.py could not run: ${report.error}`)
  const reading = report.reading
  if (isRecord(reading) && typeof reading.error === 'string' && reading.error !== '') {
    throw new CheckError('degraded', reading.error)
  }
  const behind = isRecord(reading) ? reading.behind_days : undefined
  if (
    !isRecord(reading) ||
    typeof reading.host !== 'string' ||
    typeof reading.active !== 'string' ||
    typeof reading.newest !== 'string' ||
    typeof behind !== 'number' ||
    !Number.isFinite(behind) ||
    typeof reading.stale !== 'boolean'
  ) {
    throw new CheckError('degraded', `t3-stale.py gave an unusable reading: ${JSON.stringify(reading)?.slice(0, 200)}`)
  }
  const threshold = typeof reading.threshold_days === 'number' && Number.isFinite(reading.threshold_days) ? reading.threshold_days : 3
  const detail: T3StaleDetail = {
    host: reading.host,
    channel: typeof reading.channel === 'string' ? reading.channel : 'nightly',
    active: reading.active,
    newest: reading.newest,
    behindDays: behind,
    thresholdDays: threshold,
  }
  return { status: reading.stale ? 'degraded' : 'healthy', detail }
}

// `read` is undefined when the host's report has no T3 part (a shim older
// than this card).
export function createT3StaleAdapter(
  host: string,
  read: () => Promise<T3StaleReport | undefined>,
  failureStatus?: Adapter['failureStatus'],
): Adapter {
  return {
    key: `${host}:t3-stale`,
    host,
    intervalMs: T3_STALE_INTERVAL_MS,
    ...(failureStatus ? { failureStatus } : {}),
    check: async () => {
      const report = await read()
      if (!report) throw new CheckError('degraded', 'the usage-shim does not report T3 staleness; redeploy it')
      return evaluateT3Stale(report)
    },
  }
}
