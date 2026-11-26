// Kill-switch (deanjstone-hl/ops-hub#84). The watchtower dashboard moved to the ops hub PWA
// (its `/watchtower` module). This host never registered a service worker, so this file only matters
// to an installed copy that did: its next update check fetches this, which clears every cache, unregisters
// itself and reloads the open pages, leaving none of the old shell behind. It caches and answers nothing.
// Keep it served, and out of the host's redirect, until the old host's alias is retired.
self.addEventListener('install', () => {
  void self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys()
      await Promise.all(keys.map((key) => caches.delete(key)))
      await self.registration.unregister()
      const windows = await self.clients.matchAll({ type: 'window' })
      for (const client of windows) {
        try {
          await client.navigate(client.url)
        } catch (error) {
          console.error('watchtower kill-switch: could not reload a page', error)
        }
      }
    })(),
  )
})
