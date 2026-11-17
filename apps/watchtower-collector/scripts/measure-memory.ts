// Memory of the collector's in-process adapters, measured from the package's
// own fixtures: no network, no systemctl, no live host is read. Run with
//   pnpm run measure:memory [rounds]
// It polls every fixture-fed adapter `rounds` times (default 40), forcing a GC
// between rounds, and prints heap and RSS per adapter kind and for the process
// as a whole, so a leak (a series that climbs) shows apart from a burst.
//
// What it cannot see: the memory of child processes (systemctl, ccusage).
// Those count toward the unit's cgroup, not this process's RSS; src/poller-
// stagger.test.ts bounds how many are alive at once instead.
import { readFileSync } from 'node:fs'
import type { Adapter } from '../src/adapter.js'
import { createDiskAdapter } from '../src/adapters/disk.js'
import { createLoadAdapter, createMemoryAdapter } from '../src/adapters/homelab-resources.js'
import { createSystemdAdapter, parseUnitList } from '../src/adapters/systemd.js'
import { createTimersAdapter, listUserTimers } from '../src/timer-freshness.js'
import * as systemdFixtures from '../src/__fixtures__/systemd.js'

const fixture = (name: string) => readFileSync(new URL(`../src/__fixtures__/${name}`, import.meta.url), 'utf8')
const gc = (globalThis as { gc?: () => void }).gc
if (!gc) throw new Error('run with --expose-gc (use `pnpm run measure:memory`)')

const rounds = Number(process.argv[2] ?? 40)
const mb = (bytes: number) => (bytes / 1024 / 1024).toFixed(1)

const UNITS =
  'agent-engine.service,ops-hub.service,watchtower-collector.service,budget-api.service,t3code.service,taskview-web.service,taskview-api.service,taskview-migrate.service,budget-api-cron.timer,argus-context-fetch-install.timer,session-tasks.timer,inbox-ingest.timer,repo-git-sync.timer,vault-git-sync.timer,runner-watchdog.timer,system:cloudflared.service,system:tailscaled.service,system:postgresql@16-main.service,system:borgmatic.timer,paperless-webserver.service,paperless-consumer.service,paperless-task-queue.service,paperless-scheduler.service,system:valkey-server.service'

const homelabTimers = JSON.parse(fixture('timers-homelab.json')) as Record<string, { unit: Record<string, string>; triggers?: Record<string, string> }>
const toProperties = (properties: Record<string, string>) => Object.entries(properties).map(([key, value]) => `${key}=${value}`).join('\n')

// systemctl, answered from the fixtures: a timer or service card per unit.
async function fakeSystemctl(args: string[]): Promise<string> {
  if (args[1] === 'list-unit-files') return Object.keys(homelabTimers).map((name) => `${name} enabled enabled`).join('\n')
  if (args[1] === 'list-units') return ''
  const unit = args[args.indexOf('show') + 1] as string
  const timer = homelabTimers[unit]
  if (timer) return toProperties(timer.unit)
  const owner = Object.values(homelabTimers).find((entry) => entry.unit.Unit === unit)
  if (owner?.triggers) return toProperties(owner.triggers)
  return unit.endsWith('.timer') ? systemdFixtures.BUDGET_API_CRON_TIMER : systemdFixtures.BUDGET_API_CRON_SERVICE
}

const statfs = JSON.parse(fixture('homelab-statfs.json')) as Record<string, { bsize: number; blocks: number; bfree: number; bavail: number }>
const procFiles: Record<string, string> = {
  '/proc/loadavg': fixture('homelab-loadavg.txt'),
  '/proc/meminfo': fixture('homelab-meminfo.txt'),
  '/proc/pressure/memory': fixture('homelab-pressure-memory.txt'),
}
const readFile = async (path: string) => procFiles[path] ?? Promise.reject(new Error(`no fixture for ${path}`))

const groups: Array<{ kind: string; adapters: Adapter[] }> = [
  { kind: 'systemd (24 units)', adapters: parseUnitList(UNITS).map((unit) => createSystemdAdapter(unit, { run: fakeSystemctl })) },
  { kind: 'timers card (17 timers)', adapters: [createTimersAdapter('homelab', () => listUserTimers(fakeSystemctl))] },
  { kind: 'disk (2)', adapters: ['/', '/mnt/backups'].map((path) => createDiskAdapter(path, { statfs: async (target) => statfs[target] as never })) },
  { kind: 'load + memory (2)', adapters: [createLoadAdapter({ readFile, cpus: () => 4 }), createMemoryAdapter({ readFile })] },
]

const snapshot = () => {
  gc()
  const { rss, heapUsed } = process.memoryUsage()
  return { rss, heapUsed }
}

console.log = () => {}
console.warn = () => {}

const start = snapshot()
const series: number[] = []
const table: Array<[string, number, number]> = []

for (const { kind, adapters } of groups) {
  const before = snapshot()
  let peakRss = before.rss
  for (let round = 0; round < rounds; round += 1) {
    await Promise.all(adapters.map((adapter) => adapter.check()))
    peakRss = Math.max(peakRss, process.memoryUsage().rss)
  }
  const after = snapshot()
  table.push([kind, after.heapUsed - before.heapUsed, peakRss - before.rss])
}

for (let round = 0; round < rounds; round += 1) {
  await Promise.all(groups.flatMap((group) => group.adapters).map((adapter) => adapter.check()))
  if (round % Math.max(1, Math.floor(rounds / 8)) === 0) series.push(snapshot().rss)
}
const end = snapshot()

process.stdout.write(`rounds per adapter: ${rounds}, node ${process.version}\n\n`)
process.stdout.write('| adapter kind | heap retained after GC (MB) | RSS growth while polling (MB) |\n|---|---|---|\n')
for (const [kind, heap, rss] of table) process.stdout.write(`| ${kind} | ${mb(heap)} | ${mb(rss)} |\n`)
process.stdout.write(`\nwhole process, all adapters polled together ${rounds} times\n`)
process.stdout.write(`  start: rss ${mb(start.rss)} MB, heap ${mb(start.heapUsed)} MB\n`)
process.stdout.write(`  end:   rss ${mb(end.rss)} MB, heap ${mb(end.heapUsed)} MB\n`)
process.stdout.write(`  rss after GC at intervals: ${series.map(mb).join(', ')} MB\n`)
