import { connect } from 'node:tls'
import type { EndpointProbeDetail, HealthStatus, TlsCertDetail } from '@argus/watchtower-contract'
import { CheckError, type Adapter } from '../adapter.js'

// The public surface on myargus.cc (argus#687): an anonymous HTTPS probe of
// each endpoint, and the certificate each host presents. Both run from
// homelab, so they see what any client on the internet sees. A failed probe
// or handshake is the endpoint's failure, so both record a throw as down.

const HOST = 'myargus.cc'
const INTERVAL_MS = 300_000
const TIMEOUT_MS = 10_000
const SLOW_AFTER_MS = 3_000
// Cloudflare renews its edge certificates about 30 days before expiry, so
// three weeks left means a renewal is already overdue.
const TLS_DEGRADED_BELOW_DAYS = 21
const TLS_DOWN_BELOW_DAYS = 7
const DAY_MS = 86_400_000

// Sent with every probe, so the Worker traffic cards can leave the probes
// out of a Worker's 4xx rate.
export const PROBE_USER_AGENT = 'argus-watchtower-probe'

export interface PublicEndpoint {
  url: string
  // What an anonymous request should get.
  expected: number
  // For a redirect: the host its Location must end with.
  expectedRedirectHost?: string
}

// Each host from a wrangler route or custom domain, or the dashboard's Pages
// domain, at a path its Worker answers itself. An API that wants a token
// answers 401; mail is behind Cloudflare Access, which redirects to its login.
export const PUBLIC_ENDPOINTS: PublicEndpoint[] = [
  { url: 'https://api.myargus.cc/watchtower/checks', expected: 401 },
  { url: 'https://memory.myargus.cc/mcp', expected: 401 },
  { url: 'https://vault.myargus.cc/mcp', expected: 401 },
  { url: 'https://mail.myargus.cc/', expected: 302, expectedRedirectHost: 'cloudflareaccess.com' },
  { url: 'https://mcp.myargus.cc/email/mcp', expected: 401 },
  { url: 'https://watchtower.myargus.cc/', expected: 200 },
]

export interface EndpointOptions {
  fetch?: typeof fetch
  now?: () => number
}

function hostEndsWith(host: string, suffix: string): boolean {
  return host === suffix || host.endsWith(`.${suffix}`)
}

function judgeProbe(detail: EndpointProbeDetail): HealthStatus {
  if (detail.statusCode >= 500) return 'down'
  if (detail.statusCode !== detail.expected) return 'degraded'
  if (detail.expectedRedirectHost !== null && (detail.redirectHost === null || !hostEndsWith(detail.redirectHost, detail.expectedRedirectHost))) return 'degraded'
  return detail.latencyMs > detail.slowAfterMs ? 'degraded' : 'healthy'
}

export function createEndpointAdapters(endpoints: PublicEndpoint[], options: EndpointOptions = {}): Adapter[] {
  const fetchImpl = options.fetch ?? fetch
  const now = options.now ?? Date.now

  return endpoints.map((endpoint) => ({
    key: `endpoint:${new URL(endpoint.url).host}`,
    host: HOST,
    intervalMs: INTERVAL_MS,
    failureStatus: 'down',
    check: async () => {
      const startedAt = now()
      let response: Response
      try {
        response = await fetchImpl(endpoint.url, {
          redirect: 'manual',
          headers: { 'user-agent': PROBE_USER_AGENT },
          signal: AbortSignal.timeout(TIMEOUT_MS),
        })
      } catch (error) {
        throw new Error(`${endpoint.url}: ${error instanceof Error ? error.message : String(error)}`)
      }
      const latencyMs = now() - startedAt
      // Only the status matters; the body is drained so the socket is freed.
      await response.body?.cancel()
      const location = response.headers.get('location')
      const detail: EndpointProbeDetail = {
        url: endpoint.url,
        expected: endpoint.expected,
        expectedRedirectHost: endpoint.expectedRedirectHost ?? null,
        statusCode: response.status,
        redirectHost: location === null ? null : new URL(location, endpoint.url).host,
        latencyMs,
        slowAfterMs: SLOW_AFTER_MS,
      }
      return { status: judgeProbe(detail), detail }
    },
  }))
}

// The fields of node's PeerCertificate this reads.
export interface PeerCertificate {
  valid_from: string
  valid_to: string
  issuer: { O?: string; CN?: string }
  subject: { CN?: string }
  subjectaltname?: string
}

export function readPeerCertificate(host: string): Promise<PeerCertificate> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host, port: 443, servername: host, timeout: TIMEOUT_MS }, () => {
      const certificate = socket.getPeerCertificate()
      socket.end()
      // node types each issuer and subject field as string | string[]; a
      // name repeated in the DN is the only case of the array.
      const first = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value)
      resolve({
        valid_from: certificate.valid_from,
        valid_to: certificate.valid_to,
        issuer: { O: first(certificate.issuer?.O), CN: first(certificate.issuer?.CN) },
        subject: { CN: first(certificate.subject?.CN) },
        subjectaltname: certificate.subjectaltname,
      })
    })
    socket.on('timeout', () => socket.destroy(new Error(`TLS handshake with ${host} timed out`)))
    socket.on('error', reject)
  })
}

export interface TlsOptions {
  readCertificate?: (host: string) => Promise<PeerCertificate>
  now?: () => number
}

function certificateDate(host: string, value: string): string {
  const parsed = Date.parse(value)
  if (Number.isNaN(parsed)) throw new CheckError('degraded', `${host} presented a certificate with an unreadable date "${value}"`)
  return new Date(parsed).toISOString()
}

export function createTlsAdapters(hosts: string[], options: TlsOptions = {}): Adapter[] {
  const readCertificate = options.readCertificate ?? readPeerCertificate
  const now = options.now ?? Date.now

  return hosts.map((host) => ({
    key: `tls:${host}`,
    host: HOST,
    intervalMs: INTERVAL_MS,
    failureStatus: 'down',
    check: async () => {
      const certificate = await readCertificate(host)
      const validTo = certificateDate(host, certificate.valid_to)
      const daysLeft = Math.floor((Date.parse(validTo) - now()) / DAY_MS)
      const detail: TlsCertDetail = {
        host,
        validFrom: certificateDate(host, certificate.valid_from),
        validTo,
        daysLeft,
        issuer: [certificate.issuer.O, certificate.issuer.CN].filter(Boolean).join(' ') || null,
        subject: certificate.subject.CN ?? null,
        names: (certificate.subjectaltname ?? '')
          .split(',')
          .map((name) => name.trim())
          .filter((name) => name.startsWith('DNS:'))
          .map((name) => name.slice('DNS:'.length)),
        degradedBelowDays: TLS_DEGRADED_BELOW_DAYS,
        downBelowDays: TLS_DOWN_BELOW_DAYS,
      }
      const status: HealthStatus = daysLeft < TLS_DOWN_BELOW_DAYS ? 'down' : daysLeft < TLS_DEGRADED_BELOW_DAYS ? 'degraded' : 'healthy'
      return { status, detail }
    },
  }))
}
