// The one definition of what a watchtower check is, shared by the three
// pieces that exchange it: the collector writes checks, the Worker validates
// and stores them, and the dashboard reads them back.

export const HEALTH_STATUSES = ['healthy', 'degraded', 'down', 'unreachable'] as const

export type HealthStatus = (typeof HEALTH_STATUSES)[number]

export type CheckDetail = Record<string, unknown>

// The body of POST /watchtower/checks. id and checked_at are absent on
// purpose: the Worker generates both server-side and never trusts a client
// value for either.
export interface CheckInput {
  service_key: string
  host: string
  status: HealthStatus
  detail?: CheckDetail | null
}

// One row of GET /watchtower/checks: the latest check per service_key.
export interface ServiceCheck {
  service_key: string
  host: string
  status: HealthStatus
  detail: CheckDetail | null
  checked_at: string
}

export function isHealthStatus(value: unknown): value is HealthStatus {
  return (HEALTH_STATUSES as readonly unknown[]).includes(value)
}

// Returns the check carried by an untrusted request body, or null when the
// body does not satisfy the contract. Fields outside the contract (such as a
// client-supplied id or checked_at) are dropped, not passed through.
export function parseCheckInput(value: unknown): CheckInput | null {
  if (typeof value !== 'object' || value === null) return null
  const candidate = value as Record<string, unknown>
  const { service_key: serviceKey, host, status, detail } = candidate
  if (typeof serviceKey !== 'string' || serviceKey.length === 0) return null
  if (typeof host !== 'string' || host.length === 0) return null
  if (!isHealthStatus(status)) return null
  if (detail !== undefined && detail !== null && typeof detail !== 'object') return null
  return { service_key: serviceKey, host, status, detail: (detail as CheckDetail | null | undefined) ?? null }
}

// Detail shapes for the checks whose detail the dashboard renders as more
// than flat key/value rows.

// One host in the ai-usage check's `hosts` array. A host is never `down`: a
// host that cannot be reached is `unreachable`.
export interface AiUsageHostDetail {
  name: string
  status: Exclude<HealthStatus, 'down'>
  totalTokens: number
  totalCost: number
  latestPeriod: string | null
  error?: string
}

// One folder in the Syncthing check's `folders` array.
export interface SyncthingFolderDetail {
  id: string
  state: string
  errors: number
  needTotalItems: number
}

// The printer check's detail (watchtower-collector's printer adapter).
export type PrinterState = 'idle' | 'processing' | 'stopped' | 'unknown'

export type PrinterJobState =
  | 'pending'
  | 'pending-held'
  | 'processing'
  | 'processing-stopped'
  | 'canceled'
  | 'aborted'
  | 'completed'
  | 'unknown'

// One ink cartridge. `level` and `lowLevel` are percentages; `level` is null
// when the printer cannot tell.
export interface PrinterMarkerDetail {
  name: string
  color: string | null
  level: number | null
  lowLevel: number | null
  low: boolean
}

// One job. `at` is when a queued job was created or a finished job completed,
// already corrected for the printer's clock; null when the printer gave no
// time that could be trusted.
export interface PrinterJobDetail {
  id: number
  name: string
  user: string | null
  state: PrinterJobState
  pages: number | null
  at: string | null
}

// A type alias, not an interface: an interface has no implicit index
// signature, so it would not be assignable to CheckDetail.
export type PrinterDetail = {
  state: PrinterState
  // printer-state-reasons as the printer reports them, minus `none`.
  reasons: string[]
  message: string | null
  model: string | null
  markers: PrinterMarkerDetail[]
  queue: PrinterJobDetail[]
  recentJobs: PrinterJobDetail[]
  // How far the printer's clock is ahead of the collector's (negative when
  // behind), or null when the printer does not report its time.
  clockSkewSeconds: number | null
}

// The scanner check's detail (watchtower-collector's scanner adapter), read
// from the scanner's eSCL ScannerStatus.
export type ScannerState = 'idle' | 'processing' | 'testing' | 'stopped' | 'down' | 'unknown'

