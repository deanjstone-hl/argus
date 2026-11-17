import type { CheckDetail, ClaudeWindowHostDetail, ClaudeWindowLimit, D1TableDetail } from '@argus/watchtower-contract'
import { afterPrefix, list, num, record, row, rows, text, timeRow } from '../fields'
import type { CardContent, CardFormatter, DetailRow } from '../types'
import { formatAbsoluteTime, formatCompactCount, formatCurrency, formatDuration, formatStorage, formatUntil } from '../units'

// Capacity against plan limits: a D1 database's size and rows (`d1:<name>`),
// a Supabase project's database size and egress (`supabase-usage:<ref>`),
// and Claude Code usage against the plan's 5-hour and weekly caps (`claude-window`).

const D1 = 'd1:'
const SUPABASE_USAGE = 'supabase-usage:'

const percent = (used: number, limit: number) => `${Math.round((used / limit) * 100)}%`
const wholeCount = (value: number) => value.toLocaleString('en')

export const d1Formatter: CardFormatter = {
  id: 'd1',
  matches: (check) => check.service_key.startsWith(D1),
  format: (check, detail, now) => {
    const size = num(detail, 'sizeBytes')
    const limit = num(detail, 'limitBytes')
    const totalRows = num(detail, 'totalRows')
    const fromAnalytics = text(detail, 'sizeSource') === 'analytics'
    const tables = Array.isArray(detail.tables) ? (detail.tables as D1TableDetail[]) : null

    const usage = size === null ? null : limit === null ? formatStorage(size) : `${formatStorage(size)} of ${formatStorage(limit)} (${percent(size, limit)})`
    return {
      title: text(detail, 'database') ?? afterPrefix(check.service_key, D1),
      summary: [usage, totalRows === null ? null : `${wholeCount(totalRows)} rows`].filter(Boolean).join(' · ') || null,
      reason: size === null || limit === null ? null : `At ${percent(size, limit)} of its ${formatStorage(limit)} limit`,
      rows: rows(
        fromAnalytics
          ? row('Peak size today', size === null ? null : formatStorage(size), {
              title: 'The largest size Cloudflare analytics saw today; it lags a shrink by up to a day',
            })
          : row('Size', size === null ? null : formatStorage(size)),
        row('Limit', limit === null ? null : formatStorage(limit)),
        timeRow('Rows counted', text(detail, 'countedAt'), now),
      ),
      sections: [
        {
          title: 'Tables',
          rows: (tables ?? []).map((table) => ({ label: table.name, value: wholeCount(table.rows) })),
          empty: tables === null ? (text(detail, 'rowsUnavailable') ?? 'Not counted') : undefined,
        },
      ],
    }
  },
}

export const supabaseUsageFormatter: CardFormatter = {
  id: 'supabase-usage',
  matches: (check) => check.service_key.startsWith(SUPABASE_USAGE),
  format: (check, detail) => {
    const size = num(detail, 'dbSizeBytes')
    const limit = num(detail, 'dbLimitBytes')
    const egress = num(detail, 'egressBytes')
    const egressLimit = num(detail, 'egressLimitBytes')
    const plan = text(detail, 'plan')

    const database = size === null ? null : limit === null ? formatStorage(size) : `${formatStorage(size)} of ${formatStorage(limit)}`
    const egressText =
      egress !== null
        ? egressLimit === null
          ? formatStorage(egress)
          : `${formatStorage(egress)} of ${formatStorage(egressLimit)}`
        : `Not reported${egressLimit === null ? '' : ` · limit ${formatStorage(egressLimit)} a cycle`}`

    return {
      title: `${text(detail, 'name') ?? afterPrefix(check.service_key, SUPABASE_USAGE)} database`,
      summary:
        [size === null ? null : limit === null ? formatStorage(size) : `${database} (${percent(size, limit)})`, plan === null ? null : `${plan} plan`]
          .filter(Boolean)
          .join(' · ') || null,
      reason: size === null || limit === null ? null : `Database at ${percent(size, limit)} of the ${plan === null ? '' : `${plan} `}plan’s ${formatStorage(limit)}`,
      rows: rows(
        row('Plan', plan),
        row('Database', database),
        row('Egress', egressText, egress === null ? { title: text(detail, 'egressUnavailable') ?? undefined } : {}),
      ),
    }
  },
}

