// The links registry (deanjstone/frontend, ADR-0004) is vendored: one links.json at the repo root,
// and a links.ts + links-core.ts copy inside each package that builds URLs. Node services are
// built with tsc, which cannot resolve the `@/lib/...` alias at run time, so their copies import
// `./links-core.js`. scripts/vendor-links.sh writes all of them; this pins that they stay one
// registry and one set of builders (argus#18).
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

const read = (path: string) => readFileSync(fileURLToPath(new URL(`../${path}`, import.meta.url)), 'utf8')

const ALIAS_IMPORT = '"@/lib/links-core"'
const RELATIVE_IMPORT = '"./links-core.js"'

const VITE_PACKAGE = 'apps/watchtower/src/lib'
const NODE_PACKAGES = ['apps/watchtower-collector/src/lib', 'apps/agent-engine/src/lib']

const registryOf = (linksTs: string): Record<string, unknown> => {
  const literal = /export const REGISTRY = (\{[\s\S]*?\n\}) as const/.exec(linksTs)?.[1]
  if (literal === undefined) throw new Error('links.ts has no REGISTRY literal')
  return JSON.parse(literal) as Record<string, unknown>
}

const linksJson = () => {
  const { $comment: _comment, $schema: _schema, ...registry } = JSON.parse(read('links.json')) as Record<string, unknown>
  return registry
}

describe('vendored links registry', () => {
  it('every links.ts holds exactly the root links.json', () => {
    for (const dir of [VITE_PACKAGE, ...NODE_PACKAGES]) {
      expect(registryOf(read(`${dir}/links.ts`)), dir).toEqual(linksJson())
    }
  })

  it('the Vite package imports the builders through the @/ alias', () => {
    expect(read(`${VITE_PACKAGE}/links.ts`)).toContain(`from ${ALIAS_IMPORT}`)
  })

  it.each(NODE_PACKAGES)('%s is the Vite copy with a relative import', (dir) => {
    const expected = read(`${VITE_PACKAGE}/links.ts`).replace(ALIAS_IMPORT, RELATIVE_IMPORT)
    expect(read(`${dir}/links.ts`)).toBe(expected)
  })

  it.each(NODE_PACKAGES)('%s carries the same builders as the Vite copy', (dir) => {
    expect(read(`${dir}/links-core.ts`)).toBe(read(`${VITE_PACKAGE}/links-core.ts`))
  })

  it('every links.ts carries the vendored marker, so link-check skips the registry data it holds', () => {
    for (const dir of [VITE_PACKAGE, ...NODE_PACKAGES]) {
      const head = read(`${dir}/links.ts`).split('\n').slice(0, 10).join('\n')
      expect(head, dir).toContain('link-check:vendored')
    }
  })

  it('the link-check workflow blocks, on a hosted runner, with no CI_RUNS_ON', () => {
    const workflow = read('.github/workflows/link-check.yml')
    expect(workflow).toContain('LINK_CHECK_MODE: block')
    expect(workflow).toContain('runs-on: ubuntu-latest')
    expect(workflow).not.toContain('CI_RUNS_ON')
  })
})