export type ScannerJobState = 'pending' | 'processing' | 'completed' | 'canceled' | 'aborted' | 'unknown'

// One scan job the scanner still remembers. `images` is the pages it has
// produced; `at` is dated from the job's age, null when the scanner gave none.
export interface ScannerJobDetail {
  id: string
  state: ScannerJobState
  images: number | null
  at: string | null
}

export type ScannerDetail = {
  state: ScannerState
  // scan:AdfState without its ScannerAdf prefix, in kebab case (`empty`,
  // `loaded`, `jam`, `door-open`), or null when the reply carries none.
  adfState: string | null
  recentScans: ScannerJobDetail[]
}

// A systemd unit's check detail (watchtower-collector's systemd adapter and
// the LNV-LGN5 host report). Times are ISO strings, null when systemd has
// none (a unit that never started, a service still running).
export type SystemdUnitDetail = {
  scope: 'user' | 'system'
  loadState: string
  activeState: string
  subState: string
  // The unit's own Result (`success`, `exit-code`, `signal`…).
  result: string | null
  activeSince: string | null
  restarts: number | null
  // Timers only: when it last fired, when it fires next, and how the
  // service it triggers last ran.
  timer?: SystemdTimerDetail
}

export type SystemdTimerDetail = {
  service: string
  lastTrigger: string | null
  nextTrigger: string | null
  // True when the timer has no next trigger, realtime or monotonic, and so
  // will never fire again. Null when the reading could not tell; absent on
  // rows recorded before it was read.
  unscheduled?: boolean | null
  lastRun: {
    activeState: string
    result: string | null
    exitStatus: number | null
    startedAt: string | null
    exitedAt: string | null
  }
}

// One self-hosted GitHub Actions runner, from GitHub's runners API. `busy`
// is GitHub's own flag: the runner is executing a job right now.
export type GithubRunnerDetail = {
  repo: string
  name: string
  online: boolean
  busy: boolean
  version: string | null
  labels: string[]
}

// What watchtower-usage-shim's GET /host reports about the machine it runs
// on (WSL2 on LNV-LGN5): raw facts only. The collector decides the status.
export type HostDumpDirReport = {
  path: string
  count: number
  totalBytes: number
  newestAt: string | null
}

export type HostPressure = { avg10: number; avg60: number; avg300: number }

export type HostReport = {
  reportedAt: string
  // The Windows system drive as WSL2 sees it (/mnt/c), or null when it is
  // not mounted.
  disk: { path: string; totalBytes: number; freeBytes: number } | null
  crashDumps: {
    // %LOCALAPPDATA%\Temp\wsl-crashes: WSL's own dumps, about 2-6 GB each.
    wsl: HostDumpDirReport | null
    // %LOCALAPPDATA%\CrashDumps: Windows apps' dumps.
    windows: HostDumpDirReport | null
  }
  memory: {
    totalBytes: number
    availableBytes: number
    swapTotalBytes: number
    swapFreeBytes: number
    // /proc/pressure/memory, null when the kernel has no PSI.
    pressure: { some: HostPressure; full: HostPressure } | null
  }
  // `systemctl --user show` properties, by unit, with TZ=UTC. A timer also
  // carries the properties of the service it triggers.
  units: Record<string, { unit: Record<string, string>; triggers?: Record<string, string> }>
  // Every --user timer, as `systemctl --user list-unit-files --type=timer`
  // lists them (disabled ones included), in the same shape as `units`.
  // Absent from a shim older than the timer-freshness card.
  timers?: Record<string, { unit: Record<string, string>; triggers?: Record<string, string> }>
  // memory-reconcile's heartbeat file, which runs on WSL2 only.
  memoryReconcile?: MemoryReconcileReport
  // The vault-sync SessionStart check, run once per vault.
  vaults?: VaultSyncReport[]
  // argus-config's hooks/t3-stale.py, run for this host. Absent from a shim
  // older than the T3 card.
  t3Stale?: T3StaleReport
}

