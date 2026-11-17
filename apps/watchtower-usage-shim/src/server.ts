import { createServer as createHttpServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http'
import { checkBearer } from '@argus/bearer-auth'
import type { HostReport } from '@argus/watchtower-contract'

export interface ShimOptions {
  token: string
  // ccusage's JSON output for the given arguments; `--json` alone when none.
  runCcusage: (args?: string[]) => Promise<string>
  // GET /host; absent on a shim that does not report its host.
  readHostReport?: () => Promise<HostReport>
}

function sendJson(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(body)
}

function sendError(res: ServerResponse, error: unknown): void {
  sendJson(res, 502, JSON.stringify({ error: error instanceof Error ? error.message : String(error) }))
}

export function createServer({ token, runCcusage, readHostReport }: ShimOptions): Server {
  const route = (req: IncomingMessage, res: ServerResponse): void => {
    const path = new URL(req.url ?? '/', 'http://shim').pathname
    if (path !== '/usage' && path !== '/host') {
      sendJson(res, 404, JSON.stringify({ error: 'not found' }))
      return
    }
    if (req.method !== 'GET') {
      res.writeHead(405, { 'content-type': 'application/json', allow: 'GET' })
      res.end(JSON.stringify({ error: 'method not allowed' }))
      return
    }
    if (path === '/host') {
      if (!readHostReport) {
        sendJson(res, 404, JSON.stringify({ error: 'host report not enabled' }))
        return
      }
      readHostReport()
        .then((report) => sendJson(res, 200, JSON.stringify(report)))
        .catch((error: unknown) => sendError(res, error))
      return
    }

    runCcusage()
      .then((output) => sendJson(res, 200, output))
      .catch((error: unknown) => sendError(res, error))
  }

  return createHttpServer((req, res) => {
    checkBearer(req.headers.authorization, token)
      .then((authorized) => {
        if (!authorized) {
          sendJson(res, 401, JSON.stringify({ error: 'unauthorized' }))
          return
        }
        route(req, res)
      })
      .catch((error: unknown) => sendError(res, error))
  })
}
