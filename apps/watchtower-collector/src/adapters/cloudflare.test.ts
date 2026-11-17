import { afterEach, expect, test, vi } from 'vitest'
import { createCloudflareAdapter } from './cloudflare.js'

function respondWith(result: unknown) {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ success: true, result, errors: [] })))
}

afterEach(() => {
  vi.unstubAllGlobals()
})

test('a Pages project reports its latest deployment with when it was created', async () => {
  respondWith({
    name: 'knowledge',
    latest_deployment: {
      id: '00000000-0000-4000-8000-000000000010',
      created_on: '2026-10-15T09:42:00.000000Z',
      environment: 'production',
      latest_stage: { name: 'deploy', status: 'success' },
    },
  })

  const result = await createCloudflareAdapter('account', 'token', { name: 'knowledge', kind: 'pages' }).check()

  expect(result).toEqual({
    status: 'healthy',
    detail: {
      deploymentId: '00000000-0000-4000-8000-000000000010',
      stageStatus: 'success',
      environment: 'production',
      deployedOn: '2026-10-15T09:42:00.000000Z',
    },
  })
})

// The Workers services API returns default_environment as the whole
// environment object (script, tags, handlers, observability…): only its name
// and the deploy time are worth a row every five minutes.
test('a Worker reports its default environment by name and when it was last deployed', async () => {
  respondWith({
    id: 'reader-api',
    created_on: '2026-06-28T01:40:18.959061Z',
    modified_on: '2026-10-08T00:47:30.508843Z',
    default_environment: {
      environment: 'production',
      script_tag: '00000000000000000000000000000011',
      modified_on: '2026-10-08T00:47:30.508843Z',
      script: { id: 'reader-api', handlers: ['fetch'] },
    },
  })

  const result = await createCloudflareAdapter('account', 'token', { name: 'reader-api', kind: 'worker' }).check()

  expect(result).toEqual({
    status: 'healthy',
    detail: { defaultEnvironment: 'production', modifiedOn: '2026-10-08T00:47:30.508843Z' },
  })
})