// What hooks/t3-stale.py --no-state printed: `reading` is that JSON parsed
// (a measurement, or `{ host, error }` when it could not measure), null when
// the hook could not be run or printed something else; `error` says why.
export type T3StaleReport = {
  reading: unknown
  error: string | null
}

// memory-mcp's per-machine heartbeat, as the reconciler writes it to
// ~/.argus/memory-reconcile-heartbeat.json. `heartbeat` is the parsed file,
// null when there is no file; `error` says why it could not be read.
export type MemoryReconcileReport = {
  path: string
  heartbeat: unknown
  error: string | null
}

// One vault as argus-config's hooks/vault-staleness.sh sees it: the lines it
// prints are the session-start `Vault sync:` signal, and none means healthy.
export type VaultSyncReport = {
  name: string
  path: string
  // The vault is a git checkout; the hook says nothing about one that is not.
  checkout: boolean
  lines: string[]
  // The hook could not be run.
  error: string | null
}

// The LNV-LGN5 checks built from a HostReport.
export type HostDiskDetail = {
  path: string
  totalBytes: number
  freeBytes: number
  pctUsed: number
}

export type HostCrashDumpsDetail = {
  wsl: HostDumpDirReport | null
  windows: HostDumpDirReport | null
}

export type HostMemoryDetail = {
  totalBytes: number
  availableBytes: number
  swapTotalBytes: number
  swapFreeBytes: number
  pressure: { some: HostPressure; full: HostPressure } | null
}

// homelab's own load average, from the collector's /proc/loadavg (argus#685).
// `cpus` is the online CPU count the thresholds are scaled by.
export type HostLoadDetail = {
  load1: number
  load5: number
  load15: number
  cpus: number
}

// The latest decisive result of one workflow on a repo's main branch: the
// newest run that succeeded or failed, skipping skipped and cancelled runs.
export type GithubCiWorkflowDetail = {
  name: string
  // success, failure, timed_out or startup_failure; null when only a running
  // or never-decisive run is in the window.
  conclusion: string | null
  completedAt: string | null
  headSha: string | null
  runUrl: string | null
  // A newer run of this workflow is queued or in progress.
  running: boolean
  // The jobs that failed in that run, by name.
  failedJobs: string[]
}

export type GithubCiDetail = {
  repo: string
  branch: string
  workflows: GithubCiWorkflowDetail[]
}

// How long jobs sit queued before a homelab runner takes them, per runner
// repo. Waits are seconds from a job's creation to its start; a job with
// `needs:` is created only when what it needs has finished.
export type GithubQueueJobDetail = {
  repo: string
  workflow: string
  job: string
  since: string
  url: string | null
}

export type GithubQueueRepoDetail = {
  repo: string
  waiting: number
  oldestWaiting: GithubQueueJobDetail | null
  jobs: number
  medianWaitSeconds: number | null
  p90WaitSeconds: number | null
  maxWaitSeconds: number | null
}

// One job that is waiting for a runner or running on one, on any runner:
// self-hosted or GitHub-hosted (`selfHosted` tells them apart). A waiting job
// has no runner and no start yet: GitHub gives a queued job a placeholder
// started_at, which is not carried here.
export type GithubQueueActiveJob = {
  repo: string
  workflow: string
  runId: number
  job: string
  runnerName: string | null
  queuedAt: string
  startedAt: string | null
  selfHosted: boolean
  url: string | null
}

// `waitingJobs` and `inProgressJobs` are the full lists across every repo,
// oldest first, over the same recent runs as the wait statistics. A check
// stored before they were added lacks both, so a reader of stored checks
// treats a missing list as unknown, not as empty.
export type GithubQueueDetail = {
  windowHours: number
  waiting: number
  oldestWaiting: GithubQueueJobDetail | null
  repos: GithubQueueRepoDetail[]
  waitingJobs: GithubQueueActiveJob[]
  inProgressJobs: GithubQueueActiveJob[]
}

