import { createServer } from './server.js'
import { runCcusage } from './ccusage.js'
import { createHostReporter } from './host-report.js'

const token = process.env.USAGE_SHIM_TOKEN
if (!token) {
  console.error('[usage-shim] USAGE_SHIM_TOKEN not set, refusing to start')
  process.exit(1)
}

const port = Number(process.env.USAGE_SHIM_PORT ?? 8765)

// GET /host: this machine's disk, crash dumps, memory and units for the
// collector's LNV-LGN5 cards (argus#682), and its timers, memory-reconcile
// heartbeat and vault sync for the silent-failure cards (argus#686), and T3
// staleness (argus#1175).
const home = process.env.HOME ?? ''
const hostConfig = {
  diskPath: process.env.HOST_DISK_PATH ?? '/mnt/c',
  localAppData: process.env.HOST_LOCALAPPDATA ?? `/mnt/c/Users/${process.env.USER ?? ''}/AppData/Local`,
  units: (process.env.HOST_UNITS ?? 'agent-engine.service,memory-reconcile.timer')
    .split(',')
    .map((unit) => unit.trim())
    .filter(Boolean),
  heartbeatPath: process.env.CONTEXT_RECONCILE_HEARTBEAT_FILE ?? `${home}/.argus/memory-reconcile-heartbeat.json`,
  vaultHookPath: process.env.HOST_VAULT_HOOK ?? `${home}/.argus/hooks/vault-staleness.sh`,
  t3StaleHookPath: process.env.HOST_T3_STALE_HOOK ?? `${home}/.argus/hooks/t3-stale.py`,
  t3Host: process.env.HOST_T3_HOST ?? 'wsl2',
  vaults: (process.env.HOST_VAULTS ?? `${home}/CONTEXT,${home}/CORTEX`)
    .split(',')
    .map((path) => path.trim())
    .filter(Boolean)
    .map((path) => ({ name: path.split('/').filter(Boolean).pop() ?? path, path })),
}

const server = createServer({ token, runCcusage, readHostReport: createHostReporter(hostConfig) })
server.listen(port, () => {
  console.log(`[usage-shim] listening on :${port}`)
})

function shutdown(signal: string): void {
  console.log(`[usage-shim] received ${signal}, shutting down`)
  server.close(() => process.exit(0))
}

process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))
