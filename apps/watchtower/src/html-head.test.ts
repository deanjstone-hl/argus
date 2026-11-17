// argus/1101: the installed PWA keeps its launch-time status-bar colour after a system
// appearance change unless index.html carries the design-system/167 runtime theme-color
// script (the `app-html-head` registry item, v3.14.1 and later). Pin it, so the head
// cannot drift back to the two media-scoped metas alone.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

const read = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8')
const html = read('../index.html')
const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((match) => match[1] ?? '')
const runtime = scripts.find((script) => script.includes('meta[name="theme-color"]'))

describe('index.html head (design-system/167)', () => {
  it('pins the registry at v3.14.1 or later, where the runtime script ships', () => {
    const config = JSON.parse(read('../components.json'))
    const [major = 0, minor = 0, patch = 0] = /\/design-system\/v(\d+)\.(\d+)\.(\d+)\//.exec(config.registries['@design-system'].url)!.slice(1).map(Number)
    expect(major > 3 || (major === 3 && (minor > 14 || (minor === 14 && patch >= 1)))).toBe(true)
  })

  it('keeps one light and one dark media-scoped theme-color meta for the first paint', () => {
    expect(html).toMatch(/<meta name="theme-color"[^>]*media="\(prefers-color-scheme: light\)"[^>]*content="#[0-9a-f]{6}"|<meta name="theme-color"[^>]*content="#[0-9a-f]{6}"[^>]*media="\(prefers-color-scheme: light\)"/i)
    expect(html).toMatch(/<meta name="theme-color"[^>]*media="\(prefers-color-scheme: dark\)"[^>]*content="#[0-9a-f]{6}"|<meta name="theme-color"[^>]*content="#[0-9a-f]{6}"[^>]*media="\(prefers-color-scheme: dark\)"/i)
  })

  it('carries the runtime theme-color script, ahead of the module entry', () => {
    expect(runtime).toBeDefined()
    expect(html.indexOf(runtime!)).toBeLessThan(html.indexOf('type="module"'))
  })

  it('swaps the scoped metas for one unscoped meta and sets color-scheme', () => {
    expect(runtime).toContain('removeChild')
    expect(runtime).toContain('setAttribute("name", "theme-color")')
    expect(runtime).toContain('colorScheme')
  })

  it('re-applies on resume, system mode change and theme or class change', () => {
    for (const trigger of ['"pageshow"', '"visibilitychange"', 'system.addEventListener("change"', 'MutationObserver', '"class", "data-theme"']) {
      expect(runtime).toContain(trigger)
    }
  })
})
