import type { CheckTarget } from './post-check.js'
import { createHubTarget } from './hub-client.js'
import { createWorkerTarget } from './worker-client.js'

type Env = Record<string, string | undefined>

// A flag is `on`, `off`, or unset. Anything else is a typo that would otherwise
// switch a store off by accident, so it stops the collector at start.
function readFlag(env: Env, name: string): 'on' | 'off' | undefined {
  const value = env[name]
  if (value === undefined || value === '') return undefined
  if (value === 'on' || value === 'off') return value
  throw new Error(`${name} must be on or off, got "${value}"`)
}

// The stores each check is written to (argus#1200, decided in argus#1165): D1
// through the Worker, and the ops hub. They were written side by side, then D1
// was turned off (`WATCHTOWER_D1=off`, which deploy.sh now writes by default, argus#66).
//
// - d1: on unless WATCHTOWER_D1=off; needs WATCHTOWER_WORKER_URL.
// - hub: on when WATCHTOWER_HUB_URL and WATCHTOWER_HUB_TOKEN are both set,
//   unless WATCHTOWER_HUB=off. WATCHTOWER_HUB=on without either is an error.
export function resolveTargets(env: Env): CheckTarget[] {
  const targets: CheckTarget[] = []

  if (readFlag(env, 'WATCHTOWER_D1') !== 'off') {
    const url = env.WATCHTOWER_WORKER_URL
    if (!url) throw new Error('Missing WATCHTOWER_WORKER_URL env var (or set WATCHTOWER_D1=off)')
    targets.push(createWorkerTarget({ url, token: env.WATCHTOWER_COLLECTOR_TOKEN }))
  }

  const hubFlag = readFlag(env, 'WATCHTOWER_HUB')
  if (hubFlag !== 'off') {
    const url = env.WATCHTOWER_HUB_URL
    const token = env.WATCHTOWER_HUB_TOKEN
    if (url && token) {
      targets.push(createHubTarget({ url, token }))
    } else if (hubFlag === 'on') {
      const missing = [url ? '' : 'WATCHTOWER_HUB_URL', token ? '' : 'WATCHTOWER_HUB_TOKEN'].filter(Boolean)
      throw new Error(`WATCHTOWER_HUB=on needs ${missing.join(' and ')}`)
    } else if (url) {
      console.warn('[collector] WATCHTOWER_HUB_TOKEN not set, not writing checks to the hub')
    }
  }

  if (targets.length === 0) throw new Error('No target to record checks to: WATCHTOWER_D1 and WATCHTOWER_HUB are both off')
  return targets
}
