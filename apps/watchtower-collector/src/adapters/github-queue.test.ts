import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { createGithubApi } from '../github-api.js'
import { runCheck } from '../poller.js'
import { createGithubQueueAdapter } from './github-queue.js'

vi.mock('../record-check.js', () => ({ recordCheck: vi.fn() }))

const read = (name: string) => JSON.parse(readFileSync(new URL(`../__fixtures__/${name}`, import.meta.url), 'utf8'))
// argus's ten newest runs at 2026-10-16 12:44 UTC and every run's jobs:
// two CI runs queued behind a backed-up pair of runners, 27 jobs picked up
// in the window with waits from 3 s to 73 min.
const RUNS = read('github-queue-argus-runs.json')
const JOBS: Record<string, unknown> = read('github-queue-argus-jobs.json')
const NOW = Date.parse('2026-10-16T12:45:00Z')

function serve(overrides: Record<string, unknown> = {}) {
  const calls: string[] = []
  const bodies: Record<string, unknown> = {
    '/repos/deanjstone/argus/actions/runs?': RUNS,
    ...Object.fromEntries(Object.entries(JOBS).map(([id, body]) => [`/repos/deanjstone/argus/actions/runs/${id}/attempts/1/jobs`, body])),
    '/repos/deanjstone/pkm-vault/actions/runs?': { total_count: 0, workflow_runs: [] },
    ...overrides,
  }
  const fetchImpl = (async (url: string | URL | Request) => {
    calls.push(String(url))
    const path = String(url).replace('https://api.github.com', '')
    const body = Object.entries(bodies).find(([prefix]) => path.startsWith(prefix))?.[1]
    return body === undefined ? new Response('{"message":"Not Found"}', { status: 404 }) : new Response(JSON.stringify(body), { status: 200 })
  }) as typeof fetch
  return { api: createGithubApi({ token: 't', fetch: fetchImpl }), calls }
}

function adapter(api: ReturnType<typeof serve>['api'], now = NOW) {
  return createGithubQueueAdapter(api, ['deanjstone/argus', 'deanjstone/pkm-vault'], () => now)
}

