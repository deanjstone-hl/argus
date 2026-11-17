import { test } from 'vitest'
import assert from 'node:assert/strict'
import {
  createAiUsageAdapter,
  createLocalHostSource,
  createRemoteHostSource,
  type CcusageOutput,
  type HostSource,
} from './ai-usage.js'

function usage(period: string, totalTokens: number, totalCost: number): CcusageOutput {
  return {
    daily: [{ period, totalTokens, totalCost }],
    totals: { totalTokens, totalCost },
  }
}

function source(name: string, fetchUsage: () => Promise<CcusageOutput>): HostSource {
  return { name, fetchUsage }
}

const NOW = new Date('2026-07-17T12:00:00Z')
const now = () => NOW

test('reports healthy with combined totals when all hosts return fresh data', async () => {
  const hosts: HostSource[] = [
    source('homelab', async () => usage('2026-07-17', 1000, 1.5)),
    source('wsl2', async () => usage('2026-07-17', 2000, 2.5)),
  ]
  const adapter = createAiUsageAdapter(hosts, { now })

  const result = await adapter.check()

  assert.equal(result.status, 'healthy')
  assert.equal(result.detail?.totalTokens, 3000)
  assert.equal(result.detail?.totalCost, 4)
  const byHost = result.detail?.hosts as Array<{ name: string; status: string }>
  assert.equal(byHost.length, 2)
  assert.ok(byHost.every((h) => h.status === 'healthy'))
})

test('reports degraded when a host has no data newer than 24h', async () => {
  const hosts: HostSource[] = [
    source('homelab', async () => usage('2026-07-17', 1000, 1.5)),
    source('windows', async () => usage('2026-07-15', 500, 0.5)),
  ]
  const adapter = createAiUsageAdapter(hosts, { now })

  const result = await adapter.check()

  assert.equal(result.status, 'degraded')
  const byHost = result.detail?.hosts as Array<{ name: string; status: string }>
  const windows = byHost.find((h) => h.name === 'windows')
  assert.equal(windows?.status, 'degraded')
})

test('reports degraded (not unreachable) when only some hosts fail to respond', async () => {
  const hosts: HostSource[] = [
    source('homelab', async () => usage('2026-07-17', 1000, 1.5)),
    source('windows', async () => {
      throw new Error('connect ECONNREFUSED')
    }),
  ]
  const adapter = createAiUsageAdapter(hosts, { now })

  const result = await adapter.check()

  assert.equal(result.status, 'degraded')
  const byHost = result.detail?.hosts as Array<{ name: string; status: string; error?: string }>
  const windows = byHost.find((h) => h.name === 'windows')
  assert.equal(windows?.status, 'unreachable')
  assert.equal(windows?.error, 'connect ECONNREFUSED')
  // combined totals only include hosts that actually reported data
  assert.equal(result.detail?.totalTokens, 1000)
})

test('reports unreachable when every host fails to respond', async () => {
  const hosts: HostSource[] = [
    source('homelab', async () => {
      throw new Error('exec failed')
    }),
    source('windows', async () => {
      throw new Error('connect ECONNREFUSED')
    }),
  ]
  const adapter = createAiUsageAdapter(hosts, { now })

  const result = await adapter.check()

  assert.equal(result.status, 'unreachable')
})

test('createRemoteHostSource fetches with a bearer token and parses the JSON body', async () => {
  const calls: Array<{ url: string; headers: Record<string, string> }> = []
  const fetchImpl = async (url: string, init: { headers: Record<string, string> }) => {
    calls.push({ url, headers: init.headers })
    return {
      ok: true,
      json: async () => usage('2026-07-17', 42, 0.1),
    } as Response
  }

  const remote = createRemoteHostSource('windows', 'http://100.64.0.3:8765/usage', 'tok123', fetchImpl)
  const result = await remote.fetchUsage()

  assert.equal(result.totals.totalTokens, 42)
  assert.equal(calls[0]?.url, 'http://100.64.0.3:8765/usage')
  assert.equal(calls[0]?.headers.Authorization, 'Bearer tok123')
})

test('createRemoteHostSource throws when the shim responds with a non-2xx status', async () => {
  const fetchImpl = async () => ({ ok: false, status: 401, json: async () => ({}) }) as Response

  const remote = createRemoteHostSource('windows', 'http://100.64.0.3:8765/usage', 'tok123', fetchImpl)

  await assert.rejects(() => remote.fetchUsage(), /401/)
})

test('createLocalHostSource parses ccusage JSON output from the injected runner', async () => {
  const local = createLocalHostSource('homelab', async () => JSON.stringify(usage('2026-07-17', 7, 0.02)))
  const result = await local.fetchUsage()

  assert.equal(result.totals.totalTokens, 7)
})
