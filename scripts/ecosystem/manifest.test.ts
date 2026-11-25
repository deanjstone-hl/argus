import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import { parseManifest } from './manifest.ts'

const entry = (overrides: Record<string, unknown> = {}) => ({ name: 'Shell', description: 'Auth and launchpad', category: 'app', ...overrides })
const manifest = (entries: unknown[] = [entry()], version: unknown = 1) => ({ version, entries })

function errors(input: unknown): string[] {
  const result = parseManifest(input)
  if (result.ok) throw new Error('expected the manifest to be refused')
  return result.errors
}

describe('parseManifest', () => {
  it('accepts a full entry and returns it unchanged', () => {
    const full = entry({ href: 'https://myargus.cc/', status: 'live', tags: ['myargus.cc'], connects: ['Budget'] })
    const input = manifest([full, entry({ name: 'Budget' })])
    const result = parseManifest(input)
    expect(result).toEqual({ ok: true, manifest: input })
  })

  it('refuses anything that is not a version 1 manifest', () => {
    expect(errors(null)).toEqual(['the manifest must be an object'])
    expect(errors({ entries: [] })).toContain('version must be 1')
    expect(errors(manifest([entry()], 2))).toContain('version must be 1')
    expect(errors({ version: 1, entries: 'x' })).toContain('entries must be an array')
    expect(errors(manifest([]))).toContain('entries must not be empty')
  })

  it('refuses an entry with a missing or mistyped field, naming it', () => {
    expect(errors(manifest([entry({ name: '' })]))).toContain('entries[0].name must be a non-empty string')
    expect(errors(manifest([entry({ description: 3 })]))).toContain('entries[0].description must be a string')
    expect(errors(manifest([entry({ category: 'tool' })]))).toContain('entries[0].category must be one of app, project, skill')
    expect(errors(manifest([entry({ status: 'dead' })]))).toContain('entries[0].status must be one of live, active, scaffold, archived')
    expect(errors(manifest([entry({ tags: ['a', 2] })]))).toContain('entries[0].tags must be an array of strings')
    expect(errors(manifest([entry({ connects: 'x' })]))).toContain('entries[0].connects must be an array of strings')
    expect(errors(manifest(['x']))).toContain('entries[0] must be an object')
  })

  it('refuses an href that is not an http(s) URL', () => {
    expect(errors(manifest([entry({ href: 'javascript:alert(1)' })]))).toContain('entries[0].href must be an http(s) URL')
    expect(errors(manifest([entry({ href: '/reader/' })]))).toContain('entries[0].href must be an http(s) URL')
  })

  it('refuses duplicate names and edges to an entry that does not exist', () => {
    expect(errors(manifest([entry(), entry()]))).toContain('entries[1].name "Shell" is already used')
    expect(errors(manifest([entry({ connects: ['Ghost'] })]))).toContain('entries[0].connects names "Ghost", which is not an entry')
  })

  it('reports every problem at once', () => {
    expect(errors(manifest([entry({ name: '', category: 'x' }), entry({ status: 'y' })])).length).toBeGreaterThanOrEqual(3)
  })
})

describe('ecosystem/manifest.json', () => {
  const file = JSON.parse(readFileSync(new URL('../../ecosystem/manifest.json', import.meta.url), 'utf8')) as unknown

  it('is a valid manifest: unique names, known categories, every edge pointing at an entry', () => {
    const result = parseManifest(file)
    expect(result.ok ? [] : result.errors).toEqual([])
  })

  it('no longer carries the facts the shell had gone stale on', () => {
    const names = (file as { entries: { name: string }[] }).entries.map((e) => e.name)
    expect(names).not.toContain('ccbot')
    expect(names).not.toContain('vault-agent')
    expect(names).not.toContain('mcp-memory')
    expect(names).not.toContain('context-ingest / context-search')
    expect(JSON.stringify(file)).not.toContain('knowledge.myargus.cc')
    for (const current of ['Ops hub', 'Watchtower', 'Email inbox', 'wiki', 'frontend', 'slate-reader', 'Briefings', 'memory-mcp']) expect(names).toContain(current)
  })
})
