import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { TailscaleDeviceDetail } from '@argus/watchtower-contract'
import { CheckError, type Adapter, type HealthResult } from '../adapter.js'

const execFileAsync = promisify(execFile)

// Last-seen for each tailnet device, from homelab's own `tailscale status
// --json` (argus#685): no API key, and homelab is the one machine that is
// always on. WSL2 dropped off the tailnet for 12 hours unnoticed during
// argus-config#625.
//
// A device is degraded once it has been offline longer than its allowance,
// which is per device: a laptop sleeps overnight, a phone for days. A device
// with a companion (WSL2 inside its Windows host) is also degraded when it
// has been offline 10 minutes while the companion is online, which is the
// argus-config#625 failure: the laptop awake, its WSL2 gone.

const HOST = 'tailscale'
const INTERVAL_MS = 60_000
// Shorter than the poll interval, so every device card in a poll shares one
// `tailscale status` and the next poll always reruns it.
const CACHE_MS = 30_000
const DEFAULT_OFFLINE_AFTER_MS = 3_600_000
const COMPANION_GRACE_MS = 10 * 60_000
const UNITS: Record<string, number> = { m: 60_000, h: 3_600_000, d: 86_400_000 }

export interface TailscaleTarget {
  name: string
  offlineAfterMs: number
  companion: string | null
}

interface StatusNode {
  HostName?: string
  DNSName?: string
  OS?: string
  Online?: boolean
  LastSeen?: string
  TailscaleIPs?: string[] | null
  KeyExpiry?: string | null
}

interface Status {
  Self?: StatusNode
  Peer?: Record<string, StatusNode> | null
}

export type TailscaleSource = () => Promise<Status>

// TAILSCALE_DEVICES: comma-separated `name[@offline-after][~companion]`,
// e.g. `DJ15@7d,lnv-lgn5-wsl@12h~LNV-LGN5`. The offline allowance is
// minutes, hours or days and defaults to 1 hour. The list is explicit so a
// device removed from the tailnet shows as down instead of vanishing.
export function parseTailscaleDevices(value: string | undefined): TailscaleTarget[] {
  return (value ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const match = /^([^@~\s]+)(?:@(\d+)([mhd]))?(?:~([^@~\s]+))?$/.exec(entry)
      if (!match) throw new Error(`TAILSCALE_DEVICES entry "${entry}" is not name[@<n>m|h|d][~companion]`)
      const [, name, amount, unit, companion] = match
      return {
        name: name as string,
        offlineAfterMs: amount && unit ? Number(amount) * (UNITS[unit] as number) : DEFAULT_OFFLINE_AFTER_MS,
        companion: companion ?? null,
      }
    })
}

export interface TailscaleSourceOptions {
  run?: () => Promise<string>
  now?: () => number
}

const runTailscale = async () => (await execFileAsync('tailscale', ['status', '--json'])).stdout

export function createTailscaleSource(options: TailscaleSourceOptions = {}): TailscaleSource {
  const run = options.run ?? runTailscale
  const now = options.now ?? Date.now
  let cached: { at: number; status: Promise<Status> } | null = null

  return () => {
    if (cached && now() - cached.at < CACHE_MS) return cached.status
    const status = run().then((output) => JSON.parse(output) as Status)
    const entry = { at: now(), status }
    cached = entry
    status.catch(() => {
      if (cached === entry) cached = null
    })
    return status
  }
}

const shortName = (node: StatusNode) => (node.DNSName ?? '').split('.')[0] ?? ''

function find(status: Status, name: string): { node: StatusNode; self: boolean } | null {
  const wanted = name.toLowerCase()
  const matches = (node: StatusNode) => node.HostName?.toLowerCase() === wanted || shortName(node).toLowerCase() === wanted
  if (status.Self && matches(status.Self)) return { node: status.Self, self: true }
  const peer = Object.values(status.Peer ?? {}).find(matches)
  return peer ? { node: peer, self: false } : null
}

// Tailscale reports the zero time as LastSeen while a device is online.
function lastSeenOf(node: StatusNode): string | null {
  const at = node.LastSeen ? Date.parse(node.LastSeen) : Number.NaN
  return Number.isFinite(at) && at > 0 ? (node.LastSeen as string) : null
}

function checkDevice(status: Status, target: TailscaleTarget, now: number): HealthResult {
  const found = find(status, target.name)
  if (!found) throw new CheckError('down', `${target.name} is not in the tailnet`)
  const { node, self } = found
  const companion = target.companion === null ? null : find(status, target.companion)
  const detail: TailscaleDeviceDetail = {
    name: node.HostName ?? target.name,
    dnsName: node.DNSName ? node.DNSName.replace(/\.$/, '') : null,
    os: node.OS || null,
    self,
    online: node.Online === true,
    lastSeen: lastSeenOf(node),
    ips: node.TailscaleIPs ?? [],
    keyExpiry: node.KeyExpiry ?? null,
    offlineAfterMs: target.offlineAfterMs,
    companion: target.companion,
    companionOnline: companion === null ? null : companion.node.Online === true,
  }
  if (detail.online) return { status: 'healthy', detail }
  // Offline with no last-seen time: tailscale has never seen it, so it has
  // been gone longer than any allowance.
  const offlineMs = detail.lastSeen === null ? Number.POSITIVE_INFINITY : now - Date.parse(detail.lastSeen)
  const pastAllowance = offlineMs >= target.offlineAfterMs
  const leftBehind = detail.companionOnline === true && offlineMs >= COMPANION_GRACE_MS
  return { status: pastAllowance || leftBehind ? 'degraded' : 'healthy', detail }
}

export function createTailscaleAdapters(source: TailscaleSource, targets: TailscaleTarget[], now: () => number = Date.now): Adapter[] {
  return targets.map((target) => ({
    key: `${HOST}:${target.name}`,
    host: HOST,
    intervalMs: INTERVAL_MS,
    check: async () => checkDevice(await source(), target, now()),
  }))
}
