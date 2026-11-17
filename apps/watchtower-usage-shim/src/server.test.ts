import { test } from 'vitest'
import assert from 'node:assert/strict'
import { createServer } from './server.js'

async function listen(server: ReturnType<typeof createServer>): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') {
    throw new Error('expected server to listen on a TCP port')
  }
  return `http://127.0.0.1:${address.port}`
}

test('rejects requests with no Authorization header', async () => {
  const server = createServer({ token: 'secret', runCcusage: async () => '{"daily":[]}' })
  const base = await listen(server)
  try {
    const response = await fetch(`${base}/usage`)
    assert.equal(response.status, 401)
  } finally {
    server.close()
  }
})

test('rejects requests with the wrong bearer token', async () => {
  const server = createServer({ token: 'secret', runCcusage: async () => '{"daily":[]}' })
  const base = await listen(server)
  try {
    const response = await fetch(`${base}/usage`, {
      headers: { Authorization: 'Bearer wrong' },
    })
    assert.equal(response.status, 401)
  } finally {
    server.close()
  }
})

// argus#574: index.ts refuses to start without a token, but createServer is the
// seam the check lives in, so it fails closed on its own.
test('refuses every request when no token is configured', async () => {
  for (const token of ['', undefined as unknown as string]) {
    const server = createServer({ token, runCcusage: async () => '{"daily":[]}' })
    const base = await listen(server)
    try {
      const attempts: Array<Record<string, string>> = [{}, { Authorization: 'Bearer ' }, { Authorization: 'Bearer undefined' }]
      for (const headers of attempts) {
        const response = await fetch(`${base}/usage`, { headers })
        assert.equal(response.status, 401)
      }
    } finally {
      server.close()
    }
  }
})

test('returns ccusage JSON output for a request with the correct bearer token', async () => {
  const server = createServer({
    token: 'secret',
    runCcusage: async () => '{"daily":[],"totals":{"totalCost":0,"totalTokens":0}}',
  })
  const base = await listen(server)
  try {
    const response = await fetch(`${base}/usage`, {
      headers: { Authorization: 'Bearer secret' },
    })
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('content-type'), 'application/json')
    const body = await response.json()
    assert.deepEqual(body, { daily: [], totals: { totalCost: 0, totalTokens: 0 } })
  } finally {
    server.close()
  }
})

test('returns 502 if ccusage fails to run', async () => {
  const server = createServer({
    token: 'secret',
    runCcusage: async () => {
      throw new Error('ccusage not found')
    },
  })
  const base = await listen(server)
  try {
    const response = await fetch(`${base}/usage`, {
      headers: { Authorization: 'Bearer secret' },
    })
    assert.equal(response.status, 502)
    const body = (await response.json()) as { error: string }
    assert.equal(body.error, 'ccusage not found')
  } finally {
    server.close()
  }
})

test('GET /host returns the host report for the correct bearer token', async () => {
  const report = { reportedAt: '2026-10-16T11:30:00.000Z', disk: null, crashDumps: { wsl: null, windows: null }, memory: { totalBytes: 1, availableBytes: 1, swapTotalBytes: 0, swapFreeBytes: 0, pressure: null }, units: {} }
  let ccusageRan = false
  const server = createServer({
    token: 'secret',
    runCcusage: async () => ((ccusageRan = true), '{}'),
    readHostReport: async () => report,
  })
  const base = await listen(server)
  try {
    const response = await fetch(`${base}/host`, { headers: { Authorization: 'Bearer secret' } })
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), report)
    assert.equal(ccusageRan, false)
  } finally {
    server.close()
  }
})

test('GET /host still requires the bearer token', async () => {
  const server = createServer({ token: 'secret', runCcusage: async () => '{}', readHostReport: async () => { throw new Error('should not run') } })
  const base = await listen(server)
  try {
    assert.equal((await fetch(`${base}/host`)).status, 401)
  } finally {
    server.close()
  }
})

test('GET /host returns 502 when the report cannot be built', async () => {
  const server = createServer({ token: 'secret', runCcusage: async () => '{}', readHostReport: async () => { throw new Error('/proc/meminfo unreadable') } })
  const base = await listen(server)
  try {
    const response = await fetch(`${base}/host`, { headers: { Authorization: 'Bearer secret' } })
    assert.equal(response.status, 502)
    assert.deepEqual(await response.json(), { error: '/proc/meminfo unreadable' })
  } finally {
    server.close()
  }
})

test('GET /host is 404 on a shim started without a host report', async () => {
  const server = createServer({ token: 'secret', runCcusage: async () => '{}' })
  const base = await listen(server)
  try {
    assert.equal((await fetch(`${base}/host`, { headers: { Authorization: 'Bearer secret' } })).status, 404)
  } finally {
    server.close()
  }
})

test('answers an unknown path with 404 instead of running ccusage', async () => {
  let ccusageRan = false
  const server = createServer({ token: 'secret', runCcusage: async () => ((ccusageRan = true), '{}') })
  const base = await listen(server)
  try {
    for (const path of ['/', '/nope', '/usage/extra', '/blocks', '/host']) {
      const response = await fetch(`${base}${path}`, { headers: { Authorization: 'Bearer secret' } })
      assert.equal(response.status, 404, path)
    }
    assert.equal(ccusageRan, false)
  } finally {
    server.close()
  }
})

test('answers a non-GET request on a served route with 405 and an Allow header', async () => {
  let ccusageRan = false
  const server = createServer({ token: 'secret', runCcusage: async () => ((ccusageRan = true), '{}'), readHostReport: async () => { throw new Error('should not run') } })
  const base = await listen(server)
  try {
    for (const path of ['/usage', '/host']) {
      for (const method of ['POST', 'PUT', 'DELETE']) {
        const response = await fetch(`${base}${path}`, { method, headers: { Authorization: 'Bearer secret' } })
        assert.equal(response.status, 405, `${method} ${path}`)
        assert.equal(response.headers.get('allow'), 'GET')
      }
    }
    assert.equal(ccusageRan, false)
  } finally {
    server.close()
  }
})

test('an unauthorized request is still 401 on an unknown path', async () => {
  const server = createServer({ token: 'secret', runCcusage: async () => '{}' })
  const base = await listen(server)
  try {
    assert.equal((await fetch(`${base}/nope`)).status, 401)
  } finally {
    server.close()
  }
})
