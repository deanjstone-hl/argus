import { statfs as nodeStatfs } from 'node:fs/promises'
import type { Adapter, HealthResult } from '../adapter.js'

const DEGRADED_THRESHOLD_PCT = 90

export interface DiskStats {
  bsize: number
  blocks: number
  bfree: number
  bavail: number
}

export interface DiskOptions {
  intervalMs?: number
  statfs?: (path: string) => Promise<DiskStats>
}

// Computed as df does: used / (used + avail). bfree counts ext4's
// root-reserved blocks, which a non-root writer cannot use, so measuring
// against blocks or bfree reads several points low on a nearly-full disk.
// df rounds up, and so does this, so the card and df agree exactly.
async function checkDisk(path: string, statfs: (path: string) => Promise<DiskStats>): Promise<HealthResult> {
  const stats = await statfs(path)
  const usedBlocks = stats.blocks - stats.bfree
  const pctUsed = Math.ceil((usedBlocks / (usedBlocks + stats.bavail)) * 100)

  return {
    status: pctUsed >= DEGRADED_THRESHOLD_PCT ? 'degraded' : 'healthy',
    detail: { path, pctUsed },
  }
}

export function createDiskAdapter(path = '/', options: DiskOptions = {}): Adapter {
  const { intervalMs = 300_000, statfs = nodeStatfs } = options
  return {
    key: `homelab:disk:${path}`,
    host: 'homelab',
    intervalMs,
    check: () => checkDisk(path, statfs),
  }
}
