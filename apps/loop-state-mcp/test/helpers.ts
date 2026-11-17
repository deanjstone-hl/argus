import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { afterEach } from 'vitest'

import { createApp } from '../src/app.js'
import { parseTokens, type Role } from '../src/roles.js'
import { openStore, type StoreOptions, type TickingRole } from '../src/store.js'

export const MINUTE = 60_000

// A migration test builds an old-schema db on disk and reopens it, so it is I/O bound: well
// under a second alone, but 20s+ when the shared CI runner is starved (argus#854). Three times
// the suite's 20s default still fails fast on a real hang.
export const MIGRATION_TEST_TIMEOUT_MS = 60_000

export const TOKENS: Record<Role, string> = {
  afk: 'afk-token-0123456789abcdefgh',
  direction: 'direction-token-0123456789ab',
  worker: 'worker-token-0123456789abcd',
}

export const PROMOTION_TOKEN = 'promotion-token-0123456789abc'

export const AFK_THREAD = 'thread-afk-0001'
export const AQUILA_THREAD = 'thread-aquila-0001'

export function tempDbPath(): string {
  return join(mkdtempSync(join(tmpdir(), 'loop-state-db-')), 'loop.db')
}

export function testClock(start = Date.parse('2026-10-18T00:00:00Z')) {
  let current = start
  return {
    now: () => current,
    advance: (ms: number) => {
      current += ms
    },
    iso: () => new Date(current).toISOString(),
  }
}

export interface ToolResult {
  isError?: boolean
  content: { type: string; text: string }[]
}

const clients: Client[] = []
afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()))
})

const tokenSpec = Object.entries(TOKENS)
  .map(([role, token]) => `${role}=${token}`)
  .join(',')

export interface WorldOptions extends Partial<StoreOptions> {
  /** Who holds each role's lease at the start. Defaults to the AFK and Aquila threads; `{}` for none. */
  leases?: Partial<Record<TickingRole, string>>
  /** The ops-hub bearer for POST /events/promoted. Defaults to PROMOTION_TOKEN; `null` leaves the route unconfigured. */
  promotionToken?: string | null
}

/**
 * The loop-state server in-process on a temp SQLite file with a test clock. Tests reach it
 * only through the MCP tools, called as a role, exactly as a thread would.
 */
export function world({ leases = { afk: AFK_THREAD, direction: AQUILA_THREAD }, promotionToken, ...options }: WorldOptions = {}) {
  const clock = testClock()
  const path = options.path ?? tempDbPath()
  let store = openStore({ now: clock.now, ...options, path })
  for (const [role, threadId] of Object.entries(leases)) store.leaseMove('direction', { role: role as TickingRole, to_thread_id: threadId })
  let app = createApp({ store, tokens: parseTokens(tokenSpec), promotionToken: promotionToken === undefined ? PROMOTION_TOKEN : (promotionToken ?? undefined) })

  async function connect(token: string | null) {
    const transport = new StreamableHTTPClientTransport(new URL('http://loop-state.test/mcp'), {
      requestInit: { headers: token ? { Authorization: `Bearer ${token}` } : {} },
      fetch: async (url, init) => app.request(String(url), init),
    })
    const client = new Client({ name: 'test', version: '0.0.0' })
    await client.connect(transport)
    clients.push(client)
    return client
  }

  async function as(role: Role) {
    const client = await connect(TOKENS[role])
    const call = async (name: string, args: Record<string, unknown> = {}) =>
      (await client.callTool({ name, arguments: args })) as ToolResult
    /** Call a tool that must succeed and return its JSON result. */
    const ok = async <T = any>(name: string, args: Record<string, unknown> = {}): Promise<T> => {
      const result = await call(name, args)
      if (result.isError) throw new Error(`${name} failed: ${text(result)}`)
      return JSON.parse(text(result)) as T
    }
    const tools = async () => (await client.listTools()).tools.map((tool) => tool.name).sort()
    return { call, ok, tools }
  }

  /** Close and reopen the db file, as a service restart would. */
  function restart() {
    store.close()
    store = openStore({ now: clock.now, ...options, path })
    app = createApp({ store, tokens: parseTokens(tokenSpec), promotionToken: promotionToken === undefined ? PROMOTION_TOKEN : (promotionToken ?? undefined) })
  }

  /** POST a JSON body to a plain HTTP route, as the loop-wake client does. */
  async function post(path: string, body: unknown, token: string | null) {
    const response = await app.request(`http://loop-state.test${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    })
    return { status: response.status, body: (await response.json()) as any }
  }

  return { clock, as, connect, restart, post }
}

export const text = (result: ToolResult) => result.content.map((part) => part.text).join('\n')
