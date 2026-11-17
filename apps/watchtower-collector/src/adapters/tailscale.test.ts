import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { runCheck } from '../poller.js'
import { createTailscaleAdapters, createTailscaleSource, parseTailscaleDevices } from './tailscale.js'

vi.mock('../record-check.js', () => ({ recordCheck: vi.fn() }))

// `tailscale status --json` on homelab, 2026-10-16 12:44 UTC, trimmed to the
// fields the adapter reads: LNV-LGN5, its WSL2 and aperture online, the
// phone DJ15 last seen at 10:40.
const STATUS = readFileSync(new URL('../__fixtures__/tailscale-status-homelab.json', import.meta.url), 'utf8')
const NOW = Date.parse('2026-10-16T12:45:00Z')
const HOUR = 3_600_000

function withPeers(changes: Record<string, Record<string, unknown>>): string {
  const status = JSON.parse(STATUS)
  for (const peer of Object.values(status.Peer) as Array<Record<string, unknown>>) {
    Object.assign(peer, changes[peer.HostName as string] ?? {})
  }
  return JSON.stringify(status)
}

function adapters(spec: string, output = STATUS, now = NOW) {
  let calls = 0
  const source = createTailscaleSource({
    run: async () => {
      calls += 1
      return output
    },
    now: () => now,
  })
  const list = createTailscaleAdapters(source, parseTailscaleDevices(spec), () => now)
  return { byKey: (key: string) => list.find((adapter) => adapter.key === key)!, list, calls: () => calls }
}

describe('parseTailscaleDevices', () => {
  it('reads name[@offline-after][~companion], defaulting to 1 hour', () => {
    expect(parseTailscaleDevices('homelab, DJ15@7d,lnv-lgn5-wsl@12h~LNV-LGN5, aperture@30m')).toEqual([
      { name: 'homelab', offlineAfterMs: HOUR, companion: null },
      { name: 'DJ15', offlineAfterMs: 7 * 24 * HOUR, companion: null },
      { name: 'lnv-lgn5-wsl', offlineAfterMs: 12 * HOUR, companion: 'LNV-LGN5' },
      { name: 'aperture', offlineAfterMs: 30 * 60_000, companion: null },
    ])
  })

  it('rejects a duration it cannot read', () => {
    expect(() => parseTailscaleDevices('DJ15@soon')).toThrow('TAILSCALE_DEVICES entry "DJ15@soon"')
  })
})

describe('tailscale adapters', () => {
  it('makes one card per device under host tailscale, sharing one status call', async () => {
    const { list, calls } = adapters('homelab,LNV-LGN5,DJ15')
    expect(list.map((adapter) => [adapter.key, adapter.host, adapter.intervalMs])).toEqual([
      ['tailscale:homelab', 'tailscale', 60_000],
      ['tailscale:LNV-LGN5', 'tailscale', 60_000],
      ['tailscale:DJ15', 'tailscale', 60_000],
    ])
    await Promise.all(list.map((adapter) => runCheck(adapter)))
    expect(calls()).toBe(1)
  })

  it('reports an online peer with no last-seen time', async () => {
    expect(await runCheck(adapters('lnv-lgn5-wsl').byKey('tailscale:lnv-lgn5-wsl'))).toEqual({
      status: 'healthy',
      detail: {
        name: 'lnv-lgn5-wsl',
        dnsName: 'lnv-lgn5-wsl.tailnet-example.ts.net',
        os: 'linux',
        self: false,
        online: true,
        lastSeen: null,
        ips: expect.any(Array),
        keyExpiry: null,
        offlineAfterMs: HOUR,
        companion: null,
        companionOnline: null,
      },
    })
  })

  it('reports homelab itself as self', async () => {
    expect(await runCheck(adapters('homelab').byKey('tailscale:homelab'))).toMatchObject({ status: 'healthy', detail: { self: true, online: true } })
  })

  it('matches names case-insensitively', async () => {
    expect((await runCheck(adapters('lnv-lgn5').byKey('tailscale:lnv-lgn5'))).detail).toMatchObject({ name: 'LNV-LGN5' })
  })

  it('stays healthy while an offline device is inside its allowance', async () => {
    const result = await runCheck(adapters('DJ15@7d').byKey('tailscale:DJ15'))
    expect(result).toMatchObject({ status: 'healthy', detail: { online: false, lastSeen: '2026-10-16T10:40:00.1Z' } })
  })

  it('is degraded once offline longer than its allowance', async () => {
    expect((await runCheck(adapters('DJ15@1h').byKey('tailscale:DJ15'))).status).toBe('degraded')
  })

  it('is degraded when a device is offline while its companion is online, after 10 minutes', async () => {
    const dropped = (lastSeen: string) => withPeers({ 'lnv-lgn5-wsl': { Online: false, LastSeen: lastSeen } })
    const fresh = await runCheck(adapters('lnv-lgn5-wsl@12h~LNV-LGN5', dropped('2026-10-16T12:40:00Z')).byKey('tailscale:lnv-lgn5-wsl'))
    expect(fresh.status).toBe('healthy')
    const stale = await runCheck(adapters('lnv-lgn5-wsl@12h~LNV-LGN5', dropped('2026-10-16T12:30:00Z')).byKey('tailscale:lnv-lgn5-wsl'))
    expect(stale).toMatchObject({ status: 'degraded', detail: { companion: 'LNV-LGN5', companionOnline: true } })
  })

  it('is not judged against a companion that is offline too', async () => {
    const sleeping = withPeers({
      'lnv-lgn5-wsl': { Online: false, LastSeen: '2026-10-16T08:00:00Z' },
      'LNV-LGN5': { Online: false, LastSeen: '2026-10-16T08:00:00Z' },
    })
    const result = await runCheck(adapters('lnv-lgn5-wsl@12h~LNV-LGN5', sleeping).byKey('tailscale:lnv-lgn5-wsl'))
    expect(result).toMatchObject({ status: 'healthy', detail: { companionOnline: false } })
  })

  it('is down when the device is not in the tailnet', async () => {
    expect(await runCheck(adapters('old-laptop').byKey('tailscale:old-laptop'))).toEqual({
      status: 'down',
      detail: { error: 'old-laptop is not in the tailnet' },
    })
  })

  it('is down when tailscale itself cannot answer', async () => {
    const source = createTailscaleSource({ run: async () => { throw new Error('failed to connect to local tailscaled') } })
    const [adapter] = createTailscaleAdapters(source, parseTailscaleDevices('homelab'))
    expect(await runCheck(adapter!)).toEqual({ status: 'down', detail: { error: 'failed to connect to local tailscaled' } })
  })
})
