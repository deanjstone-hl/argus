import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { Adapter, HealthResult } from '../adapter.js'
import { evaluateUnit, parseProperties, UNIT_PROPERTIES, type UnitScope } from '../systemd-unit.js'

const execFileAsync = promisify(execFile)

export interface SystemdUnit {
  unit: string
  scope: UnitScope
}

export type RunSystemctl = (args: string[]) => Promise<string>

export interface SystemdOptions {
  run?: RunSystemctl
  intervalMs?: number
}

// TZ=UTC: systemctl prints every time in the local zone (see parseSystemdTime).
export const runSystemctl: RunSystemctl = async (args) => {
  const { stdout } = await execFileAsync('systemctl', args, { env: { ...process.env, TZ: 'UTC' } })
  return stdout
}

// SYSTEMD_UNITS: comma-separated, user units bare, system units as
// `system:<unit>` (cloudflared, tailscaled… run as system services).
export function parseUnitList(value: string | undefined): SystemdUnit[] {
  return (value ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) =>
      entry.startsWith('system:') ? { unit: entry.slice('system:'.length), scope: 'system' } : { unit: entry, scope: 'user' },
    )
}

async function show(run: RunSystemctl, { unit, scope }: SystemdUnit): Promise<Record<string, string>> {
  const args = ['show', unit, `--property=${UNIT_PROPERTIES.join(',')}`]
  return parseProperties(await run(scope === 'user' ? ['--user', ...args] : args))
}

async function checkSystemdUnit(run: RunSystemctl, target: SystemdUnit): Promise<HealthResult> {
  const unit = await show(run, target)
  // A timer is only as healthy as the run it last triggered.
  const triggers = target.unit.endsWith('.timer') && unit.Unit ? await show(run, { unit: unit.Unit, scope: target.scope }) : undefined
  return evaluateUnit(target.scope, unit, triggers)
}

export function createSystemdAdapter(target: SystemdUnit, options: SystemdOptions = {}): Adapter {
  const run = options.run ?? runSystemctl
  return {
    key: `systemd:${target.unit}`,
    host: 'homelab',
    intervalMs: options.intervalMs ?? 30_000,
    check: () => checkSystemdUnit(run, target),
  }
}
