import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import { checkManifestLinks, type LinksRegistry } from './links.ts'
import type { Manifest } from './manifest.ts'

const read = (path: string) => JSON.parse(readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8')) as unknown
const registry = read('links.json') as LinksRegistry
const manifest = (...hrefs: Array<string | undefined>): Manifest => ({
  version: 1,
  entries: hrefs.map((href, index) => ({ name: `App ${index}`, description: 'x', category: 'app' as const, ...(href === undefined ? {} : { href }) })),
})

describe('checkManifestLinks', () => {
  it('passes the real manifest against the real registry', () => {
    expect(checkManifestLinks(read('ecosystem/manifest.json') as Manifest, registry)).toEqual([])
  })

  it('accepts an app root in its canonical form, and ignores hosts outside the domain', () => {
    expect(checkManifestLinks(manifest('https://ops.myargus.cc/', 'https://myargus.cc/reader/', 'https://github.com/deanjstone/argus', undefined), registry)).toEqual([])
  })

  it('asks for the canonical form: https, and an app root ends in a slash', () => {
    expect(checkManifestLinks(manifest('https://budget.myargus.cc'), registry)).toEqual([
      'entries[0].href "https://budget.myargus.cc" is not the canonical form of budget: write "https://budget.myargus.cc/"',
    ])
    expect(checkManifestLinks(manifest('http://ops.myargus.cc/'), registry)).toHaveLength(1)
  })

  it('refuses a retired host and a host that only redirects', () => {
    expect(checkManifestLinks(manifest('https://read.myargus.cc/'), registry)).toEqual(['entries[0].href "https://read.myargus.cc/" names a retired host (read in links.json)'])
    expect(checkManifestLinks(manifest('https://knowledge.myargus.cc/'), registry)).toEqual([
      'entries[0].href "https://knowledge.myargus.cc/" names a host that only redirects (knowledge-host in links.json): link to its target',
    ])
  })

  it('refuses a host or an app path the registry does not hold', () => {
    expect(checkManifestLinks(manifest('https://nope.myargus.cc/'), registry)).toEqual(['entries[0].href "https://nope.myargus.cc/" is not an app in links.json'])
    expect(checkManifestLinks(manifest('https://myargus.cc/nope/'), registry)).toEqual(['entries[0].href "https://myargus.cc/nope/" is not an app in links.json'])
  })

  it('reports each bad href with its index', () => {
    const errors = checkManifestLinks(manifest('https://ops.myargus.cc/', 'https://nope.myargus.cc/', 'https://read.myargus.cc/'), registry)
    expect(errors.map((error) => error.slice(0, 12))).toEqual(['entries[1].h', 'entries[2].h'])
  })
})
