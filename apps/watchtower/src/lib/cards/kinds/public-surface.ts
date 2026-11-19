import type { WorkerTrafficDetail } from '@argus/watchtower-contract'
import { afterPrefix, num, record, row, rows, text } from '../fields'
import type { CardFormatter, DetailRow } from '../types'
import { formatAbsoluteTime, pluralise } from '../units'
import { COOKIE_DOMAIN } from '@/lib/links'

// A host without the shared domain's suffix: the zone is the group's own name.
const withoutDomain = (host: string) => (host.endsWith(COOKIE_DOMAIN) ? host.slice(0, -COOKIE_DOMAIN.length) : host)

// The public surface of the Argus domain: the anonymous probe of each endpoint
// (`endpoint:<host>`), the certificate it presents (`tls:<host>`), and each
// Worker's error rates over the last hour (`worker-traffic:<script>`).

const ENDPOINT = 'endpoint:'
const TLS = 'tls:'
const WORKER = 'worker-traffic:'

function milliseconds(value: number): string {
  return value < 1000 ? `${value} ms` : `${(value / 1000).toFixed(1).replace(/\.0$/, '')} s`
}

function answerText(statusCode: number, redirectHost: string | null, expectedRedirectHost: string | null): string {
  if (expectedRedirectHost === 'cloudflareaccess.com' && redirectHost !== null && redirectHost.endsWith(expectedRedirectHost)) {
    return `${statusCode} to Cloudflare Access`
  }
  if (statusCode === 401) return '401, wants a token'
  return String(statusCode)
}

export const endpointFormatter: CardFormatter = {
  id: 'endpoint',
  matches: (check) => check.service_key.startsWith(ENDPOINT),
  format: (check, detail) => {
    const statusCode = num(detail, 'statusCode')
    const expected = num(detail, 'expected')
    const latency = num(detail, 'latencyMs')
    const slowAfter = num(detail, 'slowAfterMs')
    const redirectHost = text(detail, 'redirectHost')
    const expectedRedirectHost = text(detail, 'expectedRedirectHost')
    const url = text(detail, 'url')

    let reason: string | null = null
    if (statusCode !== null && expected !== null) {
      if (statusCode >= 500) reason = `Answered ${statusCode}`
      else if (statusCode !== expected) reason = `Answered ${statusCode}, expected ${expected}`
      else if (expectedRedirectHost !== null && (redirectHost === null || !redirectHost.endsWith(expectedRedirectHost))) {
        reason = `Redirected to ${redirectHost ?? 'nowhere'}, not Cloudflare Access`
      } else if (latency !== null && slowAfter !== null && latency > slowAfter) reason = `Slow: ${milliseconds(latency)}, over ${milliseconds(slowAfter)}`
    }

    return {
      title: afterPrefix(check.service_key, ENDPOINT),
      summary: statusCode === null ? null : [answerText(statusCode, redirectHost, expectedRedirectHost), latency === null ? null : milliseconds(latency)].filter(Boolean).join(' · '),
      reason,
      rows: rows(
        row('Probes', url === null ? null : new URL(url).pathname),
        row('Answer', statusCode === null ? null : String(statusCode)),
        row('Expected', expected === null ? null : String(expected)),
        row('Redirects to', redirectHost),
        row('Latency', latency === null ? null : milliseconds(latency)),
      ),
    }
  },
}

function expiryText(daysLeft: number): string {
  return daysLeft < 0 ? `${pluralise(-daysLeft, 'day')} ago` : `in ${pluralise(daysLeft, 'day')}`
}

