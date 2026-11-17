import type { CheckDetail } from '@argus/watchtower-contract'
import { afterPrefix, record, row, rows, text, timeRow } from '../fields'
import type { CardContent, CardFormatter } from '../types'
import { formatRelativeTime } from '../units'

const PREFIX = 'cloudflare:'

// Deployment ids and script tags are noise on a card: only the environment,
// the stage and when it deployed are shown (the ids stay in the raw view).

function summarise(environment: string | null, deployedOn: string | null, fallback: string | null, now: number) {
  const age = deployedOn === null ? fallback : `deployed ${formatRelativeTime(deployedOn, now)}`
  return [environment, age].filter(Boolean).join(' · ') || null
}

// A Pages project carries `stageStatus`; `deployedOn` arrives once the
// collector reports the latest deployment's creation time.
function formatPages(detail: CheckDetail, now: number): CardContent {
  const environment = text(detail, 'environment')
  const stage = text(detail, 'stageStatus')
  const deployedOn = text(detail, 'deployedOn')
  return {
    summary: summarise(environment, deployedOn, stage, now),
    reason:
      stage === null
        ? 'No deployment found'
        : `Latest deployment${environment ? ` (${environment})` : ''} is ${stage}, not success`,
    rows: rows(row('Environment', environment), row('Stage', stage), timeRow('Deployed', deployedOn, now)),
  }
}

// A Worker's `defaultEnvironment` is the Workers API's whole environment
// object (script, tags, handlers…) in rows recorded so far, or a plain name.
function formatWorker(detail: CheckDetail, now: number): CardContent {
  const environmentObject = record(detail, 'defaultEnvironment')
  const environment = environmentObject ? text(environmentObject, 'environment') : text(detail, 'defaultEnvironment')
  const deployedOn = text(detail, 'modifiedOn') ?? (environmentObject ? text(environmentObject, 'modified_on') : null)
  return {
    summary: summarise(environment, deployedOn, null, now),
    rows: rows(row('Environment', environment), timeRow('Deployed', deployedOn, now)),
  }
}

export const cloudflareFormatter: CardFormatter = {
  id: 'cloudflare',
  matches: (check) => check.service_key.startsWith(PREFIX),
  format: (check, detail, now) => ({
    title: afterPrefix(check.service_key, PREFIX),
    ...('stageStatus' in detail || 'deploymentId' in detail ? formatPages(detail, now) : formatWorker(detail, now)),
  }),
}
