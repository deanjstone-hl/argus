import { homedir } from 'node:os'
import { join } from 'node:path'

import { parseTokens, type RoleToken } from './roles.js'

export interface Config {
  host: string
  port: number
  dbPath: string
  cadenceMs: number
  tokens: RoleToken[]
  /** The bearer ops-hub presents to POST /events/promoted and POST /wake/request; unset leaves both routes refusing everyone. */
  promotionToken: string | undefined
  requireCallerThread: boolean
}

const MIN_PROMOTION_TOKEN_LENGTH = 24

function positiveInteger(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name]
  if (raw === undefined || raw === '') return fallback
  const value = Number(raw)
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive whole number, got "${raw}"`)
  return value
}

/** Where the db lives when LOOP_STATE_DB is not set. */
export const defaultDbPath = (): string => join(homedir(), '.argus', 'backlog-loop', 'loop.db')

/** Loopback by default: the tailnet reaches it through `tailscale serve`, as with ops-hub. */
export function loadConfig(env: NodeJS.ProcessEnv): Config {
  const tokenSpec = env['LOOP_STATE_TOKENS']
  if (!tokenSpec) throw new Error('LOOP_STATE_TOKENS is not set: refusing to run without auth')
  const promotionToken = env['LOOP_STATE_PROMOTION_TOKEN'] || undefined
  if (promotionToken !== undefined && promotionToken.length < MIN_PROMOTION_TOKEN_LENGTH) {
    throw new Error(`LOOP_STATE_PROMOTION_TOKEN is shorter than ${MIN_PROMOTION_TOKEN_LENGTH} characters`)
  }
  const tokens = parseTokens(tokenSpec)
  if (promotionToken !== undefined && tokenSpec.includes(`=${promotionToken}`)) {
    throw new Error('LOOP_STATE_PROMOTION_TOKEN reuses a role token: ops-hub must hold its own')
  }
  return {
    host: env['LOOP_STATE_HOST'] || '127.0.0.1',
    port: positiveInteger(env, 'LOOP_STATE_PORT', 3791),
    dbPath: env['LOOP_STATE_DB'] || defaultDbPath(),
    cadenceMs: positiveInteger(env, 'LOOP_STATE_CADENCE_MINUTES', 30) * 60_000,
    tokens,
    promotionToken,
    requireCallerThread: env['LOOP_STATE_REQUIRE_CALLER_THREAD'] === '1',
  }
}
