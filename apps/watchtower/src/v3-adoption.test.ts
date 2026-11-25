// Guards the move to design-system v3 (argus#908): the pin, the theme preference
// wiring, and the overrides v3's theme replaces.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { themeCookieDomain } from './lib/theme-domain'
import { themeInitScript } from './lib/theme-preference'

const ROOT = fileURLToPath(new URL('../', import.meta.url))
const read = (file: string) => readFileSync(`${ROOT}${file}`, 'utf8')

describe('design-system v3 adoption', () => {
  it('pins the @design-system alias to v3.18.0', () => {
    const { registries } = JSON.parse(read('components.json')) as { registries: Record<string, { url: string }> }
    expect(registries['@design-system'].url).toBe(
      'https://raw.githubusercontent.com/deanjstone-hl/frontend/v3.18.0/r/{name}.json',
    )
  })

  it('no longer forces dark: the choice comes from the theme preference', () => {
    expect(read('index.html')).not.toMatch(/<html[^>]*class="dark"/)
  })

  it('applies the stored theme before first paint with the registry script', () => {
    const html = read('index.html')
    expect(html).toContain(`<script>${themeInitScript()}</script>`)
    expect(html.indexOf('<script>')).toBeLessThan(html.indexOf('</head>'))
  })

  it('lets the page draw under the iPhone status bar and home indicator', () => {
    expect(read('index.html')).toMatch(/<meta name="viewport" content="[^"]*viewport-fit=cover/)
  })

  it('ships the six registry themes, each light and dark', () => {
    const css = read('src/index.css')
    for (const theme of ['default', 't3-chat', 'grove', 'ocean', 'ember', 'iris']) {
      expect(css).toContain(`[data-theme="${theme}"] {`)
      expect(css).toContain(`[data-theme="${theme}"].dark {`)
    }
  })

  it('shares the theme cookie across myargus.cc and nowhere else', () => {
    expect(themeCookieDomain('watchtower.myargus.cc')).toBe('.myargus.cc')
    expect(themeCookieDomain('myargus.cc')).toBe('.myargus.cc')
    expect(themeCookieDomain('localhost')).toBeUndefined()
    expect(themeCookieDomain('evilmyargus.cc')).toBeUndefined()
  })

  it('carries the iPhone head tags: no zoom lock, Home Screen app, a theme-color per scheme', () => {
    const html = read('index.html')
    expect(html).not.toMatch(/maximum-scale|user-scalable/)
    expect(html).toContain('<meta name="apple-mobile-web-app-capable" content="yes" />')
    expect(html).toContain('<meta name="apple-mobile-web-app-status-bar-style" content="default" />')
    expect(html).toMatch(/<meta name="theme-color" media="\(prefers-color-scheme: light\)"/)
    expect(html).toMatch(/<meta name="theme-color" media="\(prefers-color-scheme: dark\)"/)
  })

  it('sizes full-screen pages with min-h-app, never min-h-screen', () => {
    expect(read('src/components/PasskeyGate.tsx')).toContain('min-h-app')
    expect(read('src/components/PasskeyGate.tsx')).not.toContain('min-h-screen')
  })

  it('names the page once on a phone: the dashboard hides its h1 under the shell header', () => {
    expect(read('src/pages/Dashboard.tsx')).toMatch(/<PageHeader[^>]*hideOnPhone/)
  })

  it('draws no tab bar for its one section', () => {
    expect(read('src/pages/Dashboard.tsx').match(/id: '/g)).toHaveLength(1)
  })
})
