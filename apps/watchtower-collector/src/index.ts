import { createSystemdAdapter, parseUnitList, runSystemctl } from './adapters/systemd.js'
import { createDiskAdapter } from './adapters/disk.js'
import { createUptimeAdapter } from './adapters/uptime.js'
import { createSyncthingAdapter, type SyncthingTls } from './adapters/syncthing.js'
import { createCloudflareAdapter } from './adapters/cloudflare.js'
import { createEndpointAdapters, createTlsAdapters, PUBLIC_ENDPOINTS, PUBLIC_HOSTS } from './adapters/endpoints.js'
import { createWorkerTrafficAdapters, createWorkerTrafficSource } from './adapters/worker-traffic.js'
import { createGithubRunnerAdapters, createRunnerSource, parseRunnerList } from './adapters/github-runners.js'
import { createSupabaseProjectAdapter } from './adapters/supabase-projects.js'
import { createSupabaseUsageAdapters } from './adapters/supabase-usage.js'
import { createD1Adapter, parseD1Databases } from './adapters/d1.js'
import { createClaudeWindowAdapter, createOauthUsageSource } from './adapters/claude-window.js'
import { createPrinterAdapter } from './adapters/printer.js'
import { createScannerAdapter } from './adapters/scanner.js'
import { createHostReportAdapters, createHostReportSource } from './adapters/host-report.js'
import { createLoadAdapter, createMemoryAdapter } from './adapters/homelab-resources.js'
import { createGithubCiAdapters, parseRepoList } from './adapters/github-ci.js'
import { createGithubQueueAdapter } from './adapters/github-queue.js'
import { createTailscaleAdapters, createTailscaleSource, parseTailscaleDevices } from './adapters/tailscale.js'
import { createGithubApi } from './github-api.js'
import { createNoticeBoardAdapter } from './adapters/notice-board.js'
import { createTimersAdapter, listUserTimers } from './timer-freshness.js'
import { createT3StaleAdapter, defaultT3StaleDeps, runT3StaleCheck } from './t3-stale.js'
import { createVaultSyncAdapters, defaultVaultSyncDeps, parseVaultList, runVaultSyncCheck } from './vault-sync.js'
import {
  createAiUsageAdapter,
  createLocalHostSource,
  createRemoteHostSource,
  type HostSource,
} from './adapters/ai-usage.js'
import { runLocalCcusage } from './ccusage.js'
import { startPolling } from './poller.js'
import { checkTargets } from './record-check.js'
import type { Adapter } from './adapter.js'

// A bad store flag or a missing URL stops the collector here, before it polls anything (argus#1200).
const recordTargets = checkTargets().map((target) => target.name).join(', ')

function splitList(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
}

const systemdUnits = parseUnitList(process.env.SYSTEMD_UNITS)

const home = process.env.HOME ?? ''

const adapters: Adapter[] = [
  ...systemdUnits.map((unit) => createSystemdAdapter(unit)),
  // Every --user timer here, judged on whether it will run on time (argus#686).
  createTimersAdapter('homelab', () => listUserTimers(runSystemctl)),
  createDiskAdapter('/'),
  // A separate LV holding the Duplicati store; statfs needs no read access to it.
  createDiskAdapter('/mnt/backups'),
  createUptimeAdapter(),
  createLoadAdapter(),
  createMemoryAdapter(),
]

// Both or neither: a pinned cert is only usable alongside the device name it
// was issued to.
function syncthingTls(): SyncthingTls | undefined {
  const caFile = process.env.SYNCTHING_CA_FILE
  const servername = process.env.SYNCTHING_TLS_SERVERNAME
  if (!caFile && !servername) return undefined
  if (!caFile || !servername) {
    throw new Error('SYNCTHING_CA_FILE and SYNCTHING_TLS_SERVERNAME must be set together')
  }
  return { caFile, servername }
}

const syncthingApiKey = process.env.SYNCTHING_API_KEY
if (syncthingApiKey) {
  adapters.push(
    createSyncthingAdapter(
      process.env.SYNCTHING_URL ?? 'http://localhost:8384',
      syncthingApiKey,
      undefined,
      syncthingTls(),
    ),
  )
} else {
  console.warn('[collector] SYNCTHING_API_KEY not set, skipping syncthing adapter')
}

// The public surface as the internet sees it (argus#687): an anonymous probe
// and the certificate of each host in the links registry. No credentials.
adapters.push(
  ...createEndpointAdapters(PUBLIC_ENDPOINTS),
  ...createTlsAdapters(PUBLIC_HOSTS),
)

