import type { GithubQueueJobDetail, GithubQueueRepoDetail } from '@argus/watchtower-contract'
import { afterPrefix, list, num, record, row, rows, text } from '../fields'
import type { CardFormatter, DetailSection } from '../types'
import { formatAbsoluteTime, formatSeconds, pluralise } from '../units'

const PREFIX = 'github-runner:'
// Labels every self-hosted runner carries; only the custom ones say anything.
const DEFAULT_LABELS = new Set(['self-hosted', 'Linux', 'X64'])

export const githubRunnerFormatter: CardFormatter = {
  id: 'github-runner',
  matches: (check) => check.service_key.startsWith(PREFIX),
  format: (check, detail) => {
    const name = text(detail, 'name')
    const repo = text(detail, 'repo')
    const online = detail.online === true
    const busy = detail.busy === true
    const state = online ? (busy ? 'busy' : 'idle') : 'offline'
    const labels = list<unknown>(detail, 'labels').filter((label): label is string => typeof label === 'string' && !DEFAULT_LABELS.has(label))
    return {
      // A poller error has no name: keep the service key, which names it.
      title: name ?? afterPrefix(check.service_key, PREFIX),
      summary: repo === null ? state : `${state} · ${repo}`,
      reason: online ? null : 'Offline on GitHub',
      rows: rows(
        row('State', online ? `online, ${state}` : 'offline'),
        row('Repo', repo),
        row('Labels', labels.length > 0 ? labels.join(', ') : null),
        row('Version', text(detail, 'version')),
      ),
    }
  },
}

// How long jobs sit queued before a homelab runner takes them.
const short = (repo: string) => repo.split('/')[1] ?? repo

function repoSection(repo: GithubQueueRepoDetail): DetailSection {
  const seconds = (value: number | null) => (value === null ? null : formatSeconds(value))
  return {
    title: short(repo.repo),
    rows:
      repo.jobs === 0 && repo.waiting === 0
        ? []
        : rows(
            row('Waiting now', String(repo.waiting)),
            row('Median wait', seconds(repo.medianWaitSeconds)),
            row('p90 wait', seconds(repo.p90WaitSeconds)),
            row('Longest wait', seconds(repo.maxWaitSeconds)),
            row('Jobs taken (24h)', String(repo.jobs)),
          ),
    empty: 'No jobs in the last 24h',
  }
}

export const githubQueueFormatter: CardFormatter = {
  id: 'github-runners-queue',
  matches: (check) => check.service_key === 'github-runners:queue',
  format: (_check, detail, now) => {
    const waiting = num(detail, 'waiting') ?? 0
    const oldest = record(detail, 'oldestWaiting') as GithubQueueJobDetail | null
    const repos = list<GithubQueueRepoDetail>(detail, 'repos').filter((repo) => typeof repo?.repo === 'string')
    const waitedSeconds = oldest === null ? 0 : Math.max(0, (now - Date.parse(oldest.since)) / 1000)
    const slowest = repos.reduce<GithubQueueRepoDetail | null>(
      (worst, repo) => ((repo.p90WaitSeconds ?? 0) > (worst?.p90WaitSeconds ?? 0) ? repo : worst),
      null,
    )
    // Lead with whichever is worse: a job stuck now, or a slow day.
    const reason =
      oldest !== null && waitedSeconds >= (slowest?.p90WaitSeconds ?? 0)
        ? `${oldest.job} on ${short(oldest.repo)} queued for ${formatSeconds(waitedSeconds)}`
        : slowest?.p90WaitSeconds != null
          ? `${short(slowest.repo)} jobs waited ${formatSeconds(slowest.p90WaitSeconds)} for a runner (p90, last 24h)`
          : null
    return {
      title: 'Runner queue',
      summary: oldest === null ? 'none waiting' : `${waiting} waiting · oldest ${formatSeconds(waitedSeconds)}`,
      reason,
      rows: rows(
        row('Waiting now', waiting === 0 ? 'none' : pluralise(waiting, 'job')),
        oldest === null
          ? null
          : row('Oldest waiting', `${oldest.job} · ${oldest.workflow} · ${short(oldest.repo)}, ${formatSeconds(waitedSeconds)}`, { title: formatAbsoluteTime(oldest.since) }),
      ),
      sections: repos.map(repoSection),
    }
  },
}