// One tailnet device as homelab's `tailscale status --json` sees it.
// `lastSeen` is null while the device is online (tailscale reports the zero
// time then). `companion` is a device this one should be online alongside,
// such as WSL2 inside its Windows host.
export type TailscaleDeviceDetail = {
  name: string
  dnsName: string | null
  os: string | null
  self: boolean
  online: boolean
  lastSeen: string | null
  ips: string[]
  keyExpiry: string | null
  offlineAfterMs: number
  companion: string | null
  companionOnline: boolean | null
}

// Why a timer will not run on time: not loaded, disabled, not active,
// nothing scheduled (it will never fire again), its next run is overdue, or
// its last run failed.
export type TimerProblem = 'not-loaded' | 'disabled' | 'inactive' | 'unscheduled' | 'overdue' | 'failed'

// One --user timer on the timer-freshness card. `problem` is null when it is
// fine. A timer shipped by a package (`vendor`) is not faulted for being
// disabled: nobody here enabled it.
export type TimerFreshnessDetail = {
  timer: string
  service: string
  unitFileState: string
  activeState: string
  vendor: boolean
  lastTrigger: string | null
  nextTrigger: string | null
  lastRun: SystemdTimerDetail['lastRun']
  // When the service last exited successfully, if its latest run did.
  lastSuccessAt: string | null
  problem: TimerProblem | null
}

export type TimersDetail = {
  host: string
  timers: TimerFreshnessDetail[]
}

// The memory-reconcile card. `lastRunAt` is the heartbeat's; refusals are
// the writes and deletions the reconciler will not settle on its own.
export type MemoryReconcileDetail = {
  path: string
  lastRunAt: string | null
  ok: boolean | null
  // The failed run's error; not `error`, which the dashboard reads as a
  // check that could not be made.
  lastError: string | null
  written: number | null
  deleted: number | null
  refusals: Array<{ key: string; reason: string; seenAt: string | null }>
  staleAfterMs: number
}

// A host's T3 against the newest release on its channel: `behindDays` is whole
// days since the earliest newer release was published, 0 when up to date.
// `thresholdDays` is the hook's T3_STALE_DAYS.
export type T3StaleDetail = {
  host: string
  channel: string
  active: string
  newest: string
  behindDays: number
  thresholdDays: number
}

export type VaultSyncDetail = {
  vault: string
  path: string
  checkout: boolean
  lines: string[]
}

// The notice board's queue: messages delivered to no session yet (queued)
// or delivered but not acked (claimed), per repo.
export type NoticeBoardRepoDetail = {
  repo: string
  queued: number
  claimed: number
  dead: number
  oldestUnackedAt: string | null
}

export type NoticeBoardQueueDetail = {
  unacked: number
  oldestUnackedAt: string | null
  dead: number
  // Dead messages created in the last `recentDeadMs`: those are new failures.
  recentDead: number
  recentDeadMs: number
  oldUnackedAfterMs: number
  repos: NoticeBoardRepoDetail[]
}

// One public endpoint's anonymous HTTPS probe (`endpoint:<host>`). `expected`
// is what an anonymous request should get: a 401 from an API that wants a
// token means it is up, and Cloudflare Access answers with a redirect to its
// login, whose host is kept in `redirectHost`.
export type EndpointProbeDetail = {
  url: string
  expected: number
  expectedRedirectHost: string | null
  statusCode: number
  redirectHost: string | null
  latencyMs: number
  slowAfterMs: number
}

// The certificate a host presents (`tls:<host>`). `daysLeft` is whole days
// to `validTo`, negative once expired.
export type TlsCertDetail = {
  host: string
  validFrom: string
  validTo: string
  daysLeft: number
  issuer: string | null
  subject: string | null
  names: string[]
  degradedBelowDays: number
  downBelowDays: number
}

