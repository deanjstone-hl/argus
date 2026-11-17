import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { runCheck } from '../poller.js'
import { createDiskAdapter, type DiskStats } from './disk.js'

vi.mock('../record-check.js', () => ({ recordCheck: vi.fn() }))

// homelab, 2026-10-17: `stat -f` on each mount. `df --output=pcent` read
// 82% for / and 92% for /mnt/backups at the same moment.
const fixtures: Record<string, DiskStats> = JSON.parse(
  readFileSync(new URL('../__fixtures__/homelab-statfs.json', import.meta.url), 'utf8'),
)

async function statfs(path: string): Promise<DiskStats> {
  const stats = fixtures[path]
  if (!stats) throw new Error(`ENOENT: ${path}`)
  return stats
}

describe('homelab disk adapter', () => {
  it('keys the check by its mount path', () => {
    expect(createDiskAdapter('/mnt/backups', { statfs }).key).toBe('homelab:disk:/mnt/backups')
    expect(createDiskAdapter('/', { statfs }).host).toBe('homelab')
  })

  it('matches df on the root filesystem', async () => {
    expect(await runCheck(createDiskAdapter('/', { statfs }))).toEqual({
      status: 'healthy',
      detail: { path: '/', pctUsed: 82 },
    })
  })

  // ext4 reserves blocks for root: they count in bfree but not in bavail,
  // so (blocks - bfree) / blocks read 87% here while df read 92%.
  it('leaves root-reserved blocks out, as df does, and is degraded at 92%', async () => {
    expect(await runCheck(createDiskAdapter('/mnt/backups', { statfs }))).toEqual({
      status: 'degraded',
      detail: { path: '/mnt/backups', pctUsed: 92 },
    })
  })

  it('rounds up like df, so a nearly-full disk never reads as below the line', async () => {
    const stats = async (): Promise<DiskStats> => ({ bsize: 4096, blocks: 1000, bfree: 108, bavail: 108 })
    expect((await runCheck(createDiskAdapter('/', { statfs: stats }))).detail).toEqual({ path: '/', pctUsed: 90 })
  })
})
