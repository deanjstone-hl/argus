import { mkdirSync } from 'node:fs'
import type { Server } from 'node:http'
import { dirname } from 'node:path'

import { serve } from '@hono/node-server'

import { createApp } from './app.js'
import { loadConfig } from './config.js'
import { openStore } from './store.js'

const config = loadConfig(process.env)
mkdirSync(dirname(config.dbPath), { recursive: true })
const store = openStore({ path: config.dbPath, cadenceMs: config.cadenceMs, requireCallerThread: config.requireCallerThread, requireThreadHeader: config.requireThreadHeader })
// No createServer option is passed, so this is a plain http.Server (serve's union adds Http2Server).
const server = serve({ fetch: createApp({ store, tokens: config.tokens, promotionToken: config.promotionToken }).fetch, hostname: config.host, port: config.port }, (info) => {
  console.log(`loop-state-mcp: listening on ${config.host}:${info.port}, db ${config.dbPath}, roles ${[...new Set(config.tokens.map((token) => token.role))].join(', ')}, promotion route ${config.promotionToken ? 'on' : 'off'}`)
}) as Server

// An open MCP stream or a keep-alive socket never ends by itself, and server.close() waits for
// every connection, so shutdown closes idle ones at once and forces the rest after a short grace
// (argus#865). The unit's stop timeout is 90 s; this finishes well inside it.
const SHUTDOWN_GRACE_MS = 2_000

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    console.log(`loop-state-mcp: ${signal}, shutting down`)
    server.close((error) => {
      store.close()
      if (error) {
        console.error('loop-state-mcp: shutdown failed', error)
        process.exit(1)
      }
      process.exit(0)
    })
    server.closeIdleConnections()
    setTimeout(() => server.closeAllConnections(), SHUTDOWN_GRACE_MS).unref()
  })
}