// A Worker's traffic over the last `windowMinutes` (`worker-traffic:<script>`).
// `invocations` is Workers analytics, by invocation status (`success`,
// `scriptThrewException`, `clientDisconnected`…); `errors` is the scripts'
// own failures. `http` is the zone's edge response codes on the Worker's
// route, null when the route is unknown or the token cannot read zone
// analytics, with `httpUnavailable` saying which. `api` marks a Worker
// whose clients hold tokens, so a run of 4xx is a credential failure.
export type WorkerTrafficDetail = {
  script: string
  windowMinutes: number
  api: boolean
  route: string | null
  invocations: { requests: number; errors: number; byStatus: Record<string, number> }
  http: { requests: number; clientErrors: number; serverErrors: number } | null
  httpUnavailable: string | null
  thresholds: {
    minRequests: number
    serverErrorRateDegraded: number
    serverErrorRateDown: number
    clientErrorRateDegraded: number
    minClientErrors: number
  }
}

// Capacity against plan limits. Every limit check carries the fraction of
// the limit at which it degrades and goes down, so the card can say why.
export type CapacityThresholds = { degradedAt: number; downAt: number }

// A D1 database (`d1:<name>`). `sizeSource` says where `sizeBytes` came
// from: `query` is the database's size when its rows were counted;
// `analytics` is the largest size GraphQL analytics saw that day, which
// lags a shrink by up to a day. `tables` is null while the token cannot
// query D1, with `rowsUnavailable` saying so.
export type D1TableDetail = { name: string; rows: number }
export type D1Detail = {
  database: string
  databaseId: string
  sizeBytes: number | null
  sizeSource: 'query' | 'analytics' | null
  limitBytes: number
  tables: D1TableDetail[] | null
  totalRows: number | null
  countedAt: string | null
  rowsUnavailable: string | null
  thresholds: CapacityThresholds
}

// A Supabase project's usage against its organisation's plan
// (`supabase-usage:<ref>`). Limits are null on a plan the collector has no
// figures for; egress is null while no API the token can reach reports it,
// with `egressUnavailable` saying so.
export type SupabaseUsageDetail = {
  ref: string
  name: string
  plan: string | null
  dbSizeBytes: number
  dbLimitBytes: number | null
  egressBytes: number | null
  egressLimitBytes: number | null
  egressUnavailable: string | null
  thresholds: CapacityThresholds
}

// One host's Claude Code usage in its current 5-hour window, from
// `ccusage blocks --active` (`claude-window`, before argus#952). `idle`: no
// window open; `unsupported`: the host's usage shim predates GET /blocks.
// Only rows recorded before the OAuth usage source carry it.
export type ClaudeWindowHostDetail = {
  name: string
  status: 'active' | 'idle' | 'unsupported' | 'unreachable'
  startTime: string | null
  endTime: string | null
  lastActivity: string | null
  totalTokens: number
  costUSD: number
  projectedCost: number | null
  models: string[]
  error?: string
}

// One usage window against the account's cap: `utilization` is a percent,
// `resetsAt` the ISO time the window resets (null when the reply omits it).
export type ClaudeWindowLimit = {
  utilization: number
  resetsAt: string | null
}

// The `claude-window` card (argus#952): the account-wide 5-hour and weekly
// windows from Claude's OAuth usage endpoint. A degraded check carries the
// reason in `error` and null windows.
//
// The fields from `hosts` down are the ccusage-blocks shape that rows
// recorded before argus#952 still carry; the card reads them when
// `fiveHour` is absent, and the collector no longer writes them.
export type ClaudeWindowDetail = {
  source?: 'oauth-usage'
  fiveHour?: ClaudeWindowLimit | null
  sevenDay?: ClaudeWindowLimit | null
  error?: string
  hosts?: ClaudeWindowHostDetail[]
  totalTokens?: number
  costUSD?: number
  projectedCost?: number | null
  // The latest end of any open window; null when none is open.
  endsAt?: string | null
}
