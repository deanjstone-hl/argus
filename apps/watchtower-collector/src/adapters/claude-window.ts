import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { ClaudeWindowDetail, ClaudeWindowLimit } from '@argus/watchtower-contract'
import type { Adapter } from '../adapter.js'

// Claude Code usage against the plan's cap (argus#688, argus#952), from the OAuth usage
// endpoint that argus-config's budget-signals and the Agent SDK's get_usage read: one small
// HTTPS request per poll, no transcripts. The reply is account-wide, so the card shows the
// 5-hour and weekly windows as a percent of the real limit, not one host's own tokens.
//
// The token is read from the credentials file on every call and goes into one request header.
// It is never logged, returned or put in an error: every message below is built from fixed
// text and a status code or an error class.

const INTERVAL_MS = 300_000
const REQUEST_TIMEOUT_MS = 10_000

export const OAUTH_USAGE_URL = 'https://api.anthropic.com/api/oauth/usage'

type FetchImpl = (url: string, init: { headers: Record<string, string>; redirect: 'error'; signal: AbortSignal }) => Promise<Response>

export interface OauthUsageOptions {
  // CLAUDE_CONFIG_DIR, else ~/.claude: where Claude Code keeps .credentials.json.
  configDir?: string
  fetchImpl?: FetchImpl
}

export interface OauthUsageSource {
  fetchUsage: () => Promise<unknown>
}

function errorClass(error: unknown): string {
  if (typeof (error as { code?: unknown } | null)?.code === 'string') return (error as { code: string }).code
  return error instanceof Error ? error.name : 'Error'
}

async function readToken(configDir: string): Promise<string> {
  let contents: string
  try {
    contents = await readFile(join(configDir, '.credentials.json'), 'utf8')
  } catch (error) {
    throw new Error(`no OAuth credentials (${errorClass(error)})`)
  }
  let token: unknown
  try {
    token = (JSON.parse(contents) as { claudeAiOauth?: { accessToken?: unknown } } | null)?.claudeAiOauth?.accessToken
  } catch {
    throw new Error('no OAuth credentials (unreadable JSON)')
  }
  if (typeof token !== 'string' || token === '') throw new Error('no OAuth credentials (no access token)')
  return token
}

export function createOauthUsageSource(options: OauthUsageOptions = {}): OauthUsageSource {
  const configDir = options.configDir ?? (process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'))
  const fetchImpl: FetchImpl = options.fetchImpl ?? fetch

  async function fetchUsage(): Promise<unknown> {
    const token = await readToken(configDir)
    let response: Response
    try {
      response = await fetchImpl(OAUTH_USAGE_URL, {
        headers: { Authorization: `Bearer ${token}`, 'anthropic-beta': 'oauth-2025-04-20' },
        // The token must go to this URL and nowhere a redirect points.
        redirect: 'error',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      })
    } catch (error) {
      throw new Error(`usage endpoint unreachable (${errorClass(error)})`)
    }
    if (response.status === 401) throw new Error('usage endpoint answered 401 (token expired or revoked)')
    if (!response.ok) throw new Error(`usage endpoint answered ${response.status}`)
    try {
      return (await response.json()) as unknown
    } catch {
      throw new Error('usage endpoint reply is not JSON')
    }
  }

  return { fetchUsage }
}

function readLimit(body: unknown, field: 'five_hour' | 'seven_day'): ClaudeWindowLimit | null {
  const window = (body as Record<string, unknown> | null)?.[field]
  const utilization = (window as { utilization?: unknown } | null)?.utilization
  if (typeof utilization !== 'number' || !Number.isFinite(utilization)) return null
  const resetsAt = (window as { resets_at?: unknown }).resets_at
  return { utilization, resetsAt: typeof resetsAt === 'string' ? resetsAt : null }
}

const degraded = (error: string) => ({
  status: 'degraded' as const,
  detail: { source: 'oauth-usage', fiveHour: null, sevenDay: null, error } satisfies ClaudeWindowDetail,
})

export function createClaudeWindowAdapter(fetchUsage: () => Promise<unknown>): Adapter {
  async function check() {
    let body: unknown
    try {
      body = await fetchUsage()
    } catch (error) {
      return degraded(error instanceof Error ? error.message : String(error))
    }
    const fiveHour = readLimit(body, 'five_hour')
    if (fiveHour === null) return degraded('usage reply has no five_hour utilization')
    const detail: ClaudeWindowDetail = { source: 'oauth-usage', fiveHour, sevenDay: readLimit(body, 'seven_day') }
    return { status: 'healthy' as const, detail }
  }

  return { key: 'claude-window', host: 'multi', intervalMs: INTERVAL_MS, check }
}
