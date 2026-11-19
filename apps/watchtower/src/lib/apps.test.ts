import { describe, expect, it } from 'vitest'

import { APPS } from './apps'

describe('the app switcher list', () => {
  it('comes from the links registry, in canonical form', () => {
    for (const app of APPS) expect(app.href, app.id).toMatch(/^https:\/\/[a-z.]+\/([a-z]+\/)?$/)
    expect(APPS.map((app) => app.href)).toEqual(
      expect.arrayContaining([
        'https://watchtower.myargus.cc/',
        'https://ops.myargus.cc/',
        'https://mail.myargus.cc/',
        'https://myargus.cc/',
        'https://myargus.cc/reader/',
      ]),
    )
  })

  it('marks watchtower as the current app, and only it', () => {
    expect(APPS.filter((app) => app.current).map((app) => app.id)).toEqual(['watchtower'])
  })

  it('never lists a retired or redirect host', () => {
    const hosts = APPS.map((app) => new URL(app.href).host)
    expect(hosts).not.toContain('knowledge.myargus.cc')
    expect(hosts).not.toContain('board.myargus.cc')
  })
})
