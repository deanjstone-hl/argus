import type { AiUsageHostDetail } from '@argus/watchtower-contract'
import { list, num } from '../fields'
import type { CardFormatter, DetailRow } from '../types'
import { formatCompactCount, formatCurrency } from '../units'

function usage(tokens: number, cost: number): string {
  return `${formatCompactCount(tokens)} tokens · ${formatCurrency(cost)}`
}

function hostRow(host: AiUsageHostDetail): DetailRow {
  if (host.status === 'unreachable') {
    return { label: host.name, value: `unreachable${host.error ? ` · ${host.error}` : ''}`, tone: 'warn' }
  }
  return { label: host.name, value: usage(host.totalTokens, host.totalCost) }
}

export const aiUsageFormatter: CardFormatter = {
  id: 'ai-usage',
  matches: (check) => check.service_key === 'ai-usage',
  format: (_check, detail) => {
    const hosts = list<AiUsageHostDetail>(detail, 'hosts')
    const tokens = num(detail, 'totalTokens')
    const cost = num(detail, 'totalCost')
    const unreachable = hosts.filter((host) => host.status !== 'healthy')
    return {
      title: 'AI usage',
      summary: tokens === null || cost === null ? null : usage(tokens, cost),
      reason:
        unreachable.length > 0
          ? unreachable.map((host) => `${host.name} ${host.status}${host.error ? `: ${host.error}` : ''}`).join('; ')
          : null,
      sections: hosts.length > 0 ? [{ title: 'Hosts', rows: hosts.map(hostRow) }] : [],
    }
  },
}
