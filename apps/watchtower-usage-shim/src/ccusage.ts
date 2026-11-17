import { execFile } from 'node:child_process'
import { createRequire } from 'node:module'
import path from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const require = createRequire(import.meta.url)

// ccusage is a real dependency, pinned in package.json where the lockfile enforces it, not
// an `npx --yes ccusage@<version>` shell-out: an unpinned release would silently change the
// shim's output shape underneath the collector, and npx re-resolved the package on every
// poll. Same approach as the collector's own ccusage module.
let cachedBin: string | undefined

export function resolveCcusageBin(): string {
  if (cachedBin) return cachedBin
  const manifestPath = require.resolve('ccusage/package.json')
  const manifest = require('ccusage/package.json') as { bin?: string | Record<string, string> }
  const entry = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin?.ccusage
  if (!entry) throw new Error('ccusage package.json declares no `ccusage` bin entry')
  cachedBin = path.join(path.dirname(manifestPath), entry)
  return cachedBin
}

export async function runCcusage(args: string[] = ['--json']): Promise<string> {
  // Spawn through process.execPath rather than the bin shim: the shim runs as a systemd
  // --user unit, where the fnm-managed node is not on the inherited PATH.
  const { stdout } = await execFileAsync(process.execPath, [resolveCcusageBin(), ...args], {
    maxBuffer: 10 * 1024 * 1024,
  })
  return stdout
}