describe('runner queue adapter', () => {
  it('is one card, github-runners:queue', () => {
    const queue = adapter(serve().api)
    expect([queue.key, queue.host, queue.intervalMs, queue.failureStatus]).toEqual(['github-runners:queue', 'github-runners', 120_000, 'unreachable'])
  })

  it('measures waits on the real argus queue and degrades on a 63-minute p90', async () => {
    const result = await runCheck(adapter(serve().api))
    expect(result.status).toBe('degraded')
    expect(result.detail).toMatchObject({
      windowHours: 24,
      waiting: 8,
      oldestWaiting: { repo: 'deanjstone/argus', workflow: 'CI', since: '2026-10-16T12:31:06Z' },
      repos: [
        {
          repo: 'deanjstone/argus',
          waiting: 8,
          jobs: 27,
          medianWaitSeconds: 1699,
          p90WaitSeconds: 3800,
          maxWaitSeconds: 4406,
        },
        { repo: 'deanjstone/pkm-vault', waiting: 0, oldestWaiting: null, jobs: 0, medianWaitSeconds: null, p90WaitSeconds: null, maxWaitSeconds: null },
      ],
    })
  })

  it('does not count a queued job’s placeholder start time as a pickup', async () => {
    const result = await runCheck(adapter(serve().api))
    // 35 self-hosted jobs in the fixture, 8 of them still queued.
    expect(result.detail).toMatchObject({ repos: [{ jobs: 27 }, {}] })
  })

  it('is healthy when recent jobs started quickly and nothing waits', async () => {
    const quick = { total_count: 1, jobs: [{ id: 1, run_id: 9, run_attempt: 1, name: 'test', status: 'completed', conclusion: 'success', created_at: '2026-10-16T12:00:00Z', started_at: '2026-10-16T12:00:12Z', completed_at: '2026-10-16T12:02:00Z', runner_name: 'homelab', labels: ['self-hosted', 'homelab'], html_url: null }] }
    const run = { id: 9, name: 'CI', status: 'completed', conclusion: 'success', run_attempt: 1, created_at: '2026-10-16T12:00:00Z', updated_at: '2026-10-16T12:02:00Z', html_url: null }
    const { api } = serve({
      '/repos/deanjstone/argus/actions/runs?': { total_count: 1, workflow_runs: [run] },
      '/repos/deanjstone/argus/actions/runs/9/attempts/1/jobs': quick,
    })
    const result = await runCheck(adapter(api))
    expect(result.status).toBe('healthy')
    expect(result.detail).toMatchObject({ waiting: 0, repos: [{ jobs: 1, medianWaitSeconds: 12 }, {}] })
  })

  it('counts GitHub-hosted jobs too, flagged selfHosted: false', async () => {
    const hosted = { total_count: 1, jobs: [{ id: 1, run_id: 9, run_attempt: 1, name: 'x', status: 'queued', conclusion: null, created_at: '2026-10-16T09:00:00Z', started_at: '2026-10-16T09:00:00Z', completed_at: null, runner_name: null, labels: ['ubuntu-latest'], html_url: null }] }
    const run = { id: 9, name: 'CI', status: 'queued', conclusion: null, run_attempt: 1, created_at: '2026-10-16T09:00:00Z', updated_at: '2026-10-16T09:00:00Z', html_url: null }
    const { api } = serve({ '/repos/deanjstone/argus/actions/runs?': { total_count: 1, workflow_runs: [run] }, '/repos/deanjstone/argus/actions/runs/9/attempts/1/jobs': hosted })
    const result = await runCheck(adapter(api, Date.parse('2026-10-16T09:05:00Z')))
    expect(result).toMatchObject({ status: 'healthy', detail: { waiting: 1, waitingJobs: [{ job: 'x', selfHosted: false }] } })
  })

  it('is degraded once a job has waited 30 minutes, and down at 2 hours', async () => {
    const run = { id: 9, name: 'CI', status: 'queued', conclusion: null, run_attempt: 1, created_at: '2026-10-16T12:00:00Z', updated_at: '2026-10-16T12:00:00Z', html_url: null }
    const job = { id: 1, run_id: 9, run_attempt: 1, name: 'Build', status: 'queued', conclusion: null, created_at: '2026-10-16T12:00:00Z', started_at: '2026-10-16T12:00:00Z', completed_at: null, runner_name: null, labels: ['self-hosted', 'homelab'], html_url: 'https://github.com/deanjstone/argus/actions/runs/9/job/1' }
    const waitingAt = async (at: string) => {
      const { api } = serve({ '/repos/deanjstone/argus/actions/runs?': { total_count: 1, workflow_runs: [run] }, '/repos/deanjstone/argus/actions/runs/9/attempts/1/jobs': { total_count: 1, jobs: [job] } })
      return runCheck(adapter(api, Date.parse(at)))
    }
    expect((await waitingAt('2026-10-16T12:29:00Z')).status).toBe('healthy')
    const degraded = await waitingAt('2026-10-16T12:30:00Z')
    expect(degraded.status).toBe('degraded')
    expect(degraded.detail).toMatchObject({ waiting: 1, oldestWaiting: { repo: 'deanjstone/argus', workflow: 'CI', job: 'Build', since: '2026-10-16T12:00:00Z', url: job.html_url } })
    expect((await waitingAt('2026-10-16T14:00:00Z')).status).toBe('down')
  })

  it('refetches jobs of unfinished runs every poll but finished runs only once', async () => {
    const { api, calls } = serve()
    const queue = adapter(api)
    await runCheck(queue)
    await runCheck(queue)
    const jobCalls = (id: string) => calls.filter((url) => url.includes(`/runs/${id}/`)).length
    expect(jobCalls('38895471160')).toBe(1)
    expect(jobCalls('38901686038')).toBe(2)
  })

  it('skips runs untouched for longer than the window', async () => {
    const { api, calls } = serve()
    await runCheck(adapter(api, Date.parse('2026-10-17T12:00:00Z')))
    expect(calls.filter((url) => url.includes('/runs/38886604436/'))).toHaveLength(0)
  })

  describe('job lists', () => {
    const job = (over: Record<string, unknown>) => ({ id: 1, run_id: 9, run_attempt: 1, name: 'Build', status: 'queued', conclusion: null, created_at: '2026-10-16T12:00:00Z', started_at: '2026-10-16T12:00:00Z', completed_at: null, runner_name: null, labels: ['self-hosted', 'homelab'], html_url: 'https://github.com/deanjstone/argus/actions/runs/9/job/1', ...over })
    const run = { id: 9, name: 'CI', status: 'in_progress', conclusion: null, run_attempt: 1, created_at: '2026-10-16T12:00:00Z', updated_at: '2026-10-16T12:00:00Z', html_url: null }
    const withJobs = (jobs: unknown[]) => serve({ '/repos/deanjstone/argus/actions/runs?': { total_count: 1, workflow_runs: [run] }, '/repos/deanjstone/argus/actions/runs/9/attempts/1/jobs': { total_count: jobs.length, jobs } }).api

    it('are empty when nothing is queued or running', async () => {
      const result = await runCheck(adapter(serve({ '/repos/deanjstone/argus/actions/runs?': { total_count: 0, workflow_runs: [] } }).api))
      expect(result.detail).toMatchObject({ waiting: 0, waitingJobs: [], inProgressJobs: [] })
    })

    it('list every waiting job with its run, queued time and no runner', async () => {
      const api = withJobs([job({ id: 2, name: 'Lint', created_at: '2026-10-16T12:02:00Z', started_at: '2026-10-16T12:02:00Z' }), job({ id: 1 })])
      const result = await runCheck(adapter(api, Date.parse('2026-10-16T12:10:00Z')))
      expect(result.detail).toMatchObject({
        waiting: 2,
        inProgressJobs: [],
        waitingJobs: [
          { repo: 'deanjstone/argus', workflow: 'CI', runId: 9, job: 'Build', runnerName: null, queuedAt: '2026-10-16T12:00:00Z', startedAt: null, selfHosted: true, url: 'https://github.com/deanjstone/argus/actions/runs/9/job/1' },
          { job: 'Lint', queuedAt: '2026-10-16T12:02:00Z', startedAt: null, runnerName: null },
        ],
      })
    })

    it('list every in-progress job with its runner and start time, hosted or not', async () => {
      const api = withJobs([
        job({ id: 1, name: 'Test', status: 'in_progress', started_at: '2026-10-16T12:05:00Z', runner_name: 'jit-argus-ab12' }),
        job({ id: 2, name: 'Hosted', status: 'in_progress', started_at: '2026-10-16T12:01:00Z', runner_name: 'GitHub Actions 7', labels: ['ubuntu-latest'], html_url: null }),
        job({ id: 3, name: 'Done', status: 'completed', conclusion: 'success', started_at: '2026-10-16T12:00:30Z', runner_name: 'jit-argus-cd34' }),
      ])
      const result = await runCheck(adapter(api, Date.parse('2026-10-16T12:10:00Z')))
      expect(result.detail).toMatchObject({
        waiting: 0,
        waitingJobs: [],
        inProgressJobs: [
          { repo: 'deanjstone/argus', workflow: 'CI', runId: 9, job: 'Hosted', runnerName: 'GitHub Actions 7', queuedAt: '2026-10-16T12:00:00Z', startedAt: '2026-10-16T12:01:00Z', selfHosted: false, url: null },
          { job: 'Test', runnerName: 'jit-argus-ab12', startedAt: '2026-10-16T12:05:00Z', selfHosted: true },
        ],
      })
      expect((result.detail as { inProgressJobs: unknown[] }).inProgressJobs).toHaveLength(2)
    })

    it('match the real argus queue: 8 waiting, 2 in progress', async () => {
      const result = await runCheck(adapter(serve().api))
      const detail = result.detail as { waitingJobs: { startedAt: null; runnerName: null }[]; inProgressJobs: { runnerName: string }[] }
      expect(detail.waitingJobs).toHaveLength(8)
      expect(detail.waitingJobs.every((entry) => entry.startedAt === null && entry.runnerName === null)).toBe(true)
      expect(detail.inProgressJobs.map((entry) => entry.runnerName).sort()).toEqual(['homelab', 'homelab-2'])
    })
  })
})
