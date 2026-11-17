import type { CheckDetail, ServiceCheck } from '@argus/watchtower-contract'
import { row, rows } from './fields'
import { aiUsageFormatter } from './kinds/ai-usage'
import { claudeWindowFormatter, d1Formatter, supabaseUsageFormatter } from './kinds/capacity'
import { cloudflareFormatter } from './kinds/cloudflare'
import { printerFormatter, scannerFormatter } from './kinds/devices'
import { githubCiFormatter } from './kinds/github-ci'
import { githubQueueFormatter, githubRunnerFormatter } from './kinds/github-runners'
import { diskFormatter, loadFormatter, supabaseFormatter, uptimeFormatter } from './kinds/homelab'
import { crashDumpsFormatter, hostDiskFormatter } from './kinds/lnv-lgn5'
import { memoryFormatter } from './kinds/memory'
import { memoryReconcileFormatter } from './kinds/memory-reconcile'
import { noticeBoardFormatter } from './kinds/notice-board'
import { endpointFormatter, tlsFormatter, workerTrafficFormatter } from './kinds/public-surface'
import { syncthingFormatter } from './kinds/syncthing'
import { systemdFormatter } from './kinds/systemd'
import { t3StaleFormatter } from './kinds/t3-stale'
import { tailscaleFormatter } from './kinds/tailscale'
import { timersFormatter } from './kinds/timers'
import { vaultSyncFormatter } from './kinds/vault-sync'
import type { CardContent, CardFormatter, CardView, DetailRow } from './types'
import { formatAbsoluteTime, formatRelativeTime } from './units'

// One formatter per card kind, matched by service_key (exact or prefix).
// A new card kind adds its file under kinds/ and one line here; a key no
// formatter matches still renders, as labelled flat fields.
export const CARD_FORMATTERS: CardFormatter[] = [
  aiUsageFormatter,
  cloudflareFormatter,
  syncthingFormatter,
  printerFormatter,
  scannerFormatter,
  diskFormatter,
  uptimeFormatter,
  systemdFormatter,
  supabaseFormatter,
  githubRunnerFormatter,
  hostDiskFormatter,
  crashDumpsFormatter,
  memoryFormatter,
  loadFormatter,
  githubCiFormatter,
  githubQueueFormatter,
  tailscaleFormatter,
  timersFormatter,
  memoryReconcileFormatter,
  vaultSyncFormatter,
  t3StaleFormatter,
  noticeBoardFormatter,
  endpointFormatter,
  tlsFormatter,
  workerTrafficFormatter,
  d1Formatter,
  supabaseUsageFormatter,
  claudeWindowFormatter,
]

// The slowest collector adapters (disk, uptime, Cloudflare, Supabase,
// ai-usage) poll every 5 minutes; the rest every 30-60s. Three
// missed 5-minute polls is unambiguous: nothing reports on time any more.
// The collector cannot share this constant (watchtower-contract is
// types-only at runtime), so keep it in step with watchtower-collector.
export const STALE_AFTER_MS = 3 * 5 * 60_000

export function isStale(checkedAt: string, now: number): boolean {
  return now - Date.parse(checkedAt) > STALE_AFTER_MS
}

function titleCase(key: string): string {
  return key.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/^./, (c) => c.toUpperCase()).replace(/ ([A-Z])/g, (_m, c: string) => ` ${c.toLowerCase()}`)
}

// Unknown kinds: scalar fields as labelled rows; nested values stay in the
// raw view rather than being dumped into a row.
function fallback(detail: CheckDetail): CardContent {
  return {
    rows: rows(
      ...Object.entries(detail)
        .filter(([key]) => key !== 'error')
        .map(([key, value]): DetailRow | null =>
          typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
            ? row(titleCase(key), String(value))
            : null,
        ),
    ),
  }
}

export function formatCard(check: ServiceCheck, now: number): CardView {
  const detail = check.detail ?? {}
  const formatter = CARD_FORMATTERS.find((candidate) => candidate.matches(check))
  // A thrown check is recorded as `{ error }` alone; its message is the
  // reason and there is nothing else to format.
  const error = typeof detail.error === 'string' && detail.error !== '' ? detail.error : null
  const onlyError = error !== null && Object.keys(detail).length === 1
  const content = onlyError ? {} : formatter ? formatter.format(check, detail, now) : fallback(detail)
  const healthy = check.status === 'healthy'

  return {
    title: content.title ?? check.service_key,
    summary: content.summary ?? null,
    reason: healthy ? null : (error ?? content.reason ?? 'No reason reported'),
    stale: isStale(check.checked_at, now)
      ? { age: formatRelativeTime(check.checked_at, now), at: formatAbsoluteTime(check.checked_at) }
      : null,
    rows: content.rows ?? [],
    sections: (content.sections ?? []).filter((section) => section.rows.length > 0 || section.empty !== undefined),
    raw: check.detail === null ? null : JSON.stringify(check.detail, null, 2),
  }
}
