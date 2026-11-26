// deanjstone-hl/ops-hub#84: the dashboard UI moved to the ops hub PWA (`/watchtower`). Before this host
// redirects, it ships a kill-switch so any installed copy drops its service worker and caches instead of
// serving a stale shell. public/sw.js is the worker an old registration fetches on its next update check;
// the inline script in index.html does the same for a page that opens before that check.
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

const read = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8')
const worker = read('../public/sw.js')
const html = read('../index.html')
const pageScript = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((match) => match[1] ?? '').find((script) => script.includes('getRegistrations'))

describe('service worker kill-switch (public/sw.js)', () => {
  function run() {
    const listeners: Record<string, (event: { waitUntil: (work: Promise<unknown>) => void }) => void> = {}
    const deleted: string[] = []
    const navigated: string[] = []
    const state = { unregistered: false, skipped: false }
    const self = {
      addEventListener: (type: string, listener: (typeof listeners)[string]) => {
        listeners[type] = listener
      },
      skipWaiting: async () => {
        state.skipped = true
      },
      registration: {
        unregister: async () => {
          state.unregistered = true
          return true
        },
      },
      clients: { matchAll: async () => [{ url: 'https://watchtower.example/', navigate: async (url: string) => navigated.push(url) }] },
    }
    const caches = { keys: async () => ['shell-v1', 'assets'], delete: async (key: string) => deleted.push(key) }
    runInNewContext(worker, { self, caches, console })
    const activate = async () => {
      let work: Promise<unknown> = Promise.resolve()
      listeners.activate?.({ waitUntil: (promise) => (work = promise) })
      await work
    }
    return { listeners, deleted, navigated, state, activate }
  }

  it('takes over at once on install, so it need not wait for the old tabs to close', () => {
    const { listeners, state } = run()
    listeners.install?.({ waitUntil: () => undefined })
    expect(state.skipped).toBe(true)
  })

  it('on activate clears every cache, unregisters itself and reloads the open pages', async () => {
    const { activate, deleted, state, navigated } = run()
    await activate()
    expect(deleted).toEqual(['shell-v1', 'assets'])
    expect(state.unregistered).toBe(true)
    expect(navigated).toEqual(['https://watchtower.example/'])
  })

  it('answers no request itself', () => {
    expect(run().listeners.fetch).toBeUndefined()
  })
})

describe('page kill-switch (index.html)', () => {
  it('is an inline script ahead of the module entry', () => {
    expect(pageScript).toBeDefined()
    expect(html.indexOf(pageScript!)).toBeLessThan(html.indexOf('type="module"'))
  })

  it('unregisters every registration and deletes every cache', async () => {
    const unregistered: string[] = []
    const deleted: string[] = []
    const pending: Promise<unknown>[] = []
    const track = <T>(promise: Promise<T>) => {
      pending.push(promise)
      return promise
    }
    const navigator = { serviceWorker: { getRegistrations: () => track(Promise.resolve([{ unregister: () => unregistered.push('a') }, { unregister: () => unregistered.push('b') }])) } }
    const window = { caches: { keys: () => track(Promise.resolve(['one', 'two'])), delete: (key: string) => deleted.push(key) } }
    runInNewContext(pageScript!, { navigator, window, caches: window.caches, console })
    await Promise.all(pending)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(unregistered).toEqual(['a', 'b'])
    expect(deleted).toEqual(['one', 'two'])
  })
})
