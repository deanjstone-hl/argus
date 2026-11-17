import { CheckError } from './adapter.js'

// A small GitHub REST client for the Actions cards (argus#685). REST only:
// GraphQL's points budget is what rate-limited the backlog scripts before.
//
// Every response is kept with its ETag and revalidated with If-None-Match:
// GitHub does not count a 304 against the rate limit, so an unchanged runs
// list costs nothing. A finished run's jobs never change, so those paths are
// marked immutable and are never asked for twice.

const API = 'https://api.github.com'
// Cached bodies not read for this long are dropped: old runs fall out of
// every list, so their jobs are never asked for again.
const EVICT_AFTER_MS = 48 * 3_600_000

export interface GithubApiOptions {
  token: string
  fetch?: typeof fetch
  now?: () => number
}

export interface GetOptions {
  immutable?: boolean
}

export interface GithubApi {
  get: <T>(path: string, options?: GetOptions) => Promise<T>
}

interface Cached {
  etag: string | null
  body: unknown
  immutable: boolean
  usedAt: number
}

export function createGithubApi(options: GithubApiOptions): GithubApi {
  const fetchImpl = options.fetch ?? fetch
  const now = options.now ?? Date.now
  const cache = new Map<string, Cached>()

  function evict(): void {
    for (const [path, entry] of cache) {
      if (now() - entry.usedAt > EVICT_AFTER_MS) cache.delete(path)
    }
  }

  async function get<T>(path: string, getOptions: GetOptions = {}): Promise<T> {
    const cached = cache.get(path)
    if (cached?.immutable) {
      cached.usedAt = now()
      return cached.body as T
    }
    const headers: Record<string, string> = {
      authorization: `Bearer ${options.token}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
    }
    if (cached?.etag) headers['if-none-match'] = cached.etag
    const response = await fetchImpl(`${API}${path}`, { headers, signal: AbortSignal.timeout(15_000) })

    if (response.status === 304 && cached) {
      cached.usedAt = now()
      return cached.body as T
    }
    // The API answered: a refused token or an exhausted budget is ours to
    // fix, not GitHub being away.
    if (!response.ok) {
      const reset = Number(response.headers.get('x-ratelimit-reset'))
      if (response.headers.get('x-ratelimit-remaining') === '0' && Number.isFinite(reset) && reset > 0) {
        throw new CheckError('degraded', `GitHub API rate limit exhausted until ${new Date(reset * 1000).toISOString()}`)
      }
      throw new CheckError('degraded', `GitHub API ${path} returned ${response.status}`)
    }
    const body = (await response.json()) as T
    evict()
    cache.set(path, { etag: response.headers.get('etag'), body, immutable: getOptions.immutable === true, usedAt: now() })
    return body
  }

  return { get }
}

// The fields of a workflow run and a job the Actions cards read.
export interface ApiRun {
  id: number
  name: string | null
  workflow_id?: number
  status: string | null
  conclusion: string | null
  head_sha?: string
  run_attempt?: number
  created_at: string
  updated_at: string
  html_url: string | null
}

export interface ApiRunList {
  workflow_runs: ApiRun[]
}

export interface ApiJob {
  name: string
  status: string
  conclusion: string | null
  created_at: string
  started_at: string | null
  runner_name: string | null
  labels: string[]
  html_url: string | null
}

export interface ApiJobList {
  jobs: ApiJob[]
}

// A run's jobs for the attempt the run is on. per_page=100 covers every
// workflow here (the largest, argus CI, has 6 jobs).
export function jobsPath(repo: string, run: ApiRun): string {
  return `/repos/${repo}/actions/runs/${run.id}/attempts/${run.run_attempt ?? 1}/jobs?per_page=100`
}
