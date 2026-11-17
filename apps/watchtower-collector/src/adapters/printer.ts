import type {
  HealthStatus,
  PrinterDetail,
  PrinterJobDetail,
  PrinterJobState,
  PrinterMarkerDetail,
  PrinterState,
} from '@argus/watchtower-contract'
import { CheckError, type Adapter, type HealthResult } from '../adapter.js'
import { decodeResponse, encodeRequest, IppTag, type IppAttributeGroup, type IppResponse, type IppValue } from '../ipp.js'

// The homelab printer (an Epson WF-3825, shared by ipp-usb on localhost:60000)
// over plain IPP: Get-Printer-Attributes for state, reasons and ink, and
// Get-Jobs for the queue and recent history.

export type IppPost = (url: string, body: Uint8Array) => Promise<Uint8Array>

export interface PrinterConfig {
  // The printer's IPP endpoint over HTTP, e.g. http://localhost:60000/ipp/print.
  // ipp-usb answers 400 to a request naming an IP literal as its host.
  url: string
  intervalMs?: number
}

export interface PrinterDeps {
  post?: IppPost
  now?: () => Date
}

const GET_JOBS = 0x000a
const GET_PRINTER_ATTRIBUTES = 0x000b
const TIMEOUT_MS = 10_000
const RECENT_JOBS = 5

const PRINTER_ATTRIBUTES = [
  'printer-state',
  'printer-state-reasons',
  'printer-state-message',
  'printer-make-and-model',
  'printer-current-time',
  'printer-up-time',
  'marker-names',
  'marker-colors',
  'marker-levels',
  'marker-low-levels',
]

const JOB_ATTRIBUTES = [
  'job-id',
  'job-name',
  'job-originating-user-name',
  'job-state',
  'job-impressions-completed',
  'date-time-at-creation',
  'date-time-at-completed',
  'time-at-creation',
  'time-at-completed',
]

const PRINTER_STATES: Record<number, PrinterState> = { 3: 'idle', 4: 'processing', 5: 'stopped' }

const JOB_STATES: Record<number, PrinterJobState> = {
  3: 'pending',
  4: 'pending-held',
  5: 'processing',
  6: 'processing-stopped',
  7: 'canceled',
  8: 'aborted',
  9: 'completed',
}

// RFC 8011 §5.4.12 makes a reason with no severity suffix an error, but
// printers commonly send these supply-low reasons bare, and they are warnings.
const BARE_WARNINGS = new Set(['marker-supply-low', 'toner-low', 'media-low', 'marker-waste-almost-full'])

function reasonSeverity(reason: string): 'error' | 'warning' | 'report' {
  if (reason.endsWith('-report')) return 'report'
  if (reason.endsWith('-warning') || BARE_WARNINGS.has(reason)) return 'warning'
  return 'error'
}

export function printerStatus(detail: PrinterDetail): HealthStatus {
  const severities = detail.reasons.map(reasonSeverity)
  if (detail.state === 'stopped' || severities.includes('error')) return 'down'
  if (severities.includes('warning') || detail.markers.some((marker) => marker.low)) return 'degraded'
  return 'healthy'
}

async function httpPost(url: string, body: Uint8Array): Promise<Uint8Array> {
  let response: Response
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/ipp' },
      body,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
  } catch (error) {
    // fetch hides the socket error (ECONNREFUSED and so on) in its cause.
    const cause = error instanceof Error && error.cause instanceof Error ? error.cause.message : String(error)
    throw new Error(
      `printer not answering at ${url} (ipp-usb not running, or the printer is off or unplugged): ${cause}`,
    )
  }
  if (!response.ok) {
    throw new CheckError('down', `${url} returned HTTP ${response.status}`)
  }
  return new Uint8Array(await response.arrayBuffer())
}

function first(group: IppAttributeGroup | undefined, name: string): IppValue | undefined {
  return group?.attributes[name]?.[0]
}

function asString(value: IppValue | undefined): string | null {
  return typeof value === 'string' && value !== '' ? value : null
}

function asNumber(value: IppValue | undefined): number | null {
  return typeof value === 'number' ? value : null
}

function asDate(value: IppValue | undefined): Date | null {
  return value instanceof Date ? value : null
}

// Job and printer times come from the printer's own clock, which drifts. A
// date-time-at-* is shifted by the skew printer-current-time shows against
// ours; failing that, a time-at-* (seconds of printer uptime) is dated from
// printer-up-time, which needs no wall clock at all.
interface PrinterClock {
  now: Date
  skewMs: number | null
  upTime: number | null
}

function jobTime(clock: PrinterClock, dateTime: IppValue | undefined, upTimeAt: IppValue | undefined): string | null {
  const date = asDate(dateTime)
  if (clock.skewMs !== null && date) return new Date(date.getTime() - clock.skewMs).toISOString()
  const at = asNumber(upTimeAt)
  if (clock.upTime !== null && at !== null && at > 0 && at <= clock.upTime) {
    return new Date(clock.now.getTime() - (clock.upTime - at) * 1000).toISOString()
  }
  return null
}

