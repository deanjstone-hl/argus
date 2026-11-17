import type { GithubCiDetail, GithubCiWorkflowDetail } from '@argus/watchtower-contract'
import type { Adapter, HealthResult } from '../adapter.js'
import { jobsPath, type ApiJobList, type ApiRun, type ApiRunList, type GithubApi } from '../github-api.js'

// The latest result of each workflow on a backlog repo's main branch
// (argus#685). Red when any workflow's newest decisive run failed; the card
// names the failed jobs.
//
// Budget: one runs-list request per repo per 5 minutes, revalidated by ETag
// so an unchanged list is a free 304, plus one jobs request per red run,
// fetched once. 23 repos is at most 276 counted requests an hour, against
// 5,000 for the token.

const INTERVAL_MS = 300_000
const BRANCH = 'main'
// 30 runs reaches back past the noisiest repo's skipped helper workflows
// (budget's `Notify on failure` fires after every other run).
const RUNS_PER_PAGE = 30
const RED = new Set(['failure', 'timed_out', 'startup_failure'])
// Skipped, cancelled and neutral runs say nothing about whether main is green.
const DECISIVE = new Set(['success', ...RED])

// CI_REPOS: comma-separated, `owner/repo` or a bare repo under the default owner.
export function parseRepoList(value: string | undefined, defaultOwner: string): string[] {
  return (value ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => (entry.includes('/') ? entry : `${defaultOwner}/${entry}`))
}

function workflowKey(run: ApiRun): string {
  return String(run.workflow_id ?? run.name)
}

async function failedJobs(api: GithubApi, repo: string, run: ApiRun): Promise<string[]> {
  const { jobs } = await api.get<ApiJobList>(jobsPath(repo, run), { immutable: true })
  return jobs.filter((job) => job.conclusion !== null && RED.has(job.conclusion)).map((job) => job.name)
}

async function summarise(api: GithubApi, repo: string, runs: ApiRun[]): Promise<GithubCiWorkflowDetail | null> {
  // Runs arrive newest first.
  const decisiveIndex = runs.findIndex((run) => run.status === 'completed' && run.conclusion !== null && DECISIVE.has(run.conclusion))
  const decisive = decisiveIndex === -1 ? null : (runs[decisiveIndex] as ApiRun)
  const running = runs.slice(0, decisiveIndex === -1 ? runs.length : decisiveIndex).some((run) => run.status !== 'completed')
  if (decisive === null && !running) return null
  const name = (decisive ?? runs[0])?.name ?? 'workflow'
  return {
    name,
    conclusion: decisive?.conclusion ?? null,
    completedAt: decisive?.updated_at ?? null,
    headSha: decisive?.head_sha ?? null,
    runUrl: decisive?.html_url ?? null,
    running,
    failedJobs: decisive !== null && RED.has(decisive.conclusion as string) ? await failedJobs(api, repo, decisive) : [],
  }
}

async function checkRepo(api: GithubApi, repo: string): Promise<HealthResult> {
  const { workflow_runs: runs } = await api.get<ApiRunList>(
    `/repos/${repo}/actions/runs?branch=${BRANCH}&exclude_pull_requests=true&per_page=${RUNS_PER_PAGE}`,
  )
  const byWorkflow = new Map<string, ApiRun[]>()
  for (const run of runs) {
    const group = byWorkflow.get(workflowKey(run)) ?? []
    group.push(run)
    byWorkflow.set(workflowKey(run), group)
  }
  const workflows = (await Promise.all([...byWorkflow.values()].map((group) => summarise(api, repo, group))))
    .filter((workflow): workflow is GithubCiWorkflowDetail => workflow !== null)
    .sort((a, b) => a.name.localeCompare(b.name))
  const detail: GithubCiDetail = { repo, branch: BRANCH, workflows }
  const red = workflows.some((workflow) => workflow.conclusion !== null && RED.has(workflow.conclusion))
  return { status: red ? 'degraded' : 'healthy', detail }
}

export function createGithubCiAdapters(api: GithubApi, repos: string[]): Adapter[] {
  return repos.map((repo) => ({
    key: `github-ci:${repo.split('/')[1] ?? repo}`,
    host: 'github-ci',
    intervalMs: INTERVAL_MS,
    failureStatus: 'unreachable',
    check: () => checkRepo(api, repo),
  }))
}
