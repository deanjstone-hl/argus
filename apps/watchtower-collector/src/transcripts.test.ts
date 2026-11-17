import { mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { claudeConfigDirs, copyRecentTranscripts, listTranscripts, newestTranscriptMtime, writeTranscriptTail } from './transcripts.js'

const HOUR_MS = 60 * 60_000

let sandbox: string

beforeEach(async () => {
  sandbox = await mkdtemp(path.join(os.tmpdir(), 'transcripts-test-'))
})

afterEach(async () => {
  await rm(sandbox, { recursive: true, force: true })
})

async function transcript(configDir: string, relativePath: string, modifiedAt: number): Promise<string> {
  const file = path.join(configDir, 'projects', relativePath)
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, '{}\n')
  await utimes(file, modifiedAt / 1000, modifiedAt / 1000)
  return file
}

async function relativeFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { recursive: true, withFileTypes: true })
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => path.relative(directory, path.join(entry.parentPath, entry.name)))
    .sort()
}

describe('claudeConfigDirs', () => {
  it('reads the two default locations ccusage reads when CLAUDE_CONFIG_DIR is unset', () => {
    expect(claudeConfigDirs({}, '/home/test')).toEqual(['/home/test/.config/claude', '/home/test/.claude'])
  })

  it('treats an empty CLAUDE_CONFIG_DIR as unset', () => {
    expect(claudeConfigDirs({ CLAUDE_CONFIG_DIR: '  ' }, '/home/test')).toEqual(['/home/test/.config/claude', '/home/test/.claude'])
  })

  it('splits a comma-separated CLAUDE_CONFIG_DIR and trims each path', () => {
    expect(claudeConfigDirs({ CLAUDE_CONFIG_DIR: '/a/claude, /b/claude ,' }, '/home/test')).toEqual(['/a/claude', '/b/claude'])
  })
})

describe('listTranscripts', () => {
  it('finds .jsonl files at any depth under projects/', async () => {
    const now = Date.now()
    const configDir = path.join(sandbox, 'cfg')
    await transcript(configDir, 'p1/a.jsonl', now)
    await transcript(configDir, 'p2/sub/b.jsonl', now)
    const found = await listTranscripts([configDir])
    expect(found.map((file) => file.relativePath).sort()).toEqual([path.join('p1', 'a.jsonl'), path.join('p2', 'sub', 'b.jsonl')])
  })

  it('skips other file types and symlinks, which ccusage does not read either', async () => {
    const now = Date.now()
    const configDir = path.join(sandbox, 'cfg')
    const real = await transcript(configDir, 'p1/a.jsonl', now)
    await writeFile(path.join(configDir, 'projects', 'p1', 'notes.txt'), 'x')
    await symlink(real, path.join(configDir, 'projects', 'p1', 'link.jsonl'))
    const found = await listTranscripts([configDir])
    expect(found.map((file) => file.relativePath)).toEqual([path.join('p1', 'a.jsonl')])
  })

  it('reports the modification time of each file', async () => {
    const modifiedAt = Date.now() - 3 * HOUR_MS
    const configDir = path.join(sandbox, 'cfg')
    await transcript(configDir, 'p1/a.jsonl', modifiedAt)
    const [file] = await listTranscripts([configDir])
    expect(Math.abs((file?.mtimeMs ?? 0) - modifiedAt)).toBeLessThan(1000)
  })

  it('accepts a path that is the projects directory itself', async () => {
    const now = Date.now()
    const configDir = path.join(sandbox, 'cfg')
    await transcript(configDir, 'p1/a.jsonl', now)
    const found = await listTranscripts([path.join(configDir, 'projects')])
    expect(found).toHaveLength(1)
  })

  it('treats a missing directory as having no transcripts', async () => {
    expect(await listTranscripts([path.join(sandbox, 'missing')])).toEqual([])
  })

  it('reads every directory it is given', async () => {
    const now = Date.now()
    await transcript(path.join(sandbox, 'one'), 'p/a.jsonl', now)
    await transcript(path.join(sandbox, 'two'), 'p/b.jsonl', now)
    expect(await listTranscripts([path.join(sandbox, 'one'), path.join(sandbox, 'two')])).toHaveLength(2)
  })
})

