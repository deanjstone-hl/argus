import { readFile as readFileFs } from 'node:fs/promises'
import { availableParallelism } from 'node:os'
import type { HostLoadDetail, HostMemoryDetail } from '@argus/watchtower-contract'
import type { Adapter, HealthResult } from '../adapter.js'
import { evaluateMemory, parseMeminfo, parsePressure } from '../memory.js'

// homelab's load average and memory, read from /proc on the host the
// collector runs on (argus#685).

// Load counts tasks running or waiting on CPU or disk. homelab's sar history
// for 2026-10-10..16 (4 CPUs) averages 1.8-2.4 a day, and the 5-minute load
// reached 8 in only 2-12 ten-minute samples of 143 a day: the spikes,
// 10-25, that slowed CI and pre-push hooks on 2026-10-15 and 16. Twice the
// CPU count on the 5-minute average catches those without flagging a
// 1-minute burst or the routine evening backup.
const LOAD_DEGRADED_PER_CPU = 2

export type ReadFile = (path: string) => Promise<string>

export interface ResourceOptions {
  readFile?: ReadFile
  cpus?: () => number
  intervalMs?: number
}

const readText: ReadFile = (path) => readFileFs(path, 'utf8')

async function checkLoad(readFile: ReadFile, cpus: number): Promise<HealthResult> {
  const [load1, load5, load15] = (await readFile('/proc/loadavg')).trim().split(/\s+/).slice(0, 3).map(Number)
  if (![load1, load5, load15].every((value) => value !== undefined && Number.isFinite(value))) {
    throw new Error('/proc/loadavg could not be read')
  }
  const detail: HostLoadDetail = { load1: load1 as number, load5: load5 as number, load15: load15 as number, cpus }
  return { status: detail.load5 >= cpus * LOAD_DEGRADED_PER_CPU ? 'degraded' : 'healthy', detail }
}

async function checkMemory(readFile: ReadFile): Promise<HealthResult> {
  const meminfo = parseMeminfo(await readFile('/proc/meminfo'))
  let pressure: HostMemoryDetail['pressure'] = null
  try {
    pressure = parsePressure(await readFile('/proc/pressure/memory'))
  } catch {
    // A kernel built without PSI has no /proc/pressure; judge memory alone.
    pressure = null
  }
  return evaluateMemory({ ...meminfo, pressure })
}

export function createLoadAdapter(options: ResourceOptions = {}): Adapter {
  const readFile = options.readFile ?? readText
  const cpus = options.cpus ?? availableParallelism
  return {
    key: 'homelab:load',
    host: 'homelab',
    intervalMs: options.intervalMs ?? 60_000,
    check: () => checkLoad(readFile, cpus()),
  }
}

export function createMemoryAdapter(options: ResourceOptions = {}): Adapter {
  const readFile = options.readFile ?? readText
  return {
    key: 'homelab:memory',
    host: 'homelab',
    intervalMs: options.intervalMs ?? 60_000,
    check: () => checkMemory(readFile),
  }
}