export const tlsFormatter: CardFormatter = {
  id: 'tls',
  matches: (check) => check.service_key.startsWith(TLS),
  format: (check, detail) => {
    const daysLeft = num(detail, 'daysLeft')
    const validTo = text(detail, 'validTo')
    const issuer = text(detail, 'issuer')
    const downBelow = num(detail, 'downBelowDays')
    const names = Array.isArray(detail.names) ? (detail.names as string[]) : []

    let reason: string | null = null
    if (daysLeft !== null) {
      if (daysLeft < 0) reason = `Certificate expired ${expiryText(daysLeft)}`
      else if (downBelow !== null && daysLeft < downBelow) reason = `Certificate expires ${expiryText(daysLeft)}`
      else reason = `Certificate expires ${expiryText(daysLeft)}; Cloudflare should have renewed it by now`
    }

    return {
      // Beside the same host's endpoint card, so named for what it shows;
      // the zone is the group's own name, and the full host would not fit.
      title: `${withoutDomain(afterPrefix(check.service_key, TLS))} certificate`,
      summary: daysLeft === null ? null : [daysLeft < 0 ? `expired ${expiryText(daysLeft)}` : `expires ${expiryText(daysLeft)}`, issuer].filter(Boolean).join(' · '),
      reason,
      rows: rows(
        row('Expires', daysLeft === null ? null : expiryText(daysLeft), validTo === null ? {} : { title: formatAbsoluteTime(validTo) }),
        row('Issuer', issuer),
        row('Covers', names.length === 0 ? null : names.join(', ')),
      ),
    }
  },
}

const percent = (part: number, whole: number) => `${Math.round((part / whole) * 100)}%`

function trafficReason(detail: WorkerTrafficDetail): string | null {
  const { http, invocations, api } = detail
  if (http !== null && http.serverErrors > 0) {
    return `${http.serverErrors} of ${http.requests} requests got a 5xx (${percent(http.serverErrors, http.requests)}) in the last hour`
  }
  if (invocations.errors > 0) {
    return `${invocations.errors} of ${invocations.requests} invocations threw (${percent(invocations.errors, invocations.requests)}) in the last hour`
  }
  if (api && http !== null && http.clientErrors > 0) {
    return `${http.clientErrors} of ${http.requests} requests got a 4xx (${percent(http.clientErrors, http.requests)}) in the last hour; clients are being refused`
  }
  return null
}

function errorSummary(detail: WorkerTrafficDetail): string {
  const { http, invocations } = detail
  const parts = [
    http !== null && http.serverErrors > 0 ? `${http.serverErrors} 5xx (${percent(http.serverErrors, http.requests)})` : null,
    http !== null && http.clientErrors > 0 ? `${http.clientErrors} 4xx (${percent(http.clientErrors, http.requests)})` : null,
    invocations.errors > 0 ? `${pluralise(invocations.errors, 'exception')}` : null,
  ].filter(Boolean)
  return parts.length === 0 ? 'no errors' : parts.join(' · ')
}

function httpRows(detail: WorkerTrafficDetail): DetailRow[] {
  const { http } = detail
  if (http === null) {
    const unavailable = detail.httpUnavailable ?? 'unavailable'
    const short = /zone analytics \(needs/i.test(unavailable) ? 'needs Zone Analytics: Read' : unavailable.replace(/^./, (c) => c.toLowerCase())
    return rows(row('HTTP 4xx/5xx', short, { title: unavailable }))
  }
  const counted = (count: number) => (count === 0 ? '0' : `${count} (${percent(count, http.requests)})`)
  return rows(row('HTTP 4xx', counted(http.clientErrors)), row('HTTP 5xx', counted(http.serverErrors)))
}

export const workerTrafficFormatter: CardFormatter = {
  id: 'worker-traffic',
  matches: (check) => check.service_key.startsWith(WORKER),
  format: (check, raw) => {
    const title = afterPrefix(check.service_key, WORKER)
    const invocations = record(raw, 'invocations')
    if (invocations === null) return { title }
    const detail = raw as unknown as WorkerTrafficDetail
    const requests = detail.http?.requests ?? detail.invocations.requests
    const outcomes = Object.entries(detail.invocations.byStatus ?? {})

    return {
      title,
      summary: requests === 0 ? 'no requests in the last hour' : `${pluralise(requests, 'request')} in the last hour · ${errorSummary(detail)}`,
      reason: trafficReason(detail),
      rows: rows(
        row('Route', detail.route),
        row('Invocations', String(detail.invocations.requests)),
        row('Exceptions', String(detail.invocations.errors)),
        ...httpRows(detail),
      ),
      sections: outcomes.some(([outcome]) => outcome !== 'success')
        ? [{ title: 'Invocations by outcome', rows: outcomes.map(([outcome, count]) => ({ label: outcome, value: String(count) })) }]
        : [],
    }
  },
}