describe('newestTranscriptMtime', () => {
  it('returns the newest modification time across all directories', async () => {
    const now = Date.now()
    await transcript(path.join(sandbox, 'one'), 'p/old.jsonl', now - 5 * HOUR_MS)
    await transcript(path.join(sandbox, 'two'), 'p/new.jsonl', now - HOUR_MS)
    const newest = await newestTranscriptMtime([path.join(sandbox, 'one'), path.join(sandbox, 'two')])
    expect(Math.abs((newest ?? 0) - (now - HOUR_MS))).toBeLessThan(1000)
  })

  it('returns null when there are no transcripts', async () => {
    expect(await newestTranscriptMtime([path.join(sandbox, 'missing')])).toBeNull()
  })

  it('rejects when a directory cannot be read, so the caller does not mistake that for unchanged', async () => {
    const now = Date.now()
    const configDir = path.join(sandbox, 'cfg')
    await transcript(configDir, 'locked/a.jsonl', now)
    const locked = path.join(configDir, 'projects', 'locked')
    const { chmod } = await import('node:fs/promises')
    await chmod(locked, 0o000)
    try {
      await expect(newestTranscriptMtime([configDir])).rejects.toThrow()
    } finally {
      await chmod(locked, 0o700)
    }
  })
})

describe('writeTranscriptTail', () => {
  const at = (ts: number, extra = ''): string => JSON.stringify({ timestamp: new Date(ts).toISOString(), type: 'assistant', extra })
  const cutoff = Date.parse('2026-10-30T00:00:00Z')
  const MIN = 60_000

  async function trim(lines: string[], chunkBytes?: number, options: { trailingNewline?: boolean } = {}) {
    const source = path.join(sandbox, 'source.jsonl')
    const destination = path.join(sandbox, 'destination.jsonl')
    await writeFile(source, lines.join('\n') + (options.trailingNewline === false ? '' : '\n'))
    const bytesRead = await writeTranscriptTail(source, destination, cutoff, chunkBytes)
    return { kept: (await readFile(destination, 'utf8')).split('\n').filter((line) => line !== ''), bytesRead, size: (await stat(source)).size }
  }

  it('keeps the entries stamped at or after the cutoff, in order, and drops the earlier ones', async () => {
    const lines = [at(cutoff - 2 * MIN), at(cutoff - 1), at(cutoff), at(cutoff + MIN), at(cutoff + 2 * MIN)]
    expect((await trim(lines)).kept).toEqual(lines.slice(2))
  })

  it('copies a file that is entirely newer as it is', async () => {
    const lines = [at(cutoff + MIN), at(cutoff + 2 * MIN)]
    const { kept, bytesRead, size } = await trim(lines)
    expect(kept).toEqual(lines)
    expect(bytesRead).toBe(size)
  })

  it('writes an empty file when nothing is new enough', async () => {
    expect((await trim([at(cutoff - MIN), at(cutoff - 2 * MIN)])).kept).toEqual([])
  })

  it('reads the end of a long file, not all of it', async () => {
    const old = Array.from({ length: 4_000 }, (_unused, index) => at(cutoff - 10 * MIN - index * 1000, 'x'.repeat(200)))
    old.reverse()
    const fresh = [at(cutoff + MIN), at(cutoff + 2 * MIN)]
    const { kept, bytesRead, size } = await trim([...old, ...fresh], 16 * 1024)
    expect(kept).toEqual(fresh)
    expect(size).toBeGreaterThan(900_000)
    expect(bytesRead).toBeLessThanOrEqual(2 * 16 * 1024)
  })

  it('keeps a line with no timestamp that sits among the new entries', async () => {
    const summary = JSON.stringify({ type: 'summary', summary: 'compacted' })
    const lines = [at(cutoff - MIN), at(cutoff + MIN), summary, at(cutoff + 2 * MIN)]
    expect((await trim(lines)).kept).toEqual(lines.slice(1))
  })

  it('drops an older entry that sits among newer ones, so no incomplete stretch of history reaches ccusage', async () => {
    const lines = [at(cutoff + MIN), at(cutoff - 5 * MIN), at(cutoff + 2 * MIN)]
    expect((await trim(lines)).kept).toEqual([lines[0], lines[2]])
  })

  it('does not trust a timestamp inside a tool result for the entry it belongs to', async () => {
    const line = JSON.stringify({ timestamp: new Date(cutoff + MIN).toISOString(), type: 'user', message: { content: [{ type: 'tool_result', content: '{"timestamp":"2001-01-01T00:00:00Z"}' }] } })
    expect((await trim([at(cutoff - MIN), line])).kept).toEqual([line])
  })

  it('handles lines that straddle the read chunks, multi-byte characters included', async () => {
    const lines = Array.from({ length: 60 }, (_unused, index) => at(cutoff + index * MIN, `héllo 🙂 ${'ü'.repeat(index * 3)}`))
    for (const chunkBytes of [7, 64, 100, 1000]) {
      expect((await trim(lines, chunkBytes)).kept).toEqual(lines)
    }
  })

  it('handles a line longer than the chunk', async () => {
    const huge = at(cutoff + MIN, 'z'.repeat(50_000))
    const lines = [at(cutoff - MIN), huge, at(cutoff + 2 * MIN)]
    expect((await trim(lines, 4096)).kept).toEqual(lines.slice(1))
  })

  it('keeps a last line that has no newline, and a torn last line is left for ccusage to skip', async () => {
    const lines = [at(cutoff - MIN), at(cutoff + MIN), '{"timestamp":"2026-10-30T00:10:00.000Z","ty']
    expect((await trim(lines, undefined, { trailingNewline: false })).kept).toEqual(lines.slice(1))
  })

  it('writes an empty file for an empty source', async () => {
    expect((await trim([])).kept).toEqual([])
  })
})

