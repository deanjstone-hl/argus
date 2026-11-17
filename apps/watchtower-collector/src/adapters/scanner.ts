import type {
  HealthStatus,
  ScannerDetail,
  ScannerJobDetail,
  ScannerJobState,
  ScannerState,
} from '@argus/watchtower-contract'
import { CheckError, type Adapter, type HealthResult } from '../adapter.js'

// The homelab scanner (the WF-3825's, shared by ipp-usb on localhost:60000)
// over eSCL, read-only: one GET /eSCL/ScannerStatus for the scanner state, the
// feeder state and the jobs it still remembers. Nothing here starts a scan.

export interface ScannerConfig {
  // The scanner's eSCL root, e.g. http://localhost:60000/eSCL. ipp-usb answers
  // 400 to a request naming an IP literal as its host.
  url: string
  intervalMs?: number
}

export interface ScannerDeps {
  now?: () => Date
}

const TIMEOUT_MS = 10_000
const RECENT_SCANS = 5

const SCANNER_STATES: Record<string, ScannerState> = {
  Idle: 'idle',
  Processing: 'processing',
  Testing: 'testing',
  Stopped: 'stopped',
  Down: 'down',
}

const JOB_STATES: Record<string, ScannerJobState> = {
  Pending: 'pending',
  Processing: 'processing',
  Completed: 'completed',
  Canceled: 'canceled',
  Aborted: 'aborted',
}

// Feeder states that need nobody's attention. Anything else the scanner
// reports (jam, door or hatch open, mispick, multipick, overloaded tray) does.
const ADF_OK = new Set(['empty', 'loaded', 'processing'])

// The status reply is small and flat, so a namespace-agnostic match on the
// local element name is enough; no XML parser is pulled in for it.
function elements(xml: string, name: string): string[] {
  const pattern = new RegExp(`<(?:[\\w-]+:)?${name}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[\\w-]+:)?${name}>`, 'g')
  return [...xml.matchAll(pattern)].map((match) => (match[1] ?? '').trim())
}

function element(xml: string, name: string): string | null {
  return elements(xml, name)[0] ?? null
}

function integer(xml: string, name: string): number | null {
  const text = element(xml, name)
  return text !== null && /^\d+$/.test(text) ? Number(text) : null
}

// ScannerAdfDoorOpen -> door-open
function adfState(raw: string | null): string | null {
  if (!raw) return null
  return raw
    .replace(/^ScannerAdf/, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .toLowerCase()
}

export function scannerStatus(detail: ScannerDetail): HealthStatus {
  if (detail.state === 'stopped' || detail.state === 'down') return 'down'
  if (detail.adfState !== null && !ADF_OK.has(detail.adfState)) return 'degraded'
  return 'healthy'
}

async function httpGet(url: string): Promise<string> {
  let response: Response
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) })
  } catch (error) {
    // fetch hides the socket error (ECONNREFUSED and so on) in its cause.
    const cause = error instanceof Error && error.cause instanceof Error ? error.cause.message : String(error)
    throw new Error(`scanner not answering at ${url} (ipp-usb not running, or the printer is off or unplugged): ${cause}`)
  }
  if (!response.ok) {
    throw new CheckError('down', `${url} returned HTTP ${response.status}`)
  }
  return response.text()
}

export function createScannerAdapter(config: ScannerConfig, deps: ScannerDeps = {}): Adapter {
  const now = deps.now ?? (() => new Date())
  const statusUrl = `${config.url.replace(/\/+$/, '')}/ScannerStatus`

  function toJob(xml: string, checkedAt: Date): ScannerJobDetail & { age: number | null } {
    const age = integer(xml, 'Age')
    return {
      id: element(xml, 'JobUuid') ?? element(xml, 'JobUri') ?? '',
      state: JOB_STATES[element(xml, 'JobState') ?? ''] ?? 'unknown',
      images: integer(xml, 'ImagesCompleted'),
      at: age === null ? null : new Date(checkedAt.getTime() - age * 1000).toISOString(),
      age,
    }
  }

  async function check(): Promise<HealthResult> {
    const xml = await httpGet(statusUrl)
    const body = element(xml, 'ScannerStatus')
    if (body === null) throw new CheckError('down', 'scanner sent a reply that is not an eSCL ScannerStatus')
    const rawState = element(body, 'State')
    const state = SCANNER_STATES[rawState ?? '']
    if (!state) throw new CheckError('down', `scanner reported no known pwg:State (${rawState ?? 'none'})`)

    const checkedAt = now()
    const recentScans = elements(body, 'JobInfo')
      .map((job) => toJob(job, checkedAt))
      // Newest first; a job with no age sorts last.
      .sort((a, b) => (a.age ?? Infinity) - (b.age ?? Infinity))
      .slice(0, RECENT_SCANS)
      .map(({ age: _age, ...job }) => job)

    const detail: ScannerDetail = { state, adfState: adfState(element(body, 'AdfState')), recentScans }
    return { status: scannerStatus(detail), detail }
  }

  return {
    key: 'scanner',
    host: 'homelab',
    intervalMs: config.intervalMs ?? 60_000,
    // No answer means ipp-usb has exited, which it does when the printer is
    // unplugged or switched off: the same treatment as the printer check.
    failureStatus: 'unreachable',
    check,
  }
}
