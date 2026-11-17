// argus/1109: the signed-out screen must follow a system appearance change. Nothing updates the
// `dark` class (and so the status-bar meta) unless useThemePreference is mounted, so the one call
// lives in the root App above the sign-in gate, and the signed-in Dashboard takes the preference
// as props. A second call inside Dashboard would hold its own state beside the root's, and the
// root's system-change listener would then act on a stale mode.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

const read = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8')
const app = read('./App.tsx')
const dashboard = read('./pages/Dashboard.tsx')

describe('theme preference mount (argus/1109)', () => {
  it('mounts useThemePreference in the root App', () => {
    expect(app).toMatch(/import \{ useThemePreference \} from '@\/hooks\/use-theme-preference'/)
    expect(app).toMatch(/useThemePreference\(\{ cookieDomain: themeCookieDomain\(window\.location\.hostname\) \}\)/)
  })

  it('calls the hook before the loading and sign-in early returns', () => {
    const hookCall = app.indexOf('useThemePreference(')
    const firstReturn = app.indexOf('return null')
    const signInGate = app.indexOf('<SignIn />')
    expect(hookCall).toBeGreaterThan(-1)
    expect(hookCall).toBeLessThan(firstReturn)
    expect(hookCall).toBeLessThan(signInGate)
  })

  it('hands the preference to Dashboard instead of mounting a second hook there', () => {
    expect(dashboard).not.toMatch(/useThemePreference/)
    expect(app).toMatch(/<Dashboard mode=\{preference\.mode\} onModeChange=\{setMode\} \/>/)
  })
})
