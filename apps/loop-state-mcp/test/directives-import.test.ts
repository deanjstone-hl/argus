import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { runImport } from '../src/import-directives.js'
import { openStore } from '../src/store.js'
import { tempDbPath, testClock } from './helpers.js'

// argus#1067: the one-off import seeds the record from the directives file's front matter
// (as JSON), keeping the file's version, with no owner or lease check: the owner runs it on
// the host, and it is not an MCP tool.

const FIXTURE = new URL('./fixtures/directives-v20.json', import.meta.url).pathname

const scratch = () => mkdtempSync(join(tmpdir(), 'directives-import-'))
const writeJson = (value: unknown) => {
  const path = join(scratch(), 'record.json')
  writeFileSync(path, JSON.stringify(value))
  return path
}

describe('runImport', () => {
  it('seeds the record at the version the file carries and labels it an import', () => {
    const db = tempDbPath()
    const log: string[] = []
    const code = runImport(['--db', db, FIXTURE], {}, (line) => log.push(line), testClock().now)
    expect(code).toBe(0)
    expect(log.join('\n')).toMatch(/imported version 20/)

    const store = openStore({ path: db })
    const read = store.directivesRead('direction', {})
    expect(read.directives).toMatchObject({ version: 20, source: 'import', set_by: null })
    expect(read.directives?.record).toMatchObject({ max_slots: 2, host_caps: { homelab: 1, wsl2: 2 } })
    expect(read.directives?.record).not.toHaveProperty('version')
    store.close()
  })

  it('is a no-op when the same version is already imported, so a re-run is safe', () => {
    const db = tempDbPath()
    runImport(['--db', db, FIXTURE], {}, () => {}, testClock().now)
    const log: string[] = []
    expect(runImport(['--db', db, FIXTURE], {}, (line) => log.push(line), testClock().now)).toBe(0)
    expect(log.join('\n')).toMatch(/already at version 20/)

    const store = openStore({ path: db })
    expect(store.directivesRead('direction', { history: true }).history).toHaveLength(1)
    store.close()
  })

  it('refuses to go backwards past a newer record, leaving it alone', () => {
    const db = tempDbPath()
    const newer = writeJson({ version: 21, cadence_minutes: 30, max_slots: 1, repo_holds: [], take_next: [], ordering: [] })
    runImport(['--db', db, newer], {}, () => {}, testClock().now)
    const log: string[] = []
    expect(runImport(['--db', db, FIXTURE], {}, (line) => log.push(line), testClock().now)).toBe(1)
    expect(log.join('\n')).toMatch(/version 20 is not above the current 21/)

    const store = openStore({ path: db })
    expect(store.directivesRead('direction', {}).directives?.version).toBe(21)
    store.close()
  })

  it('imports several versions in order, building history', () => {
    const db = tempDbPath()
    const v21 = writeJson({ version: 21, cadence_minutes: 30, max_slots: 1, repo_holds: [], take_next: [], ordering: [] })
    expect(runImport(['--db', db, FIXTURE, v21], {}, () => {}, testClock().now)).toBe(0)

    const store = openStore({ path: db })
    expect(store.directivesRead('direction', { history: true }).history?.map((entry) => entry.version)).toEqual([21, 20])
    store.close()
  })

  it('refuses a file with no version, naming the file', () => {
    const db = tempDbPath()
    const path = writeJson({ cadence_minutes: 30, max_slots: 1, repo_holds: [], take_next: [], ordering: [] })
    const log: string[] = []
    expect(runImport(['--db', db, path], {}, (line) => log.push(line), testClock().now)).toBe(1)
    expect(log.join('\n')).toContain(path)
    expect(log.join('\n')).toMatch(/version/)
  })

  it('refuses an invalid record and writes nothing, even from an earlier valid file', () => {
    const db = tempDbPath()
    const bad = writeJson({ version: 21, max_slots: 0 })
    const log: string[] = []
    expect(runImport(['--db', db, FIXTURE, bad], {}, (line) => log.push(line), testClock().now)).toBe(1)
    expect(log.join('\n')).toMatch(/missing key/)

    const store = openStore({ path: db })
    expect(store.directivesRead('direction', {}).directives).toBeNull()
    store.close()
  })

  it('takes the db path from LOOP_STATE_DB when --db is not given', () => {
    const db = tempDbPath()
    expect(runImport([FIXTURE], { LOOP_STATE_DB: db }, () => {}, testClock().now)).toBe(0)
    const store = openStore({ path: db })
    expect(store.directivesRead('direction', {}).directives?.version).toBe(20)
    store.close()
  })

  it('says how to use it when given no files', () => {
    const log: string[] = []
    expect(runImport([], {}, (line) => log.push(line), testClock().now)).toBe(1)
    expect(log.join('\n')).toMatch(/usage/i)
  })
})