function toJob(group: IppAttributeGroup, clock: PrinterClock): PrinterJobDetail {
  const state = JOB_STATES[asNumber(first(group, 'job-state')) ?? 0] ?? 'unknown'
  const finished = state === 'completed' || state === 'canceled' || state === 'aborted'
  return {
    id: asNumber(first(group, 'job-id')) ?? 0,
    name: asString(first(group, 'job-name')) ?? '',
    user: asString(first(group, 'job-originating-user-name')),
    state,
    pages: asNumber(first(group, 'job-impressions-completed')),
    at: finished
      ? jobTime(clock, first(group, 'date-time-at-completed'), first(group, 'time-at-completed'))
      : jobTime(clock, first(group, 'date-time-at-creation'), first(group, 'time-at-creation')),
  }
}

// marker-levels uses -1 (unavailable), -2 (unknown) and -3 (some remaining)
// for levels the printer cannot measure.
function toMarkers(printer: IppAttributeGroup | undefined): PrinterMarkerDetail[] {
  const names = printer?.attributes['marker-names'] ?? []
  const colors = printer?.attributes['marker-colors'] ?? []
  const levels = printer?.attributes['marker-levels'] ?? []
  const lowLevels = printer?.attributes['marker-low-levels'] ?? []
  return names.map((name, index) => {
    const reported = asNumber(levels[index])
    const level = reported !== null && reported >= 0 ? reported : null
    const lowLevel = asNumber(lowLevels[index])
    return {
      name: asString(name) ?? `marker ${index + 1}`,
      color: asString(colors[index]),
      level,
      lowLevel,
      low: level !== null && lowLevel !== null && level <= lowLevel,
    }
  })
}

function isSuccess(response: IppResponse): boolean {
  return response.statusCode < 0x0100
}

export function createPrinterAdapter(config: PrinterConfig, deps: PrinterDeps = {}): Adapter {
  const post = deps.post ?? httpPost
  const now = deps.now ?? (() => new Date())
  const printerUri = config.url.replace(/^http/, 'ipp')
  let requestId = 0

  async function send(operation: number, attributes: Array<[number, string, Array<string | number | boolean>]>) {
    const body = encodeRequest(operation, ++requestId, [
      { tag: IppTag.charset, name: 'attributes-charset', values: ['utf-8'] },
      { tag: IppTag.naturalLanguage, name: 'attributes-natural-language', values: ['en'] },
      { tag: IppTag.uri, name: 'printer-uri', values: [printerUri] },
      { tag: IppTag.nameWithoutLanguage, name: 'requesting-user-name', values: ['watchtower'] },
      ...attributes.map(([tag, name, values]) => ({ tag, name, values })),
    ])
    const reply = await post(config.url, body)
    try {
      return decodeResponse(reply)
    } catch (error) {
      throw new CheckError('down', `printer sent a reply that is not IPP: ${error instanceof Error ? error.message : error}`)
    }
  }

  function getJobs(which: 'not-completed' | 'completed') {
    return send(GET_JOBS, [
      [IppTag.keyword, 'which-jobs', [which]],
      [IppTag.boolean, 'my-jobs', [false]],
      [IppTag.keyword, 'requested-attributes', JOB_ATTRIBUTES],
    ])
  }

  async function check(): Promise<HealthResult> {
    const [attributes, pending, completed] = await Promise.all([
      send(GET_PRINTER_ATTRIBUTES, [[IppTag.keyword, 'requested-attributes', PRINTER_ATTRIBUTES]]),
      getJobs('not-completed'),
      getJobs('completed'),
    ])
    if (!isSuccess(attributes)) {
      throw new CheckError('down', `Get-Printer-Attributes failed with IPP status 0x${attributes.statusCode.toString(16).padStart(4, '0')}`)
    }
    const printer = attributes.groups.find((group) => group.tag === IppTag.printerAttributes)
    const state = PRINTER_STATES[asNumber(first(printer, 'printer-state')) ?? 0]
    if (!state) throw new CheckError('down', 'printer reported no printer-state')

    const checkedAt = now()
    const printerTime = asDate(first(printer, 'printer-current-time'))
    const clock: PrinterClock = {
      now: checkedAt,
      skewMs: printerTime ? printerTime.getTime() - checkedAt.getTime() : null,
      upTime: asNumber(first(printer, 'printer-up-time')),
    }
    const jobsOf = (response: IppResponse) =>
      isSuccess(response)
        ? response.groups.filter((group) => group.tag === IppTag.jobAttributes).map((group) => toJob(group, clock))
        : []

    const detail: PrinterDetail = {
      state,
      reasons: (printer?.attributes['printer-state-reasons'] ?? [])
        .map(asString)
        .filter((reason): reason is string => reason !== null && reason !== 'none'),
      message: asString(first(printer, 'printer-state-message')),
      model: asString(first(printer, 'printer-make-and-model')),
      markers: toMarkers(printer),
      // A Get-Jobs the printer refuses (one that keeps no history may refuse
      // which-jobs=completed) leaves that list empty: the status rests on the
      // printer's state, not its jobs.
      queue: jobsOf(pending).sort((a, b) => a.id - b.id),
      recentJobs: jobsOf(completed)
        .sort((a, b) => b.id - a.id)
        .slice(0, RECENT_JOBS),
      clockSkewSeconds: clock.skewMs === null ? null : Math.round(clock.skewMs / 1000),
    }
    return { status: printerStatus(detail), detail }
  }

  return {
    key: 'printer',
    host: 'homelab',
    intervalMs: config.intervalMs ?? 60_000,
    // No answer means ipp-usb has exited, which it does when the printer is
    // unplugged or switched off.
    failureStatus: 'unreachable',
    check,
  }
}
