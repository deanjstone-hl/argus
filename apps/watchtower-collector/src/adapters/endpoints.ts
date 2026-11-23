import { connect } from 'node:tls'
import type { EndpointProbeDetail, HealthStatus, TlsCertDetail } from '@argus/watchtower-contract'
import { CheckError, type Adapter } from '../adapter.js'
import { REGISTRY, apiUrl, appUrl, mcpUrl, type LinkId } from '../lib/links.js'

// The public surface (argus#687): an anonymous HTTPS probe of each endpoint,
// and the certificate each host presents. Both run from homelab, so they see
// what any client on the internet sees. A failed probe or handshake is the
// endpoint's failure, so both record a throw as down.
//
// The list comes from the links registry (links.json, argus#18): every live
// entry that carries a probe. A planned, redirect or retired host is never
// probed, and a new host is probed once the registry holds it.

const HOST = REGISTRY.domain
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

// An entry whose base answers nothing useful is probed one path deeper, at a route its
// Worker answers itself with a 401: the registry holds the base, this holds the path.
const DEEPER_PROBES: Partial<Record<LinkId, { path: string; expected: number }>> = {
  'watchtower-api': { path: '/checks', expected: 401 },
  'email-mcp': { path: '/mcp', expected: 401 },
}

// A 302 in the registry is Cloudflare Access sending an anonymous request to its login.
const ACCESS_HOST = 'cloudflareaccess.com'

function baseUrl(entry: (typeof REGISTRY.entries)[number]): string | null {
  switch (entry.bucket) {
    case 'internal':
    case 'external':
      return appUrl(entry.id)
    case 'api':
      return apiUrl(entry.id)
    case 'mcp':
      return mcpUrl(entry.id)
    default:
      return null
  }
}

// Registry entries that are no longer probed. The registry is vendored from deanjstone/frontend
// and still lists the watchtower dashboard as live: its Pages project is deleted by argus#44
// and the registry entry goes with argus#45, so until then the collector skips it, and a
// deleted project does not turn the probe and the certificate check red (argus#66).
const NOT_PROBED: ReadonlySet<LinkId> = new Set<LinkId>(['watchtower'])

function endpointsFromRegistry(): PublicEndpoint[] {
  const endpoints: PublicEndpoint[] = []
  for (const entry of REGISTRY.entries) {
    if (entry.status !== 'live' || NOT_PROBED.has(entry.id)) continue
    const deeper = DEEPER_PROBES[entry.id]
    const expected = deeper?.expected ?? entry.probe?.status
    const base = baseUrl(entry)
    if (expected === undefined || base === null) continue
    const endpoint: PublicEndpoint = { url: `${base}${deeper?.path ?? ''}`, expected }
    if (expected === 302) endpoint.expectedRedirectHost = ACCESS_HOST
    endpoints.push(endpoint)
  }
  return endpoints
}

export const PUBLIC_ENDPOINTS: PublicEndpoint[] = endpointsFromRegistry()

// Each host once, in probe order: one certificate check per host, however many probes share it.
export const PUBLIC_HOSTS: string[] = [...new Set(PUBLIC_ENDPOINTS.map((endpoint) => new URL(endpoint.url).host))]

// `endpoint:<host>`, with the path added where several probes share a host (the shell and the
// apps mounted under it, the API Workers): a host of its own keeps the key it always had.
function endpointKeys(endpoints: PublicEndpoint[]): string[] {
  const hosts = endpoints.map((endpoint) => new URL(endpoint.url).host)
  return endpoints.map((endpoint) => {
    const url = new URL(endpoint.url)
    const shared = hosts.filter((host) => host === url.host).length > 1
    const path = shared ? url.pathname.replace(/\/+$/, '') : ''
    return `endpoint:${url.host}${path}`
  })
}

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

  const keys = endpointKeys(endpoints)
  return endpoints.map((endpoint, index) => ({
    key: keys[index] ?? `endpoint:${endpoint.url}`,
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
