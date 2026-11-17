import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createServer, connect, type Socket } from 'node:net'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, describe, expect, it } from 'vitest'

import { TOKENS, tempDbPath } from './helpers.js'

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const SHUTDOWN_BUDGET_MS = 5_000

const children: ChildProcess[] = []
const sockets: Socket[] = []
afterEach(() => {
  for (const socket of sockets.splice(0)) socket.destroy()
  for (const child of children.splice(0)) child.kill('SIGKILL')
})

async function freePort(): Promise<number> {
  const probe = createServer()
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve))
  const address = probe.address()
  await new Promise<void>((resolve) => probe.close(() => resolve()))
  if (address === null || typeof address === 'string') throw new Error('no port assigned')
  return address.port
}

async function startServer(dbPath: string, port: number): Promise<ChildProcess> {
  // `node --import tsx` keeps the server as the direct child, so the signal reaches it rather than a tsx wrapper.
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
    cwd: packageRoot,
    env: {
      ...process.env,
      LOOP_STATE_TOKENS: `afk=${TOKENS.afk},direction=${TOKENS.direction},worker=${TOKENS.worker}`,
      LOOP_STATE_HOST: '127.0.0.1',
      LOOP_STATE_PORT: String(port),
      LOOP_STATE_DB: dbPath,
    },
    stdio: ['ignore', 'pipe', 'inherit'],
  })
  children.push(child)
  await new Promise<void>((resolve, reject) => {
    child.once('exit', (code) => reject(new Error(`server exited early with code ${code}`)))
    child.stdout?.on('data', (chunk: Buffer) => {
      if (chunk.toString().includes('listening')) resolve()
    })
  })
  return child
}

/** Sends one request and keeps the socket open, so the server holds a live connection to it. */
async function holdConnection(port: number, request: string, expectInResponse: string): Promise<Socket> {
  const socket = connect(port, '127.0.0.1')
  sockets.push(socket)
  socket.on('error', () => {})
  await new Promise<void>((resolve, reject) => {
    let received = ''
    socket.once('connect', () => socket.write(request))
    socket.on('data', (chunk) => {
      received += chunk.toString()
      if (received.includes(expectInResponse)) resolve()
    })
    socket.once('close', () => reject(new Error(`connection closed before "${expectInResponse}": ${received}`)))
  })
  return socket
}

describe('shutdown on SIGTERM', () => {
  it('exits within the budget with a keep-alive connection and an open SSE stream, closing the db', async () => {
    const dbPath = tempDbPath()
    const port = await freePort()
    const child = await startServer(dbPath, port)

    await holdConnection(port, `GET /healthz HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: keep-alive\r\n\r\n`, '"ok":true')
    await holdConnection(
      port,
      `GET /mcp HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer ${TOKENS.afk}\r\nAccept: text/event-stream\r\n\r\n`,
      'HTTP/1.1 200',
    )

    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null; elapsedMs: number }>((resolve) => {
      const sentAt = Date.now()
      child.once('exit', (code, signal) => resolve({ code, signal, elapsedMs: Date.now() - sentAt }))
    })
    child.kill('SIGTERM')

    const result = await Promise.race([
      exited,
      new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), SHUTDOWN_BUDGET_MS)),
    ])
    if (result === 'timeout') throw new Error(`still running ${SHUTDOWN_BUDGET_MS}ms after SIGTERM`)
    console.log(`SIGTERM to exit: ${result.elapsedMs} ms (exit code ${result.code})`)

    expect(result.signal).toBeNull()
    expect(result.code).toBe(0)
    // A clean close of the last connection checkpoints the WAL and removes it; a SIGKILL leaves it behind.
    expect(existsSync(`${dbPath}-wal`)).toBe(false)
  })
})
