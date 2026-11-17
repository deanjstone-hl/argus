import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { runCheck } from './poller.js'
import { createVaultSyncAdapters, evaluateVaultSync, parseVaultList, runVaultSyncCheck, type VaultSyncDeps } from './vault-sync.js'

vi.mock('./record-check.js', () => ({ recordCheck: vi.fn() }))

// What argus-config's hooks/vault-staleness.sh really printed, 2026-10-16, run
// on a scratch CONTEXT clone holding three commits from 05:00 UTC its origin
// never received.
const UNPUBLISHED = readFileSync(new URL('./__fixtures__/vault-staleness-unpublished.txt', import.meta.url), 'utf8')
const HOOK = '/home/srvr/.argus/hooks/vault-staleness.sh'

function deps(output: string, overrides: Partial<VaultSyncDeps> = {}) {
  const runs: Array<{ hook: string; dir: string }> = []
  const value: VaultSyncDeps = {
    hookPath: HOOK,
    isCheckout: async () => true,
    runHook: async (hook, dir) => {
      runs.push({ hook, dir })
      return output
    },
    ...overrides,
  }
  return { deps: value, runs }
}

describe('parseVaultList', () => {
  it('names each vault by its directory', () => {
    expect(parseVaultList('/home/srvr/CONTEXT, /home/srvr/CORTEX')).toEqual([
      { name: 'CONTEXT', path: '/home/srvr/CONTEXT' },
      { name: 'CORTEX', path: '/home/srvr/CORTEX' },
    ])
  })
})

describe('runVaultSyncCheck', () => {
  it('runs the session-start hook for one vault and keeps the lines it prints', async () => {
    const { deps: value, runs } = deps(UNPUBLISHED)
    const report = await runVaultSyncCheck({ name: 'CONTEXT', path: '/home/srvr/CONTEXT' }, value)
    expect(runs).toEqual([{ hook: HOOK, dir: '/home/srvr/CONTEXT' }])
    expect(report).toEqual({
      name: 'CONTEXT',
      path: '/home/srvr/CONTEXT',
      checkout: true,
      lines: [UNPUBLISHED.trim()],
      error: null,
    })
  })

  it('reports a hook that cannot run, rather than calling the vault fine', async () => {
    const { deps: value } = deps('', { runHook: async () => { throw new Error(`bash: ${HOOK}: No such file or directory`) } })
    const report = await runVaultSyncCheck({ name: 'CORTEX', path: '/home/srvr/CORTEX' }, value)
    expect(report.error).toMatch(/No such file/)
  })

  it('does not run the hook on a directory that is not a checkout', async () => {
    const { deps: value, runs } = deps('', { isCheckout: async () => false })
    const report = await runVaultSyncCheck({ name: 'CORTEX', path: '/home/srvr/CORTEX' }, value)
    expect(runs).toEqual([])
    expect(report.checkout).toBe(false)
  })
})

describe('evaluateVaultSync', () => {
  const base = { name: 'CONTEXT', path: '/home/deanj/CONTEXT', checkout: true, lines: [], error: null }

  it('is healthy when the hook prints nothing', () => {
    expect(evaluateVaultSync(base)).toEqual({
      status: 'healthy',
      detail: { vault: 'CONTEXT', path: '/home/deanj/CONTEXT', checkout: true, lines: [] },
    })
  })

  it('is degraded with the hook’s own words when publishing has stopped', () => {
    const result = evaluateVaultSync({ ...base, lines: [UNPUBLISHED.trim()] })
    expect(result.status).toBe('degraded')
    expect(result.detail).toMatchObject({ lines: [UNPUBLISHED.trim()] })
  })

  it('is degraded when the vault is not a git checkout', () => {
    expect(evaluateVaultSync({ ...base, checkout: false }).status).toBe('degraded')
  })

  it('throws a degraded error when the hook could not run', () => {
    expect(() => evaluateVaultSync({ ...base, error: 'hook missing' })).toThrow(/vault-staleness.sh could not run: hook missing/)
  })
})

describe('createVaultSyncAdapters', () => {
  it('makes one <host>:vault:<name> card per vault', async () => {
    const reports = {
      CONTEXT: { name: 'CONTEXT', path: '/p/CONTEXT', checkout: true, lines: [UNPUBLISHED.trim()], error: null },
      CORTEX: { name: 'CORTEX', path: '/p/CORTEX', checkout: true, lines: [], error: null },
    }
    const list = createVaultSyncAdapters('homelab', ['CONTEXT', 'CORTEX'], async (name) => reports[name as keyof typeof reports])
    expect(list.map((adapter) => [adapter.key, adapter.host, adapter.intervalMs])).toEqual([
      ['homelab:vault:CONTEXT', 'homelab', 300_000],
      ['homelab:vault:CORTEX', 'homelab', 300_000],
    ])
    expect((await runCheck(list[0]!)).status).toBe('degraded')
    expect((await runCheck(list[1]!)).status).toBe('healthy')
  })

  it('is degraded for a vault the report does not carry', async () => {
    const [adapter] = createVaultSyncAdapters('lnv-lgn5', ['CONTEXT'], async () => undefined)
    const result = await runCheck(adapter!)
    expect(result.status).toBe('degraded')
    expect(result.detail).toEqual({ error: 'CONTEXT is not in the vault-sync report' })
  })
})
