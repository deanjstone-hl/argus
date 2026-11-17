import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import type { Manifest } from './manifest.ts'
import { parseManifest } from './manifest.ts'
import { firstSentence, formatManifest, readSkills, reconcileSkills } from './skills.ts'

const skill = (name: string, description = `${name} does a thing.`) => ({ name, description })
const entry = (name: string, extra: Record<string, unknown> = {}) => ({ name, description: `${name} (hand-written)`, category: 'skill' as const, ...extra })
const manifest = (...entries: ReturnType<typeof entry>[]): Manifest => ({ version: 1, entries: [{ name: 'Shell', description: 'App', category: 'app' }, ...entries] })

describe('firstSentence', () => {
  it('cuts at the first full stop and keeps short text whole', () => {
    expect(firstSentence('Write an ADR. Use for "add an ADR".')).toBe('Write an ADR')
    expect(firstSentence('No full stop here')).toBe('No full stop here')
  })

  it('cuts a long sentence at a word boundary with an ellipsis', () => {
    const cut = firstSentence(`${'word '.repeat(60)}end.`)
    expect(cut.length).toBeLessThanOrEqual(120)
    expect(cut.endsWith('…')).toBe(true)
  })
})

describe('readSkills', () => {
  const root = mkdtempSync(join(tmpdir(), 'skills-'))
  const write = (dir: string, frontmatter: string) => {
    mkdirSync(join(root, dir), { recursive: true })
    writeFileSync(join(root, dir, 'SKILL.md'), `---\n${frontmatter}\n---\n\nbody\n`)
  }
  write('plain', 'name: plain\ndescription: A plain one. Extra words.')
  write('quoted', 'name: quoted\ndescription: "Quoted: with a colon."')
  write('folded', 'name: folded\ndescription: >\n  Folded across\n  two lines. More.')
  write('unnamed', 'description: Falls back to the directory name.')
  mkdirSync(join(root, 'no-skill-file'))
  symlinkSync(join(root, 'plain'), join(root, 'linked'))

  it('reads name and description from frontmatter, following symlinks', () => {
    const skills = readSkills([root])
    expect(skills.map((s) => s.name)).toEqual(['folded', 'plain', 'quoted', 'unnamed'])
    expect(skills.find((s) => s.name === 'folded')?.description).toBe('Folded across two lines. More.')
    expect(skills.find((s) => s.name === 'quoted')?.description).toBe('Quoted: with a colon.')
    expect(skills.find((s) => s.name === 'unnamed')?.description).toBe('Falls back to the directory name.')
  })

  it('merges several roots, the first one winning a name clash', () => {
    const other = mkdtempSync(join(tmpdir(), 'skills-'))
    mkdirSync(join(other, 'plain'))
    writeFileSync(join(other, 'plain', 'SKILL.md'), '---\nname: plain\ndescription: Loser.\n---\n')
    mkdirSync(join(other, 'extra'))
    writeFileSync(join(other, 'extra', 'SKILL.md'), '---\nname: extra\ndescription: Extra.\n---\n')
    const skills = readSkills([root, other])
    expect(skills.find((s) => s.name === 'plain')?.description).toBe('A plain one. Extra words.')
    expect(skills.some((s) => s.name === 'extra')).toBe(true)
  })
})

describe('reconcileSkills', () => {
  it('leaves a manifest that matches the installed skills untouched', () => {
    const input = manifest(entry('tdd', { connects: ['Shell'] }), entry('issues / todo'))
    const result = reconcileSkills(input, [skill('tdd'), skill('issues'), skill('todo')])
    expect(result.manifest).toEqual(input)
    expect(result.added).toEqual([])
    expect(result.removed).toEqual([])
  })

  it('adds an installed skill that has no entry, described by its first sentence', () => {
    const result = reconcileSkills(manifest(entry('tdd')), [skill('tdd'), skill('retro', 'Run a retro. Use it weekly.')])
    expect(result.added).toEqual(['retro'])
    expect(result.manifest.entries.at(-1)).toEqual({ name: 'retro', description: 'Run a retro', category: 'skill' })
  })

  it('removes a skill entry whose skills are no longer installed, and keeps a grouped entry that still has one', () => {
    const input = manifest(entry('gone'), entry('kept / vanished'), entry('fully / vanished'))
    const result = reconcileSkills(input, [skill('kept')])
    expect(result.removed).toEqual(['gone', 'fully / vanished'])
    expect(result.manifest.entries.map((e) => e.name)).toEqual(['Shell', 'kept / vanished'])
  })

  it('never touches built-in or cortex skills, apps or projects', () => {
    const input = manifest(entry('loop / schedule', { tags: ['built-in'] }), entry('sorter', { tags: ['cortex'] }))
    const result = reconcileSkills(input, [])
    expect(result.manifest).toEqual(input)
    expect(result.removed).toEqual([])
  })

  it('does not add a skill already covered by a built-in or cortex entry', () => {
    const input = manifest(entry('loop / schedule', { tags: ['built-in'] }))
    expect(reconcileSkills(input, [skill('loop'), skill('schedule')]).added).toEqual([])
  })

  it('drops connects that point at a removed entry so the manifest still validates', () => {
    const input = manifest(entry('gone'), entry('tdd', { connects: ['gone', 'Shell'] }))
    const result = reconcileSkills(input, [skill('tdd')])
    expect(result.manifest.entries.find((e) => e.name === 'tdd')?.connects).toEqual(['Shell'])
    expect(parseManifest(result.manifest).ok).toBe(true)
  })

  it('is idempotent', () => {
    const once = reconcileSkills(manifest(entry('gone')), [skill('new')])
    const twice = reconcileSkills(once.manifest, [skill('new')])
    expect(twice.manifest).toEqual(once.manifest)
    expect(twice.added).toEqual([])
    expect(twice.removed).toEqual([])
  })
})

describe('formatManifest', () => {
  it('writes one entry per line, as the file is kept by hand', () => {
    const input = manifest(entry('tdd', { tags: ['a'] }))
    expect(formatManifest(input)).toBe(
      '{\n  "version": 1,\n  "entries": [\n' +
        '    {"name":"Shell","description":"App","category":"app"},\n' +
        '    {"name":"tdd","description":"tdd (hand-written)","category":"skill","tags":["a"]}\n' +
        '  ]\n}\n',
    )
  })

  it('round-trips the committed manifest byte for byte', () => {
    const text = readFileSync(new URL('../../ecosystem/manifest.json', import.meta.url), 'utf8')
    expect(formatManifest(JSON.parse(text))).toBe(text)
  })
})
