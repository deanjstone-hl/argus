import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import { checkBearer } from '@argus/bearer-auth'
import { Hono } from 'hono'
import { z } from 'zod'

import { createMcpServer } from './mcp.js'
import { authenticate, type Role, type RoleToken } from './roles.js'
import { HOSTS, Refused, type Store } from './store.js'

/** The loop-wake client's request (argus#831). Strict: an unknown or mistyped field is refused, never ignored. */
const wakeCheckBody = z
  .object({
    role: z.enum(['afk', 'direction']),
    host: z.enum(HOSTS),
    thread_id: z.string(),
    directives_version: z.string(),
    needs_owner: z.array(z.string()),
    window_used_percent: z.number().min(0).max(100).optional(),
    weekly_used_percent: z.number().optional(),
    weekly_resets_at: z.string().optional(),
    reserve_percent: z.number().min(0).lt(100).optional(),
    takeable: z.number().int().min(0).optional(),
    takeable_exempt: z.number().int().min(0).optional(),
    host_gates_ok: z.boolean().optional(),
  })
  .strict()

/** ops-hub's promotion report (argus#1118). Strict: an unknown or mistyped field is refused, never ignored. */
const promotedBody = z
  .object({
    repo: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, 'repo must be owner/repo'),
    from_sha: z.string().regex(/^[0-9a-f]{40}$/i, 'from_sha must be a 40-character SHA').nullable(),
    to_sha: z.string().regex(/^[0-9a-f]{40}$/i, 'to_sha must be a 40-character SHA'),
    at: z.iso.datetime(),
    source: z.enum(['approve', 'webhook']),
  })
  .strict()

/** ops-hub's wake request (argus#1189). Strict: it names an issue and nothing else. */
const wakeRequestBody = z.object({ issue: z.string() }).strict()

export interface AppOptions {
  store: Store
  tokens: RoleToken[]
  /** The bearer ops-hub presents to POST /events/promoted. Unset: the route refuses every caller. */
  promotionToken?: string | undefined
}

/** `/mcp` behind per-role bearer tokens, and an open `/healthz` for the deploy check. */
export function createApp(options: AppOptions) {
  const app = new Hono<{ Variables: { role: Role } }>()

  app.get('/healthz', (c) => c.json({ ok: true }))

  /**
   * Whether this tick needs a model turn: `{wake, reason, recorded}`. The bearer token must be
   * the role named in the body; a worker token gets nothing here.
   */
  app.post('/wake/check', async (c) => {
    const role = authenticate(c.req.header('Authorization'), options.tokens)
    if (!role) return c.json({ error: 'unauthorized' }, 401)
    let raw: unknown
    try {
      raw = await c.req.json()
    } catch {
      return c.json({ error: 'the body must be JSON' }, 400)
    }
    const body = wakeCheckBody.safeParse(raw)
    if (!body.success) return c.json({ error: z.prettifyError(body.error) }, 400)
    if (role !== body.data.role) return c.json({ error: `a ${role} token cannot check the ${body.data.role} role` }, 403)
    try {
      return c.json(options.store.wakeCheck(role, body.data))
    } catch (error) {
      if (error instanceof Refused) return c.json({ error: error.message }, 400)
      throw error
    }
  })

  /**
   * ops-hub reports a promotion (argus#1118). Its own bearer, not a role token: ops-hub holds no role
   * and can write nothing else. With no token configured the route fails closed.
   */
  app.post('/events/promoted', async (c) => {
    if (!(await checkBearer(c.req.header('Authorization'), options.promotionToken))) return c.json({ error: 'unauthorized' }, 401)
    let raw: unknown
    try {
      raw = await c.req.json()
    } catch {
      return c.json({ error: 'the body must be JSON' }, 400)
    }
    const body = promotedBody.safeParse(raw)
    if (!body.success) return c.json({ error: z.prettifyError(body.error) }, 400)
    return c.json(options.store.recordPromoted(body.data))
  })

  /**
   * ops-hub asks for an Aquila wake for a named issue (argus#1189). The hub's bearer is the promotion
   * token: the one secret ops-hub holds, which can report a promotion and ask for a wake, nothing else.
   * Unset, the route fails closed. A wake never bypasses a gate: this records a request and starts nothing.
   */
  app.post('/wake/request', async (c) => {
    if (!(await checkBearer(c.req.header('Authorization'), options.promotionToken))) return c.json({ error: 'unauthorized' }, 401)
    let raw: unknown
    try {
      raw = await c.req.json()
    } catch {
      return c.json({ error: 'the body must be JSON' }, 400)
    }
    const body = wakeRequestBody.safeParse(raw)
    if (!body.success) return c.json({ error: z.prettifyError(body.error) }, 400)
    try {
      const result = options.store.recordWakeRequest(body.data.issue)
      if (!('rate_limited' in result)) return c.json(result)
      return c.json({ error: 'rate_limited', retry_after_seconds: result.retry_after_seconds }, 429, { 'Retry-After': String(result.retry_after_seconds) })
    } catch (error) {
      if (error instanceof Refused) return c.json({ error: error.message }, 400)
      throw error
    }
  })

  app.use('/mcp', async (c, next) => {
    const role = authenticate(c.req.header('Authorization'), options.tokens)
    if (!role) return c.json({ error: 'unauthorized' }, 401)
    c.set('role', role)
    await next()
  })

  // Streamable HTTP, stateless: a fresh server and transport per request.
  app.all('/mcp', async (c) => {
    const server = createMcpServer(options.store, c.get('role'))
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
    await server.connect(transport)
    return transport.handleRequest(c.req.raw)
  })

  return app
}
