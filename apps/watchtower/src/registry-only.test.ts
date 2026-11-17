// #671: the dashboard is built only from deanjstone/design-system registry components.
// Every UI primitive must be a registry item installed by the shadcn CLI, and app code
// composes those primitives and the theme's tokens rather than hand-rolling its own.
import { readdirSync, readFileSync } from 'node:fs'
import { basename, extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

const SRC = fileURLToPath(new URL('./', import.meta.url))

// registry.json item names at the pinned tag (v3.18.0, components.json).
const REGISTRY_ITEMS = new Set([
  'theme', 'utils', 'button', 'card', 'label', 'input', 'dialog', 'tabs', 'table', 'badge', 'alert-dialog', 'avatar', 'checkbox', 'collapsible', 'drawer', 'dropdown-menu', 'popover', 'progress', 'scroll-area', 'select', 'separator', 'sheet', 'skeleton', 'slider', 'sonner', 'switch', 'textarea', 'message', 'bubble', 'marker', 'attachment', 'message-scroller', 'tooltip', 'use-mobile', 'item', 'empty', 'sidebar', 'spinner', 'field', 'input-group', 'toggle', 'toggle-group', 'button-group', 'link-pill', 'app-shell', 'app-switcher', 'page-header', 'empty-page', 'settings-page', 'login', 'nav-link', 'use-theme-preference',
])

function filesUnder(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? filesUnder(join(dir, entry.name)) : [join(dir, entry.name)],
  )
}

const itemName = (file: string) => basename(file, extname(file))
const read = (file: string) => readFileSync(file, 'utf8')
const appFiles = filesUnder(SRC).filter(
  (file) => /\.tsx?$/.test(file) && !file.includes('/components/ui/') && !file.endsWith('.test.ts') && !file.includes('/worker/'),
)

describe('registry-only UI', () => {
  it('every ui primitive is a design-system registry item', () => {
    const vendored = [...filesUnder(join(SRC, 'components/ui')), join(SRC, 'lib/utils.ts')]
    expect(vendored.length).toBeGreaterThan(5)
    expect(vendored.map(itemName).filter((name) => !REGISTRY_ITEMS.has(name))).toEqual([])
  })

  it('app code renders no hand-rolled form controls or dialogs', () => {
    const offenders = appFiles.filter((file) => /<(button|input|textarea|select|dialog)[\s>]/.test(read(file)))
    expect(offenders).toEqual([])
  })

  it('app code imports no component library except through the registry primitives', () => {
    const forbidden = /from ['"](@base-ui\/react|@radix-ui\/|@headlessui\/|@mui\/|antd|react-aria|@shadcn\/react)/
    expect(appFiles.filter((file) => forbidden.test(read(file)))).toEqual([])
  })

  it('app code carries no raw colours or font stacks, only theme tokens', () => {
    const rawHex = /#[0-9a-fA-F]{3,8}\b/
    const rawFont = /font-family|system-ui/
    const rawPalette = /\b(?:text|bg|border|ring|fill|stroke|divide)-(?:gray|slate|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\d/
    const offenders = appFiles.filter((file) => {
      const source = read(file)
      return rawHex.test(source) || rawFont.test(source) || rawPalette.test(source)
    })
    expect(offenders).toEqual([])
  })

  it('the stylesheet defers colours and the typeface to the registry theme', () => {
    const css = read(join(SRC, 'index.css'))
    expect(css).not.toMatch(/font-family/)
    expect(css).not.toMatch(/body\s*\{[^}]*(?:#[0-9a-fA-F]{3,8}\b|system-ui)/)
    expect(css).toContain('@import "@fontsource-variable/ibm-plex-sans"')
  })
})