const cloudflareToken = process.env.CLOUDFLARE_API_TOKEN
const cloudflareAccountId = process.env.CLOUDFLARE_ACCOUNT_ID
if (cloudflareToken && cloudflareAccountId) {
  for (const name of splitList(process.env.CLOUDFLARE_PAGES_PROJECTS)) {
    adapters.push(
      createCloudflareAdapter(cloudflareAccountId, cloudflareToken, { name, kind: 'pages' }),
    )
  }
  const workers = splitList(process.env.CLOUDFLARE_WORKER_PROJECTS)
  for (const name of workers) {
    adapters.push(
      createCloudflareAdapter(cloudflareAccountId, cloudflareToken, { name, kind: 'worker' }),
    )
  }
  // Error rates per Worker (argus#687), one pair of GraphQL reads a poll.
  const trafficSource = createWorkerTrafficSource({
    accountId: cloudflareAccountId,
    zoneId: process.env.CLOUDFLARE_ZONE_ID,
    token: cloudflareToken,
    scripts: workers,
  })
  adapters.push(...createWorkerTrafficAdapters(trafficSource, workers))
  // D1 size and row counts (argus#688). Size needs nothing new; row counts
  // need Account > D1: Read, on this token or a separate CLOUDFLARE_D1_TOKEN.
  const d1LimitMb = Number(process.env.D1_LIMIT_MB)
  for (const database of parseD1Databases(process.env.D1_DATABASES)) {
    adapters.push(
      createD1Adapter({
        accountId: cloudflareAccountId,
        token: cloudflareToken,
        queryToken: process.env.CLOUDFLARE_D1_TOKEN || undefined,
        database,
        limitBytes: d1LimitMb > 0 ? d1LimitMb * 1_000_000 : undefined,
      }),
    )
  }
} else {
  console.warn('[collector] CLOUDFLARE_API_TOKEN/CLOUDFLARE_ACCOUNT_ID not set, skipping cloudflare adapters')
}

const supabaseMgmtToken = process.env.SUPABASE_MGMT_TOKEN
if (supabaseMgmtToken) {
  for (const ref of splitList(process.env.SUPABASE_PROJECT_REFS)) {
    adapters.push(createSupabaseProjectAdapter(supabaseMgmtToken, ref))
  }
  // Database size against the plan, per project (argus#688).
  adapters.push(...createSupabaseUsageAdapters({ token: supabaseMgmtToken, refs: splitList(process.env.SUPABASE_PROJECT_REFS) }))
} else {
  console.warn('[collector] SUPABASE_MGMT_TOKEN not set, skipping supabase project adapters')
}

// Homelab's self-hosted Actions runners, read from GitHub (argus#682). Inert
// until a token with Administration: read on the runners' repos exists.
const githubOwner = process.env.GITHUB_OWNER ?? 'deanjstone'
const githubRunnersToken = process.env.GITHUB_RUNNERS_TOKEN
const githubRunners = parseRunnerList(process.env.GITHUB_RUNNERS)
if (githubRunnersToken && githubRunners.length > 0) {
  const source = createRunnerSource({ owner: githubOwner, token: githubRunnersToken })
  adapters.push(...createGithubRunnerAdapters(source, githubRunners))
} else {
  console.warn('[collector] GITHUB_RUNNERS_TOKEN/GITHUB_RUNNERS not set, skipping github runner adapters')
}

// Main CI per backlog repo and the runner queue wait (argus#685). Both read
// Actions only, so they need Actions: read, not the runners' Administration:
// read; one ETag-caching client keeps them inside the token's budget.
const githubActionsToken = process.env.GITHUB_ACTIONS_TOKEN
if (githubActionsToken) {
  const api = createGithubApi({ token: githubActionsToken })
  adapters.push(...createGithubCiAdapters(api, parseRepoList(process.env.CI_REPOS, githubOwner)))
  const runnerRepos = [...new Set(githubRunners.map((runner) => `${githubOwner}/${runner.repo}`))]
  if (runnerRepos.length > 0) adapters.push(createGithubQueueAdapter(api, runnerRepos))
} else {
  console.warn('[collector] GITHUB_ACTIONS_TOKEN not set, skipping github ci and runner queue adapters')
}

// Last-seen per tailnet device, from homelab's own tailscaled (argus#685).
const tailscaleDevices = parseTailscaleDevices(process.env.TAILSCALE_DEVICES)
if (tailscaleDevices.length > 0) {
  adapters.push(...createTailscaleAdapters(createTailscaleSource(), tailscaleDevices))
} else {
  console.warn('[collector] TAILSCALE_DEVICES not set, skipping tailscale adapters')
}

// homelab's vaults, by the same vault-staleness.sh the session-start
// `Vault sync:` line runs (argus#686). Set VAULT_DIRS empty to turn them off.
const vaultDirs = parseVaultList(process.env.VAULT_DIRS ?? `${home}/CONTEXT,${home}/CORTEX`)
const vaultSyncDeps = defaultVaultSyncDeps(process.env.VAULT_STALENESS_HOOK ?? `${home}/.argus/hooks/vault-staleness.sh`)
adapters.push(
  ...createVaultSyncAdapters(
    'homelab',
    vaultDirs.map((vault) => vault.name),
    async (name) => {
      const vault = vaultDirs.find((candidate) => candidate.name === name)
      return vault ? runVaultSyncCheck(vault, vaultSyncDeps) : undefined
    },
  ),
)

