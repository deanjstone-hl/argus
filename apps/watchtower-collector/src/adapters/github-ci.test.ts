import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { createGithubApi } from '../github-api.js'
import { runCheck } from '../poller.js'
import { createGithubCiAdapters, parseRepoList } from './github-ci.js'

vi.mock('../record-check.js', () => ({ recordCheck: vi.fn() }))

const read = (name: string) => JSON.parse(readFileSync(new URL(`../__fixtures__/${name}`, import.meta.url), 'utf8'))
// GET /repos/deanjstone/<repo>/actions/runs?branch=main on 2026-10-16 12:44
// UTC: argus-config's Lint green and Release always skipped; budget's CI,
// Release, Secret Scanning and Notify on failure green.
const ARGUS_CONFIG = read('github-ci-argus-config-main.json')
const BUDGET = read('github-ci-budget-main.json')
// argus-config's real red main run of 2026-10-15 (Bats tests failed) and its jobs.
const FAILED_RUN = read('github-ci-argus-config-failed-run.json')
const FAILED_JOBS = read('github-ci-argus-config-failed-jobs.json')

function serve(bodies: Record<string, unknown>) {
  const calls: string[] = []
  const fetchImpl = (async (url: string | URL | Request) => {
    calls.push(String(url))
    const path = String(url).replace('https://api.github.com', '')
    const body = Object.entries(bodies).find(([prefix]) => path.startsWith(prefix))?.[1]
    return body === undefined ? new Response('{"message":"Not Found"}', { status: 404 }) : new Response(JSON.stringify(body), { status: 200 })
  }) as typeof fetch
  return { api: createGithubApi({ token: 't', fetch: fetchImpl }), calls }
}

const runsPath = (repo: string) => `/repos/deanjstone/${repo}/actions/runs?branch=main`

describe('parseRepoList', () => {
  it('reads owner/repo or bare repo names under the default owner', () => {
    expect(parseRepoList('deanjstone/argus, argus-config,,other/x', 'deanjstone')).toEqual(['deanjstone/argus', 'deanjstone/argus-config', 'other/x'])
  })
})

describe('github-ci adapters', () => {
  it('makes one card per repo under host github-ci, polling every 5 minutes', () => {
    const { api } = serve({})
    const adapters = createGithubCiAdapters(api, ['deanjstone/argus', 'deanjstone/argus-config'])
    expect(adapters.map((adapter) => [adapter.key, adapter.host, adapter.intervalMs, adapter.failureStatus])).toEqual([
      ['github-ci:argus', 'github-ci', 300_000, 'unreachable'],
      ['github-ci:argus-config', 'github-ci', 300_000, 'unreachable'],
    ])
  })

  it('asks for main runs only, without pull request runs', async () => {
    const { api, calls } = serve({ [runsPath('argus-config')]: ARGUS_CONFIG })
    await runCheck(createGithubCiAdapters(api, ['deanjstone/argus-config'])[0]!)
    expect(calls).toEqual(['https://api.github.com/repos/deanjstone/argus-config/actions/runs?branch=main&exclude_pull_requests=true&per_page=30'])
  })

  it('is healthy when every workflow last passed, and drops workflows that only ever skipped', async () => {
    const { api } = serve({ [runsPath('argus-config')]: ARGUS_CONFIG })
    const result = await runCheck(createGithubCiAdapters(api, ['deanjstone/argus-config'])[0]!)
    expect(result).toEqual({
      status: 'healthy',
      detail: {
        repo: 'deanjstone/argus-config',
        branch: 'main',
        workflows: [
          {
            name: 'Lint',
            conclusion: 'success',
            completedAt: '2026-10-16T11:43:54Z',
            headSha: '0e695a77444adf490abedc5f66005ee90d2ad26b',
            runUrl: 'https://github.com/deanjstone/argus-config/actions/runs/38893000703',
            running: false,
            failedJobs: [],
          },
        ],
      },
    })
  })

  it('takes each workflow’s newest decisive run, skipping skipped ones', async () => {
    const { api } = serve({ [runsPath('budget')]: BUDGET })
    const result = await runCheck(createGithubCiAdapters(api, ['deanjstone/budget'])[0]!)
    expect(result.status).toBe('healthy')
    const workflows = (result.detail as { workflows: Array<{ name: string; conclusion: string }> }).workflows
    expect(workflows.map((workflow) => [workflow.name, workflow.conclusion])).toEqual([
      ['CI', 'success'],
      ['Notify on failure', 'success'],
      ['Release', 'success'],
      ['Secret Scanning', 'success'],
    ])
  })

  it('is degraded when a workflow’s newest run failed, naming the failed jobs', async () => {
    const red = { ...ARGUS_CONFIG, workflow_runs: [FAILED_RUN, ...ARGUS_CONFIG.workflow_runs] }
    const { api, calls } = serve({
      [runsPath('argus-config')]: red,
      '/repos/deanjstone/argus-config/actions/runs/38683201639/attempts/1/jobs': FAILED_JOBS,
    })
    const adapter = createGithubCiAdapters(api, ['deanjstone/argus-config'])[0]!
    const result = await runCheck(adapter)
    expect(result.status).toBe('degraded')
    expect(result.detail).toMatchObject({ workflows: [{ name: 'Lint', conclusion: 'failure', failedJobs: ['Bats tests'] }] })
    // A finished run's jobs never change: the second poll does not ask again.
    await runCheck(adapter)
    expect(calls.filter((url) => url.includes('/jobs'))).toHaveLength(1)
  })

  it('keeps the last result while a newer run is in progress', async () => {
    const [newest, ...rest] = ARGUS_CONFIG.workflow_runs
    const running = { ...ARGUS_CONFIG, workflow_runs: [{ ...newest, id: 1, status: 'in_progress', conclusion: null }, newest, ...rest] }
    const { api } = serve({ [runsPath('argus-config')]: running })
    const result = await runCheck(createGithubCiAdapters(api, ['deanjstone/argus-config'])[0]!)
    expect(result.detail).toMatchObject({ workflows: [{ name: 'Lint', conclusion: 'success', running: true }] })
  })

  it('is healthy with no workflows when the repo has no runs on main', async () => {
    const { api } = serve({ [runsPath('ledger-spa')]: { total_count: 0, workflow_runs: [] } })
    expect(await runCheck(createGithubCiAdapters(api, ['deanjstone/ledger-spa'])[0]!)).toEqual({
      status: 'healthy',
      detail: { repo: 'deanjstone/ledger-spa', branch: 'main', workflows: [] },
    })
  })

  it('degrades when GitHub refuses the token', async () => {
    const { api } = serve({})
    const result = await runCheck(createGithubCiAdapters(api, ['deanjstone/argus'])[0]!)
    expect(result.status).toBe('degraded')
    expect(result.detail).toEqual({ error: expect.stringContaining('returned 404') })
  })
})
