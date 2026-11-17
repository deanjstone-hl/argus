import { readFile } from 'node:fs/promises'
import type { Adapter, HealthResult } from '../adapter.js'

async function checkUptime(): Promise<HealthResult> {
  const raw = await readFile('/proc/uptime', 'utf8')
  const uptimeSeconds = Math.round(Number(raw.split(' ')[0]))

  return { status: 'healthy', detail: { uptimeSeconds } }
}

export function createUptimeAdapter(intervalMs = 300_000): Adapter {
  return {
    key: 'homelab:uptime',
    host: 'homelab',
    intervalMs,
    check: checkUptime,
  }
}