function hostRow(host: ClaudeWindowHostDetail, now: number): DetailRow {
  if (host.status === 'unreachable' || host.status === 'unsupported') {
    return { label: host.name, value: host.error ?? host.status, tone: 'warn' }
  }
  if (host.status === 'idle' || host.startTime === null) return { label: host.name, value: 'idle' }
  const opened = formatDuration(Math.max(0, (now - Date.parse(host.startTime)) / 1000))
  return {
    label: host.name,
    value: `${formatCompactCount(host.totalTokens)} tokens · ${formatCurrency(host.costUSD)} · opened ${opened} ago`,
  }
}

const roundedPercent = (value: number) => `${Math.round(value * 10) / 10}%`

function readLimit(detail: CheckDetail, key: string): ClaudeWindowLimit | null {
  const limit = record(detail, key)
  const utilization = limit === null ? null : num(limit, 'utilization')
  return limit === null || utilization === null ? null : { utilization, resetsAt: text(limit, 'resetsAt') }
}

const resetText = (limit: ClaudeWindowLimit, now: number) =>
  limit.resetsAt === null || Number.isNaN(Date.parse(limit.resetsAt)) ? null : `resets ${formatUntil(limit.resetsAt, now)}`

function limitRow(label: string, limit: ClaudeWindowLimit | null, now: number): DetailRow | null {
  if (limit === null) return null
  const reset = resetText(limit, now)
  return {
    label,
    value: [roundedPercent(limit.utilization), reset].filter(Boolean).join(' · '),
    ...(limit.resetsAt !== null && reset !== null ? { title: formatAbsoluteTime(limit.resetsAt) } : {}),
  }
}

// Usage against the cap, from Claude's OAuth usage endpoint (issue 952).
function formatLimits(detail: CheckDetail, now: number): CardContent {
  const fiveHour = readLimit(detail, 'fiveHour')
  const sevenDay = readLimit(detail, 'sevenDay')
  const fiveHourReset = fiveHour === null ? null : resetText(fiveHour, now)
  return {
    title: 'Claude window',
    summary:
      fiveHour === null
        ? 'Usage unavailable'
        : [`${roundedPercent(fiveHour.utilization)} of 5-hour`, fiveHourReset, sevenDay === null ? null : `week ${roundedPercent(sevenDay.utilization)}`]
            .filter(Boolean)
            .join(' · '),
    reason: text(detail, 'error'),
    rows: rows(limitRow('5-hour', fiveHour, now), limitRow('Week', sevenDay, now)),
    sections: [],
  }
}

export const claudeWindowFormatter: CardFormatter = {
  id: 'claude-window',
  matches: (check) => check.service_key === 'claude-window',
  format: (_check, detail, now) => {
    // Rows recorded before issue 952 carry the ccusage-blocks shape instead.
    if (detail.source === 'oauth-usage') return formatLimits(detail, now)
    const hosts = list<ClaudeWindowHostDetail>(detail, 'hosts')
    const tokens = num(detail, 'totalTokens')
    const cost = num(detail, 'costUSD')
    const projected = num(detail, 'projectedCost')
    const endsAt = text(detail, 'endsAt')
    const failing = hosts.filter((host) => host.status === 'unreachable' || host.status === 'unsupported')

    return {
      title: 'Claude window',
      summary:
        endsAt === null
          ? 'No window open'
          : [tokens === null ? null : `${formatCompactCount(tokens)} tokens`, cost === null ? null : formatCurrency(cost), `ends ${formatUntil(endsAt, now)}`]
              .filter(Boolean)
              .join(' · '),
      reason: failing.length > 0 ? failing.map((host) => `${host.name}: ${host.error ?? host.status}`).join('; ') : null,
      rows:
        endsAt === null
          ? []
          : rows(
              row('Ends', formatUntil(endsAt, now), { title: formatAbsoluteTime(endsAt) }),
              row('Projected cost', projected === null ? null : formatCurrency(projected)),
            ),
      sections: hosts.length > 0 ? [{ title: 'Hosts', rows: hosts.map((host) => hostRow(host, now)) }] : [],
    }
  },
}
