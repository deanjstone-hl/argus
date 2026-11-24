# @argus/watchtower-collector

Standalone Node service that polls infra and usage sources and records service checks for
[watchtower](../watchtower/). Runs on homelab under its own systemd user unit; writes every check
to the [ops hub](https://github.com/deanjstone-hl/ops-hub) with `POST /watchtower/checks`
([argus#1200](https://github.com/deanjstone/argus/issues/1200), decided in
[argus#1165](https://github.com/deanjstone/argus/issues/1165)). The dual write to D1 through the
`argus-watchtower-api` Worker is off by default since the cutover
([argus#66](https://github.com/deanjstone/argus/issues/66), [argus#44](https://github.com/deanjstone/argus/issues/44)).

## Where checks are written

| Variable | Meaning |
|---|---|
| `WATCHTOWER_D1` | `off` stops writing to D1. `on` writes, which needs `WATCHTOWER_WORKER_URL` (and `WATCHTOWER_COLLECTOR_TOKEN`, the Worker's bearer). `deploy.sh` writes `off` on every deploy unless the deploy shell sets `WATCHTOWER_D1=on`; a hand-edited env file is overwritten at the next deploy. With the variable unset (no `deploy.sh`, a bare `node dist/index.js`) the collector still defaults to `on` |
| `WATCHTOWER_HUB` | `off` stops writing to the hub. Unset: write when `WATCHTOWER_HUB_URL` and `WATCHTOWER_HUB_TOKEN` are both set. `on`: the same, but a missing URL or token stops the collector at start |
| `WATCHTOWER_HUB_URL` | The hub's origin, no path; `deploy.sh` defaults it to `NOTICE_BOARD_URL` (`http://127.0.0.1:3790` on homelab) |
| `WATCHTOWER_HUB_TOKEN` | The collector's own hub device token (a `watchtower-collector` entry in the hub's `NOTICE_BOARD_TOKENS`). `deploy.sh` writes it from the BWS secret `notice-board-token-watchtower-collector` ([argus#52](https://github.com/deanjstone/argus/issues/52)) and writes no line, with a warning and no failure, while the secret is missing; the ops hub's `deploy.sh` reads the same secret. Creating the secret is an owner step ([argus#1202](https://github.com/deanjstone/argus/issues/1202)); until it exists the hub is not written and the collector logs that at start |

A flag that is neither `on` nor `off`, or every store off, stops the collector at start, so a typo cannot
silently stop recording. The two writes are independent: a hub that is down does not cost a D1 write,
nor the other way round, and a failure is logged with the store's name (`d1:` or `hub:`). Each store
retries a network failure or a 5xx once, never a 4xx. The cutover is `WATCHTOWER_D1=off`, which `deploy.sh`
now writes by default; to write D1 again for a deployment, run it as `WATCHTOWER_D1=on bash deploy.sh`.

The public-surface probes (`endpoint:<host>` and `tls:<host>`) come from the links registry's live entries.
The `watchtower` dashboard entry is skipped (`NOT_PROBED` in `src/adapters/endpoints.ts`) because its Pages
project is deleted by [argus#44](https://github.com/deanjstone/argus/issues/44); the registry is vendored and
drops the entry itself with [argus#45](https://github.com/deanjstone/argus/issues/45).

## Run

```bash
pnpm run dev        # tsx watch src/index.ts
pnpm run build      # tsc → dist/
pnpm run start      # node dist/index.js
pnpm run test       # vitest
```

Needs a populated env file at `~/.config/argus/watchtower-collector.env` — see `.env.example`, or let `deploy.sh` write it from Bitwarden.

## Deploy

```bash
./deploy.sh
```

Run it **on the host the collector runs on**. It writes `~/.config/argus/watchtower-collector.env` from Bitwarden Secrets Manager
(needs `BWS_ACCESS_TOKEN`, see `~/.argus/watchtower/.bws-token`), then builds and restarts
`watchtower-collector.service` if that unit is installed here. On any other host it stops after
writing the env file.

Its env file is `~/.config/argus/watchtower-collector.env` (mode 600), outside the deploy copy so an agent can fix it ([argus-config#1267](https://github.com/deanjstone/argus-config/issues/1267)). The old `apps/watchtower-collector/.env` still loads and is deprecated; the one-time move is argus-config's `scripts/owner-steps/1267.sh`. `deploy.sh` warns while the old file is still there; the unit loads the old file first and the new one after it, so the new one wins.

The unit file is in [`systemd/`](systemd/); it runs from this directory in the checkout, so a
deploy is a `git pull` plus the above. On a host where the unit is installed, `deploy.sh` also
refreshes it from `systemd/` ([argus#53](https://github.com/deanjstone/argus/issues/53)): it
compares content (`cmp -s`, since a `cp` always bumps the mtime), copies the file to
`~/.config/systemd/user/` only when it differs, and runs `systemctl --user daemon-reload` before
the restart, so a unit change reaches the host with the next deploy. A unit that is a symlink into
the checkout is never copied over; it is only reloaded when systemd reports `NeedDaemonReload`.
A host where the unit is not installed is left alone (the first install is a one-time owner step:
`install -m 644 systemd/watchtower-collector.service ~/.config/systemd/user/`).

The unit sets `MemoryHigh=512M` and `ManagedOOMPreference=avoid` (argus#845). The cgroup counts
every `systemctl` and `ccusage` child the collector spawns, so its figure is well above the Node
process's own RSS. To read it: `systemctl --user show watchtower-collector -p MemoryCurrent,MemoryPeak,NRestarts`.
Polls are spread over the first 30 seconds (`src/poller.ts`) and keep their offsets, and the
timers card and ccusage run a few child processes at a time rather than all at once.
`pnpm run measure:memory` polls the fixture-fed adapters repeatedly and prints their heap and RSS.

## Layout

- `src/adapters/` — one module per polled source (systemd, disk, uptime, Syncthing,
  Cloudflare, Supabase projects, AI usage, printer, scanner, GitHub runners, the LNV-LGN5 host
  report, homelab load and memory, main CI, the runner queue, Tailscale, the notice board, the
  the registry's public endpoints and their certificates, Worker traffic). An adapter returns the result it could work out and
  throws for anything it could not
- `src/adapter.ts` — the `Adapter` interface and `CheckError`
- `src/systemd-unit.ts` — how `systemctl show` properties become a unit's status, shared by the
  homelab systemd adapter and the LNV-LGN5 host report
- `src/memory.ts` — `/proc/meminfo` and PSI parsing and the memory thresholds, shared by homelab's
  memory card and the LNV-LGN5 one
- `src/t3-stale.ts` — the T3 version and days-behind card, from argus-config's `hooks/t3-stale.py`.
- `src/timer-freshness.ts`, `src/vault-sync.ts`, `src/memory-reconcile.ts` — the silent-failure
  checks, each shared by homelab's own card and the LNV-LGN5 one read from the shim
- `src/github-api.ts` — the REST client the main-CI and runner-queue cards share: ETag
  revalidation (a 304 costs no rate limit) and never refetching a finished run's jobs
- `src/poller.ts` — the polling loop; `runCheck` turns every throw into the recorded result: a
  `CheckError`'s own status, else the adapter's `failureStatus` (`unreachable` for the remote
  APIs), else `down`
- `src/record-check.ts` — writes each check to every store; `src/check-targets.ts` reads the flags above
  into the stores; `src/worker-client.ts` (D1), `src/hub-client.ts` (hub) and `src/post-check.ts`
  (the shared `POST /watchtower/checks` request and its one retry)
- `src/**/*.test.ts` — vitest, co-located

## Printer

`src/adapters/printer.ts` polls the homelab USB printer (Epson WF-3825) over IPP at
`PRINTER_IPP_URL`, which `deploy.sh` defaults to `http://localhost:60000/ipp/print`: ipp-usb's
share of it (homelab `services/printing/`). It sends `Get-Printer-Attributes` and two `Get-Jobs`
(`not-completed` and `completed`) through a small IPP codec in `src/ipp.ts`, so the tests run on
byte fixtures with no printer and no `ipptool`.

| State | Meaning |
|---|---|
| `healthy` | Idle or processing, no warning or error reasons, no cartridge at or below its low level |
| `degraded` | A `-warning` reason (or a bare supply-low reason), or a cartridge at or below its low level |
| `down` | `stopped`, an error reason (a jam, no paper, cover open; a reason with no suffix counts as an error), an HTTP error, or a reply that is not IPP |
| `unreachable` | Nothing answered: ipp-usb exits when the printer is unplugged or switched off |

The detail carries the state reasons, ink levels, the queue and the five newest finished jobs.
The printer's clock drifts (about two hours ahead on 2026-10-09), so job times are corrected by
the skew between its `printer-current-time` and the collector's clock, or dated from
`time-at-*` against `printer-up-time` when it does not report its time, and left out otherwise.

## Scanner

`src/adapters/scanner.ts` reads the same device's scanner over eSCL at `SCANNER_ESCL_URL`, which
`deploy.sh` defaults to `http://localhost:60000/eSCL` (the same ipp-usb). It sends one
`GET /eSCL/ScannerStatus` per poll and never starts a scan
([#591](https://github.com/deanjstone/argus/issues/591)).

| State | Meaning |
|---|---|
| `healthy` | `Idle`, `Processing` or `Testing`, with the feeder empty, loaded or feeding (or not reported) |
| `degraded` | A feeder fault: jam, door or hatch open, mispick, multipick and the like |
| `down` | `Stopped` or `Down`, an HTTP error, or a reply that is not a `ScannerStatus` |
| `unreachable` | Nothing answered: ipp-usb exits when the printer is unplugged or switched off |

The detail carries the scanner state, the feeder state and the five newest jobs the scanner still
remembers, each dated from its `scan:Age`. Once homelab's own scan app ships
([homelab#180](https://github.com/deanjstone/homelab/issues/180)), the check can move to its
`GET /api/status` for the current job and recent scans.

## systemd units

`SYSTEMD_UNITS` lists the homelab units with a card, user units bare and system units as
`system:<unit>`. `deploy.sh`'s default ([#682](https://github.com/deanjstone/argus/issues/682)):

| Unit | Scope | Why |
|---|---|---|
| `agent-engine.service` | user | the agent-engine HTTP server |
| `ops-hub.service` | user | the ops hub, which serves agent sessions' notice board |
| `watchtower-collector.service` | user | this collector: uptime and restarts (a dead collector shows as every card going stale) |
| `budget-api.service` | user | Budget Buddy's API |
| `t3code.service` | user | the T3 Code server agents run in |
| `taskview-web.service` | user | TaskView |
| `taskview-api.service` | user | TaskView's API, behind `taskview-web` ([homelab#220](https://github.com/deanjstone/homelab/issues/220)) |
| `taskview-migrate.service` | user | TaskView's boot-time migration oneshot (`RemainAfterExit`, so `active` once it succeeds); the API needs it |
| `budget-api-cron.timer` | user | Budget Buddy's daily notifications |
| `argus-context-fetch-install.timer` | user | memory-mcp's daily fetch-install |
| `session-tasks.timer` | user | the daily briefing and memory consolidation |
| `inbox-ingest.timer` | user | CONTEXT inbox ingest |
| `repo-git-sync.timer`, `vault-git-sync.timer` | user | keep `~/repos`, `~/CONTEXT` and `~/CORTEX` current |
| `runner-watchdog.timer` | user | clears wedged Actions runners |
| `cloudflared.service` | system | the Cloudflare tunnel |
| `tailscaled.service` | system | the tailnet everything cross-host rides on |
| `postgresql@16-main.service` | system | homelab Postgres |
| `borgmatic.timer` | system | the nightly backup |
| `paperless-webserver.service` | user | Paperless-NGX UI and API on `100.64.0.2:8010` ([homelab#227](https://github.com/deanjstone/homelab/issues/227)) |
| `paperless-consumer.service` | user | ingests the Syncthing-fed consume folder; the unit most likely to wedge |
| `paperless-task-queue.service` | user | Celery worker: OCR and classification |
| `paperless-scheduler.service` | user | Celery beat |
| `valkey-server.service` | system | Paperless's broker |

Left out: `syncthing.service` (the Syncthing card), `ipp-usb.service` (the printer and scanner
cards), the `actions.runner.*` units (the runner cards), and short-lived or personal units.

A service is `healthy` while active, `degraded` while activating, and `down` otherwise or when
not installed. A timer is judged by the run it last triggered:

| State | Meaning |
|---|---|
| `healthy` | The timer is waiting and its last run succeeded, or a run is in progress |
| `degraded` | The timer has never fired |
| `down` | The timer is stopped or not installed, or its last run failed |

The detail carries the last trigger, the next one, and the run's result, exit status, start and
end. `systemctl` runs with `TZ=UTC`, because it prints every time in the local zone.

## GitHub runners

`src/adapters/github-runners.ts` gives each runner in `GITHUB_RUNNERS` (`repo/runner` pairs) a
card under the `github-runners` host, from `GET /repos/{owner}/{repo}/actions/runners`. One
request per repo per poll serves all of that repo's runners.

| State | Meaning |
|---|---|
| `healthy` | Online; the detail says idle or busy, from GitHub's own `busy` flag |
| `degraded` | GitHub answered but refused the token (a missing or under-scoped token) |
| `down` | Offline, or no longer registered on the repo |
| `unreachable` | GitHub did not answer |

It needs `GITHUB_RUNNERS_TOKEN`, a fine-grained PAT with **Administration: read** on the
runners' repos — the runners API is behind that permission. `deploy.sh` reads it from the BWS
secret `watchtower-github-runners-token`; while that is missing the runner cards are not
registered.

## Homelab load and memory

`src/adapters/homelab-resources.ts` reads `/proc` on the collector's own host.

| Card | `degraded` | `down` |
|---|---|---|
| `homelab:load` | 5-minute load at 2 × the CPU count (8 on homelab's 4 CPUs) | — |
| `homelab:memory` | as `lnv-lgn5:memory` below | as `lnv-lgn5:memory` below |

The load line comes from homelab's `sar -q` history for 2026-10-10..16: the daily average was
1.8–2.4, and the 5-minute load reached 8 in only 2–12 of each day's 143 ten-minute samples. Those
samples are the 10–25 spikes that slowed CI and pre-push hooks on 2026-10-15 and 16. The
5-minute average ignores a one-minute burst; the 15-minute one sat at 4 or more for a quarter of
some days, so it would flag ordinary work.

## Main CI per repo

`src/adapters/github-ci.ts` gives each repo in `CI_REPOS` a `github-ci:<repo>` card from
`GET /repos/{owner}/{repo}/actions/runs?branch=main`. For each workflow it takes the newest run
that succeeded or failed, skipping skipped and cancelled runs, and notes a newer run still going.
The card is `degraded` while any workflow's newest such run failed (`failure`, `timed_out`,
`startup_failure`), and names the failed jobs from that run's jobs list. A repo with no runs on
main is `healthy` with no workflows.

`deploy.sh` sets `CI_REPOS` from argus-config's `hooks/backlog-labels.py repos` when it can run on
the host, else from a snapshot of its output in the script. It then drops every repo in
`CI_REPOS_NO_CI`, the backlog repos with no Actions workflows, whose cards would only ever read
"no runs".

## Runner queue

`src/adapters/github-queue.ts` makes one `github-runners:queue` card over every repo in
`GITHUB_RUNNERS`: how many jobs are queued now, the oldest of them, and per repo the
median, p90 and longest wait of the jobs a runner took in the last 24 hours. Every job counts,
self-hosted or GitHub-hosted (argus#1211). A wait is from the job's creation to its start. GitHub
creates a job with `needs:` only when what it needs has finished, so this is time spent queued.

The detail also carries `waitingJobs` and `inProgressJobs`: the full lists, oldest first, over the
same recent runs. Each entry has the repo, workflow, run id, job, runner name, queued and started
times and a `selfHosted` flag. A waiting job has no runner and no start yet. No new config or
token: it reads the same runs and jobs the card already fetched.

| State | When |
|---|---|
| `degraded` | a job has been queued 30 min, or a repo's p90 wait is 30 min or more |
| `down` | a job has been queued 2 hours |

On 2026-10-16, repos whose runner was free started jobs in 3–48 s (median), and argus's two busy
runners left jobs queued for a median 18 min and a p90 of 57 min. A job runs for 5–12 min, so a
30-minute wait means the queue is at least two jobs deep.

Both GitHub cards need `GITHUB_ACTIONS_TOKEN` with **Actions: read**. The runners'
Administration permission is not needed. `deploy.sh` reuses the BWS secret
`myargus GitHub app: collector PAT`, which myargus's github-collector already holds. They use
REST only, with ETag revalidation. The most this costs is about 420 counted requests an hour
(23 repos every 5 min, plus 12 runner repos every 2 min), plus one request for each failed or
unfinished run. In practice most of these requests come back 304 and are not counted.

## Tailscale

`src/adapters/tailscale.ts` gives each device in `TAILSCALE_DEVICES` a `tailscale:<name>` card from
homelab's `tailscale status --json`. An entry is `name[@offline-after][~companion]`, and the
allowance defaults to 1 hour. A device is `degraded` once it has been offline longer than its
allowance. With a companion, it is also `degraded` after 10 minutes offline while the companion
is online: WSL2 gone while its Windows host is up, as during argus-config#625. A device missing
from the tailnet is `down`, and so is every card when `tailscale` itself cannot answer.

## LNV-LGN5

`src/adapters/host-report.ts` polls the WSL2 usage-shim's `GET /host` over the tailnet
(`HOST_REPORT_WSL2_URL`, with the shim's existing `AI_USAGE_WSL2_TOKEN`) and turns it into five
cards under the `lnv-lgn5` host. Why the collector pulls rather than WSL2 pushing is in the
[usage-shim README](../watchtower-usage-shim/README.md#why-the-collector-pulls-host-instead-of-wsl2-pushing-to-checks).

| Card | `degraded` | `down` |
|---|---|---|
| `lnv-lgn5:disk:C:` | 90% used, or `/mnt/c` not mounted | under 10 GB free |
| `lnv-lgn5:crash-dumps` | a WSL dump under 24 hours old, or WSL dumps totalling 10 GB | — |
| `lnv-lgn5:memory` | PSI `some` avg60 at 10%, or under 10% of memory available | PSI `full` avg60 at 10% |
| `lnv-lgn5:systemd:<unit>` | as for homelab units | as for homelab units |
| `lnv-lgn5:timers`, `lnv-lgn5:vault:<name>` | as for homelab's (below) | — |
| `lnv-lgn5:memory-reconcile` | last run over 1 hour old (3 missed 20-minute runs), or any refusal outstanding, or no heartbeat file | the last run failed |
| `lnv-lgn5:t3-stale` | WSL2's T3 is at or over `T3_STALE_DAYS` days (default 3) behind the newest release on its channel, or the hook could not measure | — |

Windows app dumps (`%LOCALAPPDATA%\CrashDumps`) are shown but not judged. Every card is
`unreachable` while the laptop sleeps. A shim too old to report timers, the heartbeat or the
vaults leaves those cards `degraded`, saying to redeploy it.

memory-reconcile runs on WSL2 only, so its card has no homelab twin. It reads the heartbeat
`~/.argus/memory-reconcile-heartbeat.json`, the file the session-start `Memory refusals:` line
reads.

### T3 version and days behind

`homelab:t3-stale` and `lnv-lgn5:t3-stale` show each host's active T3 version and how many whole
days it is behind the newest release on its update channel (argus#1175). They run argus-config's
`hooks/t3-stale.py --no-state` (argus-config#1287), the check behind the work order's `t3 stale:`
error line, so the two cannot disagree and the threshold is the same `T3_STALE_DAYS` (default 3;
set it where the hook runs). `--no-state` sends no Telegram message and writes no record, so
polling it is safe. Homelab runs the hook itself (`T3_STALE_HOOK`, default
`~/.argus/hooks/t3-stale.py`); WSL2's comes through the usage-shim's `GET /host` (`t3Stale`, hook path
`HOST_T3_STALE_HOOK`). A host under the threshold is `healthy` and shows its days behind in the
summary. The card is `degraded` at the threshold, and when the hook is missing, fails or could not
read the active version (the hook's own message is the reason). A reading older than the dashboard's
15-minute allowance shows the usual stale marker. The hook must be on the host first: promote
argus-config before argus, or the cards read `degraded` with "could not run".

## Silent failures

Things that fail without telling anyone (argus#686):

| Card | `degraded` | `down` |
|---|---|---|
| `homelab:timers` | any `--user` timer disabled, not active, with nothing scheduled, over 5 minutes past its next run, or whose last run failed | — |
| `homelab:vault:<name>` | `vault-staleness.sh` prints anything, or the vault is not a git checkout | — |
| `notice-board:queue` | a message unacked (queued or claimed) for over 24 hours, or one gone dead in the last 7 days | the board does not answer |

The timers card lists every timer `systemctl --user list-unit-files --type=timer` names, so a
disabled one is there too. A timer a package ships (`/usr/lib/systemd/user`) is not faulted for
being disabled, since nobody here enabled it. "Nothing scheduled" is the case that hides: a
timer that is `active (elapsed)` with no next elapse, such as one driven only by
`OnUnitActiveSec` whose service stopped being started, never fires again and never fails.
A template (`loop-wake@.timer`) is skipped, since `systemctl show` refuses its name; its
instances (`loop-wake@afk.timer`) come from `list-units` and are checked like any timer. A timer
whose `show` fails is listed as `not-loaded` and the other timers are still judged.

The vault cards run argus-config's `hooks/vault-staleness.sh` once per vault
(`VAULT_STALENESS_DIRS=<dir>`), the check behind the session-start `Vault sync:` line, so the two
cannot disagree: unpublished commits waiting over 4 hours, or `origin/main` moved while the clone
has not fetched for 4 hours. The card shows the hook's own words.

The notice-board card reads `GET /repos`, then the queued, claimed and dead messages of repos
that have any, with the board's existing homelab device token. A dead message stays dead, so
only one from the last week counts.

## Public surface

The internet-facing side of the stack (argus#687), checked from homelab:

| Card | `degraded` | `down` |
|---|---|---|
| `endpoint:<host>` (`endpoint:<host>/<path>` where several probes share a host) | an answer other than the expected one (an API answering anonymous requests, a 404, a redirect anywhere but Cloudflare Access), or slower than 3 s | a 5xx, or no answer within 10 s |
| `tls:<host>` | under 21 days to expiry. Cloudflare renews about 30 days out, so a renewal is overdue | under 7 days, expired, or the handshake fails |
| `worker-traffic:<script>` | any 5xx at 2% of requests or more; for an API Worker, 10 or more 4xx at 10% or more | 5xx at 20% or more, over at least 20 requests |

The endpoints are `PUBLIC_ENDPOINTS` in `src/adapters/endpoints.ts`, and they are not kept by hand:
each one is a `live` entry in the links registry (`links.json`, vendored at the repo root) that
carries a `probe`, at the status the registry expects. A new host is probed once the registry holds
it, and a planned, redirect or retired host never is. An API that wants a token answers 401, and
that counts as up; a 302 in the registry means Cloudflare Access redirects an anonymous request to
its login. Two entries are probed one path deeper (`DEEPER_PROBES`): the watchtower API at
`/checks` and the email MCP at `/mcp`, both of which answer 401 themselves. The certificate checks
cover each distinct host (`PUBLIC_HOSTS`). The probes need no credentials and send the user agent
`argus-watchtower-probe`.

Worker traffic reads Cloudflare's GraphQL Analytics API for the last hour, once a poll for
every Worker in `CLOUDFLARE_WORKER_PROJECTS`:

- **Workers analytics** gives invocations by status and the scripts' exceptions. The
  `watchtower-collector-cf-read` token can read it.
- **HTTP analytics** gives edge 4xx/5xx on each Worker's route (`WORKER_ROUTES`, built from the registry), with the
  probes left out. This needs **Zone > Analytics: Read** on the Argus zone
  (`CLOUDFLARE_ZONE_ID`). Until the token has it, each card says so and is judged on
  exceptions alone.

## Capacity

How close each store is to its plan's limit, and how much of Claude's 5-hour and weekly
caps are used (argus#688, argus#952):

| Card | `degraded` | `down` |
|---|---|---|
| `d1:<database>` | 80% of the database size limit | 95% |
| `supabase-usage:<ref>` | 80% of the plan's database size limit | 95% |
| `claude-window` | no OAuth credentials, a 401, or the usage endpoint unreachable or unreadable | — |

**D1** (`D1_DATABASES`, `name:id` pairs; `deploy.sh` sets `argus-watchtower` from the BWS secret `ARGUS_WATCHTOWER_D1_DATABASE_ID`). The limit is the
Workers Free one, 500 MB per database; set `D1_LIMIT_MB` on Workers Paid (10 GB). Two sources:

- **GraphQL analytics** (`d1StorageAdaptiveGroups`) gives the day's largest size with the
  `watchtower-collector-cf-read` token. It lags: a database pruned today still shows the
  day's peak.
- **The D1 query API** gives each table's row count and the size as of that query. It needs
  **Account > D1: Read**, on `watchtower-collector-cf-read` (it has D1 Read) or a separate token in
  `CLOUDFLARE_D1_TOKEN`. Until then the card says so and shows the analytics size. Counting
  reads every row, so the counts are refreshed every six hours.

**Supabase** reuses `SUPABASE_MGMT_TOKEN` and `SUPABASE_PROJECT_REFS`. Size is
`pg_database_size` from the read-only SQL endpoint, judged against the organisation's plan
(`free`: 500 MB per project, 5 GB egress; `pro`: 8 GB, 250 GB). The Management API has no
egress figure, so each card shows the plan's egress limit and says the usage is not reported.

**Claude window** (argus#952) asks Claude's OAuth usage endpoint,
`GET https://api.anthropic.com/api/oauth/usage` with the header `anthropic-beta: oauth-2025-04-20`,
the same request argus-config's `budget-signals` and the Agent SDK's `get_usage` make. One small
request every 5 minutes, no transcripts. The token is read on every poll from
`$CLAUDE_CONFIG_DIR/.credentials.json` (default `~/.claude/.credentials.json`) of the user running the
collector, so Claude Code must be signed in on that host and keep its token fresh. The reply is
account-wide: the card shows `five_hour` and `seven_day` as a percent of the cap with their reset
times. A missing or unreadable credentials file, a 401, a failed request or a reply without
`five_hour.utilization` records `degraded` with the reason (never the token), and the check does
not throw. Rows recorded before this still render from the ccusage-blocks shape.

**Local ccusage scans** read every session log on the host, whatever date range is asked for
(`--since` filters after the read, it does not skip files). On homelab that is about 630 MB on a
spinning disk, so the collector cuts what each scan reads (argus#949):

- **Cache window.** The daily report (`--json`, the ai-usage card) runs at most once an hour. The
  adapter still polls every 5 minutes for the remote shims and is served the last output in between.
  The Claude window card no longer runs ccusage at all.
- **Skip when nothing changed.** When a window ends, the collector walks `projects/` under
  `CLAUDE_CONFIG_DIR` (default `~/.config/claude` and `~/.claude`) and stats each `.jsonl`. If none
  is newer than the start of the scan that produced the cached output, that output is served with no
  spawn. A scan is forced after 24 hours regardless, since ccusage also reads other agents' logs
  that this check does not watch. An unreadable directory counts as changed.
- **Incremental daily scan** (argus#951). The first daily scan, and one every 24 hours, reads
  everything and keeps its per-day rows in memory. The scans between re-read only the transcripts
  written since 14 hours before the UTC midnight that starts the UTC date of 24 hours ago (at most
  62 hours back), copied as the entries from then on, with `--since` set to that date, and splice
  the result onto the kept rows for the earlier days. The totals are summed from the merged rows.
  ccusage dedupes by message and request id across the files it is given, so a resumed session that
  replays old entries is counted once; the replayed entries are dated before `--since` and dropped.
  The kept rows are used only while the scan behind them started within the last 6 hours (a skipped
  scan counts as a check) and the transcript list is unchanged: a transcript that vanished, or one
  that turned up with a modification time older than that, forces a full scan. A restart starts
  with a full scan. Closed days are therefore not re-read, so an edit to an old transcript shows up
  at the next full scan, within a day.
- **Other agents' logs.** The daily scan also reads Codex's `sessions/` and `archived_sessions/`
  (`~/.codex`, or `CODEX_HOME`), OpenCode's database, Gemini's `tmp/` and the like. ccusage 20.0.17 does not open Codex's SQLite state and log files,
  which make up the rest of `~/.codex` (checked with `inotifywait` on a scratch home). Homelab has
  no Codex sessions, so those reads come to about 20 KB there; a host that runs Codex would read
  them in full on each daily scan, which `CLAUDE_CONFIG_DIR` does not scope.

Estimated for homelab while sessions are active, from file sizes, birth and modification times and a steady write rate (30 Oct): the daily scan
about 90 MB an hour (a full read of 630 MB a day, then 64 MB an hour), against 835 MB after argus#950.

The collector also shares one scan between callers that ask together and runs it under
`nice -n 10 ionice -c 3`. The idle I/O class only takes effect under the `bfq` disk scheduler,
which homelab uses (`cat /sys/block/sda/queue/scheduler`). A failed scan is not cached.
