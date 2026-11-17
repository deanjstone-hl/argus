import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { isDeepStrictEqual } from 'node:util'

import { defaultDbPath } from './config.js'
import { directivesProblems } from './directives.js'
import { openStore, Refused } from './store.js'

/**
 * The one-off import of the AFK directives into loop-state (argus#1067): each file is the
 * directives file's front matter as JSON, `version` included, given in version order. It
 * writes to the db file directly, on the host that holds it, with no role or lease check:
 * running it is the owner's live step, and it is not an MCP tool.
 *
 *   node dist/import-directives.js [--db <path>] <front-matter.json>...
 *
 * The db is --db, else LOOP_STATE_DB, else the service's default. A version already
 * imported with the same record is skipped, so a re-run changes nothing; one at or below
 * the current version with a different record is refused. All files are checked before
 * anything is written.
 */
export function runImport(argv: string[], env: NodeJS.ProcessEnv, log: (line: string) => void, now: () => number = Date.now): number {
  let dbPath = env['LOOP_STATE_DB'] || defaultDbPath()
  const files: string[] = []
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] as string
    if (arg === '--db') {
      const value = argv[(index += 1)]
      if (!value) {
        log('usage: import-directives [--db <path>] <front-matter.json>...: --db needs a path')
        return 1
      }
      dbPath = value
    } else {
      files.push(arg)
    }
  }
  if (files.length === 0) {
    log('usage: import-directives [--db <path>] <front-matter.json>... (each file is the directives front matter as JSON, in version order)')
    return 1
  }

  const entries: { file: string; version: number; record: Record<string, unknown> }[] = []
  for (const file of files) {
    let parsed: unknown
    try {
      parsed = JSON.parse(readFileSync(file, 'utf8'))
    } catch (error) {
      log(`${file}: cannot read as JSON: ${error instanceof Error ? error.message : String(error)}`)
      return 1
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      log(`${file}: the front matter must be a JSON object`)
      return 1
    }
    const { version, ...record } = parsed as Record<string, unknown>
    if (typeof version !== 'number' || !Number.isInteger(version) || version <= 0) {
      log(`${file}: version must be a positive whole number, got ${JSON.stringify(version)}`)
      return 1
    }
    const problems = directivesProblems(record)
    if (problems.length > 0) {
      log(`${file}: not a valid directives record:\n- ${problems.join('\n- ')}`)
      return 1
    }
    entries.push({ file, version, record })
  }

  const store = openStore({ path: dbPath, now })
  try {
    const pending: { version: number; record: Record<string, unknown>; reason: string }[] = []
    for (const entry of entries) {
      const current = store.directivesRead('direction', {}).directives
      if (current && entry.version === current.version && isDeepStrictEqual(entry.record, current.record)) {
        log(`${entry.file}: already at version ${entry.version}, skipped`)
        continue
      }
      pending.push({ version: entry.version, record: entry.record, reason: `imported from the directives file, version ${entry.version}` })
    }
    if (pending.length === 0) return 0
    const result = store.directivesImport(pending)
    log(`imported version ${result.imported.join(', ')} into ${dbPath}; current version ${result.current}`)
    return 0
  } catch (error) {
    if (!(error instanceof Refused)) throw error
    log(error.message)
    return 1
  } finally {
    store.close()
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = runImport(process.argv.slice(2), process.env, console.log)
}
