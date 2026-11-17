import { execFile } from 'node:child_process'
import { stat } from 'node:fs/promises'
import { basename } from 'node:path'
import { promisify } from 'node:util'
import type { VaultSyncDetail, VaultSyncReport } from '@argus/watchtower-contract'
import { CheckError, type Adapter, type HealthResult } from './adapter.js'

const execFileAsync = promisify(execFile)

// The vault-sync cards run argus-config's hooks/vault-staleness.sh, the very
// check behind the session-start `Vault sync:` line, rather than a second
// copy of its rules: unpublished commits older than 4 hours, or a remote that
// has moved while this clone stopped fetching. The hook prints nothing for a
// healthy vault. It reads git only and writes nothing.

export interface Vault {
  name: string
  path: string
}

export interface VaultSyncDeps {
  hookPath: string
  isCheckout: (dir: string) => Promise<boolean>
  runHook: (hookPath: string, dir: string) => Promise<string>
}

export function defaultVaultSyncDeps(hookPath: string): VaultSyncDeps {
  return {
    hookPath,
    isCheckout: async (dir) => {
      try {
        return (await stat(`${dir}/.git`)).isDirectory()
      } catch {
        return false
      }
    },
    // One vault per run, so each card hears only about its own.
    runHook: async (hook, dir) =>
      (await execFileAsync('bash', [hook], { env: { ...process.env, VAULT_STALENESS_DIRS: dir }, timeout: 30_000 })).stdout,
  }
}

export function parseVaultList(value: string): Vault[] {
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((path) => ({ name: basename(path), path }))
}

export async function runVaultSyncCheck(vault: Vault, deps: VaultSyncDeps): Promise<VaultSyncReport> {
  const base = { name: vault.name, path: vault.path }
  if (!(await deps.isCheckout(vault.path))) return { ...base, checkout: false, lines: [], error: null }
  try {
    const output = await deps.runHook(deps.hookPath, vault.path)
    const lines = output.split('\n').map((line) => line.trim()).filter(Boolean)
    return { ...base, checkout: true, lines, error: null }
  } catch (error) {
    return { ...base, checkout: true, lines: [], error: error instanceof Error ? error.message : String(error) }
  }
}

export function evaluateVaultSync(report: VaultSyncReport): HealthResult {
  if (report.error !== null) throw new CheckError('degraded', `vault-staleness.sh could not run: ${report.error}`)
  const detail: VaultSyncDetail = { vault: report.name, path: report.path, checkout: report.checkout, lines: report.lines }
  return { status: report.checkout && report.lines.length === 0 ? 'healthy' : 'degraded', detail }
}

export function createVaultSyncAdapters(
  host: string,
  names: string[],
  read: (name: string) => Promise<VaultSyncReport | undefined>,
  failureStatus?: Adapter['failureStatus'],
): Adapter[] {
  return names.map((name) => ({
    key: `${host}:vault:${name}`,
    host,
    intervalMs: 300_000,
    ...(failureStatus ? { failureStatus } : {}),
    check: async () => {
      const report = await read(name)
      if (!report) throw new CheckError('degraded', `${name} is not in the vault-sync report`)
      return evaluateVaultSync(report)
    },
  }))
}
