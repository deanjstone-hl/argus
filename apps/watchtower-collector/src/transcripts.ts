import { mkdir, mkdtemp, open, readdir, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

// The Claude Code transcripts ccusage reads, found without reading them. A directory walk and one
// stat per file touch inodes, not file contents: on homelab that is ~800 stats against 613 MB of
// transcripts (argus#949).

export interface Transcript {
  absolutePath: string
  // Path below the projects directory, kept so a copy lands where ccusage expects it.
  relativePath: string
  mtimeMs: number
  // The entry in the caller's list this file came from.
  sourceIndex: number
}

// ccusage's own lookup: CLAUDE_CONFIG_DIR as a comma-separated list, else these two.
export function claudeConfigDirs(env: NodeJS.ProcessEnv = process.env, home: string = os.homedir()): string[] {
  const configured = (env.CLAUDE_CONFIG_DIR ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '')
  return configured.length > 0 ? configured : [path.join(home, '.config', 'claude'), path.join(home, '.claude')]
}

function isMissing(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code
  return code === 'ENOENT' || code === 'ENOTDIR'
}

async function isDirectory(candidate: string): Promise<boolean> {
  try {
    return (await stat(candidate)).isDirectory()
  } catch (error) {
    if (isMissing(error)) return false
    throw error
  }
}

// Each path is either a config directory holding projects/, or the projects directory itself.
async function projectsDirectory(configDir: string): Promise<string | null> {
  const nested = path.join(configDir, 'projects')
  if (await isDirectory(nested)) return nested
  if (path.basename(configDir) === 'projects' && (await isDirectory(configDir))) return configDir
  return null
}

async function walk(directory: string, relativeDirectory: string, found: Array<{ absolutePath: string; relativePath: string }>): Promise<void> {
  const entries = await readdir(directory, { withFileTypes: true })
  for (const entry of entries) {
    const relativePath = path.join(relativeDirectory, entry.name)
    if (entry.isDirectory()) await walk(path.join(directory, entry.name), relativePath, found)
    // Symlinks are skipped: ccusage does not follow them, so they add nothing to a scan.
    else if (entry.isFile() && entry.name.endsWith('.jsonl')) found.push({ absolutePath: path.join(directory, entry.name), relativePath })
  }
}

const STAT_BATCH = 64

// A directory that cannot be read rejects rather than reading as empty: the caller compares the
// result with the last scan, and a partial list could only ever look unchanged.
export async function listTranscripts(configDirs: string[]): Promise<Transcript[]> {
  const transcripts: Transcript[] = []
  for (const [sourceIndex, configDir] of configDirs.entries()) {
    const projects = await projectsDirectory(configDir)
    if (projects === null) continue
    const files: Array<{ absolutePath: string; relativePath: string }> = []
    await walk(projects, '', files)
    for (let start = 0; start < files.length; start += STAT_BATCH) {
      const batch = files.slice(start, start + STAT_BATCH)
      const stats = await Promise.all(batch.map((file) => stat(file.absolutePath)))
      batch.forEach((file, index) => transcripts.push({ ...file, mtimeMs: stats[index]?.mtimeMs ?? 0, sourceIndex }))
    }
  }
  return transcripts
}

export async function newestTranscriptMtime(configDirs: string[]): Promise<number | null> {
  const transcripts = await listTranscripts(configDirs)
  return transcripts.reduce<number | null>((newest, file) => (newest === null || file.mtimeMs > newest ? file.mtimeMs : newest), null)
}

export interface RecentTranscripts {
  // Config directories to hand ccusage in CLAUDE_CONFIG_DIR, one per source.
  configDirs: string[]
  copied: number
  // Bytes read from the transcripts to build the view.
  bytesRead: number
  cleanup: () => Promise<void>
}

const CHUNK_BYTES = 256 * 1024
const NEWLINE = 0x0a

// The `timestamp` of the entry on this line, or null for a line that is not an entry (a summary, a
// torn write). Parsed, not matched: a tool result can carry a timestamp of its own.
function entryTimestamp(line: Buffer): number | null {
  try {
    const parsed = JSON.parse(line.toString('utf8')) as { timestamp?: unknown }
    if (typeof parsed.timestamp !== 'string') return null
    const stamped = Date.parse(parsed.timestamp)
    return Number.isNaN(stamped) ? null : stamped
  } catch {
    return null
  }
}

// Writes the entries of `source` stamped at or after `cutoffMs` to `destination`, reading the
// file from the end. Claude Code appends an entry when it happens, so everything before the first
// stretch of older entries is older too and is never read. A line with no timestamp (a summary, a
// line cut short by a write in flight) is kept: ccusage skips it either way. Returns the bytes read.
//
// The one assumption is that a file is in time order to within one chunk. An entry out of order by
// more than that, older than the cutoff but written after newer ones, would be read; one that was
// newer but written before an older stretch would be missed.
export async function writeTranscriptTail(source: string, destination: string, cutoffMs: number, chunkBytes: number = CHUNK_BYTES): Promise<number> {
  const handle = await open(source, 'r')
  const kept: Buffer[][] = []
  let bytesRead = 0
  try {
    let position = (await handle.stat()).size
    // The start of a line whose beginning is in an earlier chunk.
    let partial: Buffer = Buffer.alloc(0)
    let exhausted = false
    while (position > 0 && !exhausted) {
      const length = Math.min(chunkBytes, position)
      position -= length
      const chunk = Buffer.alloc(length)
      const { bytesRead: got } = await handle.read(chunk, 0, length, position)
      bytesRead += got
      const block = Buffer.concat([chunk.subarray(0, got), partial])
      const firstBreak = position === 0 ? -1 : block.indexOf(NEWLINE)
      if (position > 0 && firstBreak === -1) {
        partial = block
        continue
      }
      partial = position === 0 ? Buffer.alloc(0) : block.subarray(0, firstBreak)
      const lines = splitLines(block.subarray(position === 0 ? 0 : firstBreak + 1))
      const chunkKept: Buffer[] = []
      let sawOlder = false
      let sawNewer = false
      for (const line of lines) {
        const stamped = entryTimestamp(line)
        if (stamped === null) chunkKept.push(line)
        else if (stamped >= cutoffMs) {
          sawNewer = true
          chunkKept.push(line)
        } else sawOlder = true
      }
      kept.push(chunkKept)
      exhausted = sawOlder && !sawNewer
    }
  } finally {
    await handle.close()
  }
  const lines = kept.reverse().flat()
  await writeFile(destination, lines.length === 0 ? '' : Buffer.concat(lines.flatMap((line) => [line, Buffer.from('\n')])))
  return bytesRead
}

function splitLines(block: Buffer): Buffer[] {
  const lines: Buffer[] = []
  let start = 0
  for (let end = block.indexOf(NEWLINE); end !== -1; end = block.indexOf(NEWLINE, start)) {
    if (end > start) lines.push(block.subarray(start, end))
    start = end + 1
  }
  if (start < block.length) lines.push(block.subarray(start))
  return lines
}

export interface CopyRecentOptions {
  scratchDir: string
  writeTail?: (source: string, destination: string, cutoffMs: number) => Promise<number>
  now?: () => number
}

const SCOPED_DIRECTORY_PREFIX = 'ccusage-recent-'
// A scan takes minutes even on a saturated disk; an hour-old directory belongs to a collector
// that was killed mid-scan.
const ABANDONED_AFTER_MS = 60 * 60_000

async function sweepAbandoned(scratchDir: string, now: number): Promise<void> {
  for (const name of await readdir(scratchDir)) {
    if (!name.startsWith(SCOPED_DIRECTORY_PREFIX)) continue
    const candidate = path.join(scratchDir, name)
    const modifiedAt = (await stat(candidate)).mtimeMs
    if (now - modifiedAt >= ABANDONED_AFTER_MS) await rm(candidate, { recursive: true, force: true })
  }
}

// A scoped view of the transcripts for ccusage: for each one written since `cutoffMs`, a copy of
// its entries stamped at or after it. A transcript last written before the cutoff holds no such
// entry (a file's modification time is at or after its newest entry) and is left out. ccusage
// reads whatever it is given in full, so the bytes it reads are those of the copies, and the
// copies are built from the end of each transcript. A failed copy rejects so the caller can fall
// back to a full scan.
export async function copyRecentTranscripts(configDirs: string[], cutoffMs: number, options: CopyRecentOptions): Promise<RecentTranscripts> {
  const writeTail = options.writeTail ?? writeTranscriptTail
  await mkdir(options.scratchDir, { recursive: true })
  await sweepAbandoned(options.scratchDir, (options.now ?? Date.now)())
  const root = await mkdtemp(path.join(options.scratchDir, SCOPED_DIRECTORY_PREFIX))
  const cleanup = () => rm(root, { recursive: true, force: true })

  try {
    const scopedDirs = await Promise.all(
      configDirs.map(async (_configDir, index) => {
        const scopedDir = path.join(root, String(index))
        await mkdir(path.join(scopedDir, 'projects'), { recursive: true })
        return scopedDir
      }),
    )
    const recent = (await listTranscripts(configDirs)).filter((file) => file.mtimeMs >= cutoffMs)
    let bytesRead = 0
    for (const file of recent) {
      const target = path.join(scopedDirs[file.sourceIndex] ?? root, 'projects', file.relativePath)
      await mkdir(path.dirname(target), { recursive: true })
      bytesRead += await writeTail(file.absolutePath, target, cutoffMs)
    }
    return { configDirs: scopedDirs, copied: recent.length, bytesRead, cleanup }
  } catch (error) {
    await cleanup()
    throw error
  }
}
