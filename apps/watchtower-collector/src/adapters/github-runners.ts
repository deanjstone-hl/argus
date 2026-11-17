import type { GithubRunnerDetail } from '@argus/watchtower-contract'
import { CheckError, type Adapter, type HealthResult } from '../adapter.js'

// One card per self-hosted runner, read from GitHub's runners API rather
// than the runner's own systemd unit: the unit stays `running` through a
// listener that has lost its session, and only GitHub knows `busy`.

const INTERVAL_MS = 60_000
// Shorter than the poll interval, so all of one repo's runners share a
// single request per poll and the next poll always refetches.
const CACHE_MS = 30_000

export interface RunnerTarget {
  repo: string
  name: string
}

interface ApiRunner {
  name: string
  status: string
  busy: boolean
  version?: string
  labels?: Array<{ name: string }>
}

interface RunnerListing {
  runners: ApiRunner[]
}

export interface RunnerSourceOptions {
  owner: string
  token: string
  fetch?: typeof fetch
  now?: () => number
}

export interface RunnerSource {
  owner: string
  listRunners: (repo: string) => Promise<ApiRunner[]>
}

// GITHUB_RUNNERS: comma-separated `repo/runner` pairs. The list is explicit
// so a runner that disappears from GitHub shows as down instead of vanishing.
export function parseRunnerList(value: string | undefined): RunnerTarget[] {
  return (value ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const [repo, name, ...rest] = entry.split('/')
      if (!repo || !name || rest.length > 0) throw new Error(`GITHUB_RUNNERS entry "${entry}" is not repo/runner`)
      return { repo, name }
    })
}

export function createRunnerSource(options: RunnerSourceOptions): RunnerSource {
  const fetchImpl = options.fetch ?? fetch
  const now = options.now ?? Date.now
  const cache = new Map<string, { at: number; listing: Promise<ApiRunner[]> }>()

  async function fetchRunners(repo: string): Promise<ApiRunner[]> {
    const response = await fetchImpl(`https://api.github.com/repos/${options.owner}/${repo}/actions/runners?per_page=100`, {
      headers: {
        authorization: `Bearer ${options.token}`,
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
      },
      signal: AbortSignal.timeout(15_000),
    })
    // The API answered: a rejected or under-scoped token is a configuration
    // problem on our side, not GitHub being away.
    if (!response.ok) throw new CheckError('degraded', `GitHub runners API for ${options.owner}/${repo} returned ${response.status}`)
    const body = (await response.json()) as RunnerListing
    if (!Array.isArray(body.runners)) throw new CheckError('degraded', `GitHub runners API for ${options.owner}/${repo} returned no runners list`)
    return body.runners
  }

  return {
    owner: options.owner,
    listRunners: (repo) => {
      const cached = cache.get(repo)
      if (cached && now() - cached.at < CACHE_MS) return cached.listing
      const listing = fetchRunners(repo)
      cache.set(repo, { at: now(), listing })
      listing.catch(() => cache.delete(repo))
      return listing
    },
  }
}

async function checkRunner(source: RunnerSource, target: RunnerTarget): Promise<HealthResult> {
  const runner = (await source.listRunners(target.repo)).find((candidate) => candidate.name === target.name)
  if (!runner) throw new CheckError('down', `runner ${target.name} is not registered on ${source.owner}/${target.repo}`)
  const online = runner.status === 'online'
  const detail: GithubRunnerDetail = {
    repo: target.repo,
    name: runner.name,
    online,
    busy: runner.busy === true,
    version: runner.version ?? null,
    labels: (runner.labels ?? []).map((label) => label.name),
  }
  return { status: online ? 'healthy' : 'down', detail }
}

export function createGithubRunnerAdapters(source: RunnerSource, runners: RunnerTarget[]): Adapter[] {
  return runners.map((target) => ({
    key: `github-runner:${target.repo}/${target.name}`,
    host: 'github-runners',
    intervalMs: INTERVAL_MS,
    failureStatus: 'unreachable',
    check: () => checkRunner(source, target),
  }))
}
