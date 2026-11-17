import type { GithubCiWorkflowDetail } from '@argus/watchtower-contract'
import { afterPrefix, list, text } from '../fields'
import type { CardFormatter, DetailRow } from '../types'
import { formatAbsoluteTime, formatRelativeTime, pluralise } from '../units'

// The latest result of each workflow on a repo's main branch.
const PREFIX = 'github-ci:'
const RED = new Set(['failure', 'timed_out', 'startup_failure'])
const WORDS: Record<string, string> = {
  success: 'passed',
  failure: 'failed',
  timed_out: 'timed out',
  startup_failure: 'failed to start',
}

const isRed = (workflow: GithubCiWorkflowDetail) => workflow.conclusion !== null && RED.has(workflow.conclusion)
const word = (conclusion: string) => WORDS[conclusion] ?? conclusion.replace(/_/g, ' ')

function workflowRow(workflow: GithubCiWorkflowDetail, now: number): DetailRow {
  const parts: string[] = []
  if (workflow.conclusion !== null) {
    parts.push(workflow.completedAt === null ? word(workflow.conclusion) : `${word(workflow.conclusion)} ${formatRelativeTime(workflow.completedAt, now)}`)
  }
  if (workflow.running) parts.push('running')
  return {
    label: workflow.name,
    value: parts.join(' · '),
    ...(isRed(workflow) ? { tone: 'warn' as const } : {}),
    ...(workflow.completedAt === null ? {} : { title: formatAbsoluteTime(workflow.completedAt) }),
  }
}

function failureText(workflow: GithubCiWorkflowDetail): string {
  const jobs = workflow.failedJobs.length > 0 ? `: ${workflow.failedJobs.join(', ')}` : ''
  return `${workflow.name} ${word(workflow.conclusion as string)}${jobs}`
}

export const githubCiFormatter: CardFormatter = {
  id: 'github-ci',
  matches: (check) => check.service_key.startsWith(PREFIX),
  format: (check, detail, now) => {
    const workflows = list<GithubCiWorkflowDetail>(detail, 'workflows').filter((workflow) => typeof workflow?.name === 'string')
    const red = workflows.filter(isRed)
    const repo = text(detail, 'repo')
    return {
      title: repo?.split('/')[1] ?? afterPrefix(check.service_key, PREFIX),
      summary:
        workflows.length === 0
          ? 'no runs on main'
          : red.length > 0
            ? `failing · ${red.map((workflow) => workflow.name).join(', ')}`
            : `passing · ${pluralise(workflows.length, 'workflow')}`,
      reason: red.length === 0 ? null : red.map(failureText).join('; '),
      sections: [{ title: 'Workflows', rows: workflows.map((workflow) => workflowRow(workflow, now)), empty: 'No workflow runs on main' }],
    }
  },
}
