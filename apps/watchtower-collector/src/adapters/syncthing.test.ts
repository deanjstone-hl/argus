import { afterAll, beforeAll, test, vi } from 'vitest'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer, type Server } from 'node:https'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSyncthingAdapter } from './syncthing.js'
import { runCheck } from '../poller.js'

// Failures are thrown by the adapter and mapped to a status by the poller, so
// every check goes through runCheck; recording the result is not under test.
vi.mock('../record-check.js', () => ({ recordCheck: vi.fn() }))

// Syncthing's GUI serves a self-signed cert whose only name is the device
// name, so these tests stand up an HTTPS server with exactly that shape.
const DEVICE_NAME = 'syncthing-test'
const API_KEY = 'test-api-key'

let dir: string
let server: Server
let baseUrl: string
let caPath: string
let otherCaPath: string

function selfSignedCert(name: string): { certPath: string; keyPath: string } {
  const certPath = join(dir, `${name}.pem`)
  const keyPath = join(dir, `${name}.key`)
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes',
    '-days', '1', '-subj', `/CN=${name}`, '-addext', `subjectAltName=DNS:${name}`,
    '-keyout', keyPath, '-out', certPath,
  ], { stdio: 'ignore' })
  return { certPath, keyPath }
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'syncthing-adapter-'))
  const { certPath, keyPath } = selfSignedCert(DEVICE_NAME)
  caPath = certPath
  otherCaPath = selfSignedCert('someone-else').certPath

  server = createServer({ cert: readFileSync(certPath), key: readFileSync(keyPath) }, (req, res) => {
    if (req.headers['x-api-key'] !== API_KEY) {
      res.writeHead(403).end()
      return
    }
    res.setHeader('content-type', 'application/json')
    if (req.url === '/rest/config/folders') {
      res.end(JSON.stringify([{ id: 'vault' }]))
    } else if (req.url?.startsWith('/rest/db/status')) {
      res.end(JSON.stringify({ errors: 0, pullErrors: 0, needTotalItems: 0, state: 'idle', error: '' }))
    } else {
      res.writeHead(404).end()
    }
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  baseUrl = `https://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterAll(() => {
  server.close()
  rmSync(dir, { recursive: true, force: true })
})

test('reports healthy over TLS when the pinned cert and its device name are given', async () => {
  const adapter = createSyncthingAdapter(baseUrl, API_KEY, undefined, {
    caFile: caPath,
    servername: DEVICE_NAME,
  })

  const result = await runCheck(adapter)

  assert.equal(result.status, 'healthy', JSON.stringify(result.detail))
  const folders = result.detail?.folders as Array<{ id: string; state: string }>
  assert.deepEqual(folders.map((f) => f.id), ['vault'])
})

test('reports down when the server cert is not trusted', async () => {
  const adapter = createSyncthingAdapter(baseUrl, API_KEY)

  const result = await runCheck(adapter)

  assert.equal(result.status, 'down')
})

test('reports down when a different cert is pinned', async () => {
  const adapter = createSyncthingAdapter(baseUrl, API_KEY, undefined, {
    caFile: otherCaPath,
    servername: DEVICE_NAME,
  })

  const result = await runCheck(adapter)

  assert.equal(result.status, 'down')
})

test('reports down when the pinned cert is right but the name does not match', async () => {
  const adapter = createSyncthingAdapter(baseUrl, API_KEY, undefined, {
    caFile: caPath,
    servername: 'not-the-device',
  })

  const result = await runCheck(adapter)

  assert.equal(result.status, 'down')
})
