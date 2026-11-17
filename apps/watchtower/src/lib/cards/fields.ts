import type { CheckDetail } from '@argus/watchtower-contract'
import type { DetailRow } from './types'
import { formatAbsoluteTime, formatRelativeTime } from './units'

// Typed reads from an untrusted detail blob. A failed check's detail is just
// `{ error }`, so every formatter must cope with any field being absent.

export function text(detail: CheckDetail, key: string): string | null {
  const value = detail[key]
  return typeof value === 'string' && value !== '' ? value : null
}

export function num(detail: CheckDetail, key: string): number | null {
  const value = detail[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

export function list<T>(detail: CheckDetail, key: string): T[] {
  const value = detail[key]
  return Array.isArray(value) ? (value as T[]) : []
}

export function record(detail: CheckDetail, key: string): CheckDetail | null {
  const value = detail[key]
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as CheckDetail) : null
}

// Rows whose value is missing are dropped rather than shown as a dash.
export function rows(...candidates: Array<DetailRow | null>): DetailRow[] {
  return candidates.filter((row): row is DetailRow => row !== null)
}

export function row(label: string, value: string | null, extra: Partial<DetailRow> = {}): DetailRow | null {
  return value === null ? null : { label, value, ...extra }
}

export function timeRow(label: string, isoTimestamp: string | null, now: number): DetailRow | null {
  if (isoTimestamp === null || Number.isNaN(Date.parse(isoTimestamp))) return null
  return { label, value: formatRelativeTime(isoTimestamp, now), title: formatAbsoluteTime(isoTimestamp) }
}

export function afterPrefix(serviceKey: string, prefix: string): string {
  return serviceKey.slice(prefix.length)
}
