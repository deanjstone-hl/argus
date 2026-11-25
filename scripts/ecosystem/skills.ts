/**
 * Keeps the manifest's `skill` entries in step with the skills installed from argus-config
 * (`envs/wsl2/skills`) and sys-admin (`skills`), which is where skills really live
 * (deanjstone/argus#928). Membership is derived; everything hand-written on an entry that
 * stays (description, connects, status, tags, href) is left alone.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import type { Entry, Manifest } from './manifest.ts'

export interface InstalledSkill {
  name: string
  description: string
}

export interface Reconciled {
  manifest: Manifest
  added: string[]
  removed: string[]
}

/** Entries with these tags describe skills that are not installed from the two roots above (`external`: installed from elsewhere, such as security-audit from ~/.agents/skills). */
const EXEMPT_TAGS = ['built-in', 'cortex', 'external']
const DESCRIPTION_LIMIT = 120
const GROUP_SEPARATOR = ' / '

const isExempt = (entry: Entry) => entry.tags?.some((tag) => EXEMPT_TAGS.includes(tag)) ?? false
const partsOf = (name: string) => name.split(GROUP_SEPARATOR).map((part) => part.trim())

/** The first sentence of a skill's description, cut to a card-sized line. */
export function firstSentence(text: string): string {
  const stop = text.search(/\.(\s|$)/)
  const sentence = (stop === -1 ? text : text.slice(0, stop)).trim()
  if (sentence.length <= DESCRIPTION_LIMIT) return sentence
  const room = sentence.slice(0, DESCRIPTION_LIMIT - 1)
  return `${room.slice(0, room.lastIndexOf(' '))}…`
}

function readFrontmatter(path: string): Record<string, string> {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(readFileSync(path, 'utf8'))
  if (!match?.[1]) return {}
  const fields: Record<string, string> = {}
  const lines = match[1].split(/\r?\n/)
  for (let index = 0; index < lines.length; index++) {
    const field = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(lines[index] ?? '')
    if (!field?.[1]) continue
    let value = (field[2] ?? '').trim()
    if (/^[>|][+-]?$/.test(value)) {
      const folded: string[] = []
      while (/^\s+\S/.test(lines[index + 1] ?? '')) folded.push((lines[++index] ?? '').trim())
      value = folded.join(' ')
    }
    fields[field[1]] = value.replace(/^(["'])(.*)\1$/, '$2')
  }
  return fields
}

/**
 * Every skill directory (one holding a SKILL.md, symlinks followed) under the roots, by
 * frontmatter name, sorted. A name found in an earlier root wins over a later one.
 */
export function readSkills(roots: string[]): InstalledSkill[] {
  const byName = new Map<string, InstalledSkill>()
  for (const root of roots) {
    for (const dir of readdirSync(root).sort()) {
      const file = join(root, dir, 'SKILL.md')
      if (!existsSync(file)) continue
      const fields = readFrontmatter(file)
      const name = fields.name || dir
      if (!byName.has(name)) byName.set(name, { name, description: fields.description ?? '' })
    }
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * Add an entry for each installed skill the manifest does not name, and remove each curated
 * skill entry none of whose skills is installed. A grouped entry ("issues / todo") covers every
 * name in it and is kept while any one is installed. Built-in, cortex and external entries are never
 * added against or removed. Edges into a removed entry are dropped so the result still validates.
 */
export function reconcileSkills(manifest: Manifest, installed: InstalledSkill[]): Reconciled {
  const installedNames = new Set(installed.map((skill) => skill.name))
  const removed = manifest.entries.filter((entry) => entry.category === 'skill' && !isExempt(entry) && !partsOf(entry.name).some((part) => installedNames.has(part)))
  const removedNames = new Set(removed.map((entry) => entry.name))

  const kept = manifest.entries
    .filter((entry) => !removedNames.has(entry.name))
    .map((entry): Entry => {
      if (!entry.connects?.some((target) => removedNames.has(target))) return entry
      const connects = entry.connects.filter((target) => !removedNames.has(target))
      const { connects: _dropped, ...rest } = entry
      return connects.length > 0 ? { ...rest, connects } : rest
    })

  const covered = new Set(kept.filter((entry) => entry.category === 'skill').flatMap((entry) => partsOf(entry.name)))
  const missing = installed.filter((skill) => !covered.has(skill.name))
  const added = missing.map((skill): Entry => ({ name: skill.name, description: firstSentence(skill.description), category: 'skill' }))

  return {
    manifest: { ...manifest, entries: [...kept, ...added] },
    added: missing.map((skill) => skill.name),
    removed: removed.map((entry) => entry.name),
  }
}

/** The manifest as it is kept on disk: one entry per line, so a skill added is one line in a diff. */
export function formatManifest(manifest: Manifest): string {
  const lines = manifest.entries.map((entry) => `    ${JSON.stringify(entry)}`)
  return `{\n  "version": ${manifest.version},\n  "entries": [\n${lines.join(',\n')}\n  ]\n}\n`
}

/**
 * The skill roots the sync reads when none is given. The config repo is being renamed
 * argus-config -> config (argus-config#1401): its skills are under ~/repos/config once that copy
 * has them, else under ~/repos/argus-config (also the answer when neither exists).
 */
export function defaultSkillRoots(home: string, exists: (path: string) => boolean): string[] {
  const renamed = join(home, 'repos/config/envs/wsl2/skills')
  const configRoot = exists(renamed) ? renamed : join(home, 'repos/argus-config/envs/wsl2/skills')
  return [configRoot, join(home, 'repos/sys-admin/skills')]
}