describe('copyRecentTranscripts', () => {
  const entry = (ts: number): string => JSON.stringify({ timestamp: new Date(ts).toISOString(), type: 'assistant' })

  async function dated(configDir: string, relativePath: string, entries: number[]): Promise<string> {
    const file = path.join(configDir, 'projects', relativePath)
    await mkdir(path.dirname(file), { recursive: true })
    await writeFile(file, entries.map(entry).join('\n') + '\n')
    const newest = Math.max(...entries) / 1000
    await utimes(file, newest, newest)
    return file
  }

  it('copies the new entries of the transcripts written since the cutoff, and nothing of the others', async () => {
    const now = Date.now()
    const configDir = path.join(sandbox, 'cfg')
    await dated(configDir, 'p1/recent.jsonl', [now - 30 * HOUR_MS, now - 2 * HOUR_MS, now - HOUR_MS])
    await dated(configDir, 'p2/old.jsonl', [now - 30 * HOUR_MS])
    const scratch = path.join(sandbox, 'scratch')

    const scoped = await copyRecentTranscripts([configDir], now - 12 * HOUR_MS, { scratchDir: scratch })

    expect(scoped.copied).toBe(1)
    expect(scoped.configDirs).toHaveLength(1)
    expect(await relativeFiles(scoped.configDirs[0] ?? '')).toEqual([path.join('projects', 'p1', 'recent.jsonl')])
    const copy = await readFile(path.join(scoped.configDirs[0] ?? '', 'projects', 'p1', 'recent.jsonl'), 'utf8')
    expect(copy.split('\n').filter((line) => line !== '')).toEqual([entry(now - 2 * HOUR_MS), entry(now - HOUR_MS)])
    await scoped.cleanup()
  })

  it('reports how many bytes it read', async () => {
    const now = Date.now()
    const configDir = path.join(sandbox, 'cfg')
    const file = await dated(configDir, 'p/a.jsonl', [now - HOUR_MS])
    const scoped = await copyRecentTranscripts([configDir], now - 12 * HOUR_MS, { scratchDir: path.join(sandbox, 'scratch') })
    expect(scoped.bytesRead).toBe((await stat(file)).size)
    await scoped.cleanup()
  })

  it('makes one scoped config directory per source, so same-named files in two sources never collide', async () => {
    const now = Date.now()
    await transcript(path.join(sandbox, 'one'), 'p/a.jsonl', now)
    await transcript(path.join(sandbox, 'two'), 'p/a.jsonl', now)
    const scoped = await copyRecentTranscripts([path.join(sandbox, 'one'), path.join(sandbox, 'two')], now - HOUR_MS, {
      scratchDir: path.join(sandbox, 'scratch'),
    })
    expect(scoped.copied).toBe(2)
    expect(new Set(scoped.configDirs).size).toBe(2)
    await scoped.cleanup()
  })

  it('leaves an empty projects/ directory when nothing is recent, which ccusage reads as no usage', async () => {
    const now = Date.now()
    const configDir = path.join(sandbox, 'cfg')
    await transcript(configDir, 'p/old.jsonl', now - 30 * HOUR_MS)
    const scoped = await copyRecentTranscripts([configDir], now - 12 * HOUR_MS, { scratchDir: path.join(sandbox, 'scratch') })
    expect(scoped.copied).toBe(0)
    expect((await stat(path.join(scoped.configDirs[0] ?? '', 'projects'))).isDirectory()).toBe(true)
    await scoped.cleanup()
  })

  it('removes what it made on cleanup, and leaves the transcripts alone', async () => {
    const now = Date.now()
    const configDir = path.join(sandbox, 'cfg')
    const recent = await transcript(configDir, 'p/recent.jsonl', now)
    const scratch = path.join(sandbox, 'scratch')
    const scoped = await copyRecentTranscripts([configDir], now - HOUR_MS, { scratchDir: scratch })
    await scoped.cleanup()
    expect(await readdir(scratch)).toEqual([])
    expect((await stat(recent)).isFile()).toBe(true)
  })

  it('cleans up and rethrows when a copy fails, so the caller can read everything instead', async () => {
    const now = Date.now()
    const configDir = path.join(sandbox, 'cfg')
    await transcript(configDir, 'p/recent.jsonl', now)
    const scratch = path.join(sandbox, 'scratch')
    const diskFull = Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' })
    await expect(
      copyRecentTranscripts([configDir], now - HOUR_MS, {
        scratchDir: scratch,
        writeTail: async () => {
          throw diskFull
        },
      }),
    ).rejects.toBe(diskFull)
    expect(await readdir(scratch)).toEqual([])
  })

  it('sweeps scoped directories a killed collector left behind, but not a fresh one', async () => {
    const now = Date.now()
    const scratch = path.join(sandbox, 'scratch')
    const abandoned = path.join(scratch, 'ccusage-recent-abandoned')
    const inFlight = path.join(scratch, 'ccusage-recent-inflight')
    const unrelated = path.join(scratch, 'keep-me')
    await Promise.all([mkdir(abandoned, { recursive: true }), mkdir(inFlight, { recursive: true }), mkdir(unrelated, { recursive: true })])
    const twoHoursAgo = (now - 2 * HOUR_MS) / 1000
    await Promise.all([utimes(abandoned, twoHoursAgo, twoHoursAgo), utimes(unrelated, twoHoursAgo, twoHoursAgo)])

    const configDir = path.join(sandbox, 'cfg')
    await transcript(configDir, 'p/a.jsonl', now)
    const scoped = await copyRecentTranscripts([configDir], now - HOUR_MS, { scratchDir: scratch, now: () => now })

    const left = await readdir(scratch)
    expect(left).toContain('ccusage-recent-inflight')
    expect(left).toContain('keep-me')
    expect(left).not.toContain('ccusage-recent-abandoned')
    await scoped.cleanup()
  })
})