// homelab's T3 against the newest release, by argus-config's hooks/t3-stale.py
// --no-state: the check behind the work order's `t3 stale:` line (argus#1175).
const t3StaleDeps = defaultT3StaleDeps(process.env.T3_STALE_HOOK ?? `${home}/.argus/hooks/t3-stale.py`)
adapters.push(createT3StaleAdapter('homelab', () => runT3StaleCheck('homelab', t3StaleDeps)))

// The notice board's unacked messages, from its API on this host (argus#686).
const noticeBoardToken = process.env.NOTICE_BOARD_TOKEN
if (noticeBoardToken) {
  adapters.push(createNoticeBoardAdapter({ url: process.env.NOTICE_BOARD_URL ?? 'http://127.0.0.1:3790', token: noticeBoardToken }))
} else {
  console.warn('[collector] NOTICE_BOARD_TOKEN not set, skipping notice-board adapter')
}

// The homelab printer, shared by ipp-usb on localhost (argus#591).
const printerIppUrl = process.env.PRINTER_IPP_URL
if (printerIppUrl) {
  adapters.push(createPrinterAdapter({ url: printerIppUrl }))
} else {
  console.warn('[collector] PRINTER_IPP_URL not set, skipping printer adapter')
}

// The same device's scanner, read over eSCL from the same ipp-usb (argus#591).
// Read-only: it never starts a scan.
const scannerEsclUrl = process.env.SCANNER_ESCL_URL
if (scannerEsclUrl) {
  adapters.push(createScannerAdapter({ url: scannerEsclUrl }))
} else {
  console.warn('[collector] SCANNER_ESCL_URL not set, skipping scanner adapter')
}

const aiUsageHosts: HostSource[] = [createLocalHostSource('homelab', runLocalCcusage)]

const aiUsageWsl2Url = process.env.AI_USAGE_WSL2_URL
const aiUsageWsl2Token = process.env.AI_USAGE_WSL2_TOKEN
if (aiUsageWsl2Url && aiUsageWsl2Token) {
  aiUsageHosts.push(createRemoteHostSource('wsl2', aiUsageWsl2Url, aiUsageWsl2Token))
} else {
  console.warn('[collector] AI_USAGE_WSL2_URL/AI_USAGE_WSL2_TOKEN not set, skipping wsl2 ai-usage host')
}

const aiUsageWindowsUrl = process.env.AI_USAGE_WINDOWS_URL
const aiUsageWindowsToken = process.env.AI_USAGE_WINDOWS_TOKEN
if (aiUsageWindowsUrl && aiUsageWindowsToken) {
  aiUsageHosts.push(createRemoteHostSource('windows', aiUsageWindowsUrl, aiUsageWindowsToken))
} else {
  console.warn('[collector] AI_USAGE_WINDOWS_URL/AI_USAGE_WINDOWS_TOKEN not set, skipping windows ai-usage host')
}

// The 5-hour and weekly windows against the plan's cap (argus#952), from Claude's OAuth usage
// endpoint with the token in this host's ~/.claude/.credentials.json: no ccusage, no shim.
adapters.push(createAiUsageAdapter(aiUsageHosts), createClaudeWindowAdapter(createOauthUsageSource().fetchUsage))

// LNV-LGN5: the Windows laptop and its WSL2, from the WSL2 usage-shim's
// GET /host, authenticated with the same shim token as its /usage (argus#682).
const hostReportWsl2Url = process.env.HOST_REPORT_WSL2_URL
if (hostReportWsl2Url && aiUsageWsl2Token) {
  const source = createHostReportSource({ url: hostReportWsl2Url, token: aiUsageWsl2Token })
  adapters.push(
    ...createHostReportAdapters(
      source,
      splitList(process.env.HOST_REPORT_WSL2_UNITS ?? 'agent-engine.service,memory-reconcile.timer'),
      Date.now,
      splitList(process.env.HOST_REPORT_WSL2_VAULTS ?? 'CONTEXT,CORTEX'),
    ),
  )
} else {
  console.warn('[collector] HOST_REPORT_WSL2_URL/AI_USAGE_WSL2_TOKEN not set, skipping lnv-lgn5 host adapters')
}

console.log(`[collector] starting with ${adapters.length} adapter(s), recording to ${recordTargets}`)
const stopPolling = startPolling(adapters)

function shutdown(signal: string): void {
  console.log(`[collector] received ${signal}, shutting down`)
  stopPolling()
  process.exit(0)
}

process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))
