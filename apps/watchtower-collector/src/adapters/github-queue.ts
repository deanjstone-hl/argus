import type { GithubQueueActiveJob, GithubQueueDetail, GithubQueueJobDetail, GithubQueueRepoDetail } from '@argus/watchtower-contract'
import type { Adapter, HealthResult } from '../adapter.js'
import { jobsPath, type ApiJob, type ApiJobList, type ApiRun, type ApiRunList, type GithubApi } from '../github-api.js'

// How long Actions jobs sit queued before a runner takes them (argus#685),
// over every repo with a homelab runner. Every job counts, GitHub-hosted or
// self-hosted (argus#1211): the card's lists name which each is. A job's wait is from
// its creation to its start; GitHub creates a job with `needs:` only once
// what it needs has finished, so the wait is time spent queued, including
// queued behind its own matrix siblings.
//
// Measured on 2026-10-16: repos whose runner was free started jobs in 3-48 s
// (median), while a backed-up pair of argus runners left jobs queued for a
// median 18 min and a p90 of 57 min. A job takes 5-12 min to run, so 30 min
// queued is a queue at least two jobs deep: degraded. Two hours with nothing
// picking a job up is a runner that is not taking work at all: down.
//
// Budget: one runs-list request per repo per poll plus one jobs request per
// unfinished run, all revalidated by ETag; a finished run's jobs are fetched
// once. GitHub does not count the 304s.

const INTERVAL_MS = 120_000
const WINDOW_MS = 24 * 3_600_000
const RUNS_PER_PAGE = 20
const WAITING_DEGRADED_MS = 30 * 60_000
const WAITING_DOWN_MS = 2 * 3_600_000
const P90_DEGRADED_SECONDS = 30 * 60

function percentile(sorted: number[], fraction: number): number | null {
  if (sorted.length === 0) return null
  return sorted[Math.ceil(sorted.length * fraction) - 1] as number
}

const isSelfHosted = (job: ApiJob) => job.labels.includes('self-hosted')
const byTime = (key: 'queuedAt' | 'startedAt') => (a: GithubQueueActiveJob, b: GithubQueueActiveJob) =>
  Date.parse(a[key] as string) - Date.parse(b[key] as string)
// A queued job carries a placeholder started_at equal to created_at; only a
// job a runner has taken has a runner_name.
const pickedUp = (job: ApiJob) => job.status !== 'queued' && job.started_at !== null && job.runner_name !== null && job.runner_name !== ''

async function checkRepo(api: GithubApi, repo: string, now: number): Promise<{ detail: GithubQueueRepoDetail; waiting: GithubQueueJobDetail[]; waitingJobs: GithubQueueActiveJob[]; inProgressJobs: GithubQueueActiveJob[] }> {
  const { workflow_runs: runs } = await api.get<ApiRunList>(`/repos/${repo}/actions/runs?per_page=${RUNS_PER_PAGE}`)
  const recent = runs.filter((run) => now - Date.parse(run.updated_at) <= WINDOW_MS)
  const jobsByRun = await Promise.all(
    recent.map(async (run): Promise<[ApiRun, ApiJob[]]> => {
      const { jobs } = await api.get<ApiJobList>(jobsPath(repo, run), { immutable: run.status === 'completed' })
      return [run, jobs]
    }),
  )

  const waiting: GithubQueueJobDetail[] = []
  const waitingJobs: GithubQueueActiveJob[] = []
  const inProgressJobs: GithubQueueActiveJob[] = []
  const waits: number[] = []
  for (const [run, jobs] of jobsByRun) {
    for (const job of jobs) {
      const queued = job.status === 'queued'
      const active: GithubQueueActiveJob = {
        repo,
        workflow: run.name ?? 'workflow',
        runId: run.id,
        job: job.name,
        runnerName: queued || !job.runner_name ? null : job.runner_name,
        queuedAt: job.created_at,
        startedAt: queued ? null : job.started_at,
        selfHosted: isSelfHosted(job),
        url: job.html_url,
      }
      if (queued) {
        waiting.push({ repo, workflow: active.workflow, job: job.name, since: job.created_at, url: job.html_url })
        waitingJobs.push(active)
      } else if (job.status === 'in_progress') {
        inProgressJobs.push(active)
      }
      if (pickedUp(job) && now - Date.parse(job.created_at) <= WINDOW_MS) {
        waits.push(Math.round((Date.parse(job.started_at as string) - Date.parse(job.created_at)) / 1000))
      }
    }
  }
  waitingJobs.sort(byTime('queuedAt'))
  inProgressJobs.sort(byTime('startedAt'))
  waiting.sort((a, b) => Date.parse(a.since) - Date.parse(b.since))
  waits.sort((a, b) => a - b)
  return {
    waiting,
    waitingJobs,
    inProgressJobs,
    detail: {
      repo,
      waiting: waiting.length,
      oldestWaiting: waiting[0] ?? null,
      jobs: waits.length,
      medianWaitSeconds: percentile(waits, 0.5),
      p90WaitSeconds: percentile(waits, 0.9),
      maxWaitSeconds: waits.length === 0 ? null : (waits[waits.length - 1] as number),
    },
  }
}

async function checkQueue(api: GithubApi, repos: string[], now: number): Promise<HealthResult> {
  const results = await Promise.all(repos.map((repo) => checkRepo(api, repo, now)))
  const waiting = results.flatMap((result) => result.waiting).sort((a, b) => Date.parse(a.since) - Date.parse(b.since))
  const oldestWaiting = waiting[0] ?? null
  const detail: GithubQueueDetail = {
    windowHours: WINDOW_MS / 3_600_000,
    waiting: waiting.length,
    oldestWaiting,
    repos: results.map((result) => result.detail),
    waitingJobs: results.flatMap((result) => result.waitingJobs).sort(byTime('queuedAt')),
    inProgressJobs: results.flatMap((result) => result.inProgressJobs).sort(byTime('startedAt')),
  }
  const waitedMs = oldestWaiting === null ? 0 : now - Date.parse(oldestWaiting.since)
  if (waitedMs >= WAITING_DOWN_MS) return { status: 'down', detail }
  const slow = detail.repos.some((repo) => repo.p90WaitSeconds !== null && repo.p90WaitSeconds >= P90_DEGRADED_SECONDS)
  return { status: waitedMs >= WAITING_DEGRADED_MS || slow ? 'degraded' : 'healthy', detail }
}

export function createGithubQueueAdapter(api: GithubApi, repos: string[], now: () => number = Date.now): Adapter {
  return {
    key: 'github-runners:queue',
    host: 'github-runners',
    intervalMs: INTERVAL_MS,
    failureStatus: 'unreachable',
    check: () => checkQueue(api, repos, now()),
  }
}
