import { createHash, timingSafeEqual } from 'node:crypto'

/**
 * Who is calling. The role comes from the bearer token alone, never from a tool argument:
 * each workspace's MCP config carries its role's token (Aquila's workspace the `direction`
 * token, the AFK workspace the `afk` token, every other session the `worker` token), so a
 * thread cannot claim a role its config was not given.
 */
export const ROLES = ['afk', 'direction', 'worker'] as const
export type Role = (typeof ROLES)[number]

const MIN_TOKEN_LENGTH = 24

export interface RoleToken {
  role: Role
  digest: Buffer
}

const digestOf = (token: string) => createHash('sha256').update(token).digest()

const isRole = (value: string): value is Role => (ROLES as readonly string[]).includes(value)

/**
 * Parse `role=token,role=token` (LOOP_STATE_TOKENS). A role may hold more than one token,
 * so a token can be rotated without a gap; a token may belong to one role only.
 */
export function parseTokens(spec: string): RoleToken[] {
  const entries = spec
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
  if (entries.length === 0) throw new Error('LOOP_STATE_TOKENS is empty: refusing to run without auth')

  const tokens = new Set<string>()
  return entries.map((entry) => {
    const separator = entry.indexOf('=')
    const role = entry.slice(0, separator).trim()
    const token = entry.slice(separator + 1).trim()
    if (separator <= 0 || !isRole(role)) {
      throw new Error(`LOOP_STATE_TOKENS entry does not start with a role (${ROLES.join(', ')}): ${role || '(blank)'}`)
    }
    if (token.length < MIN_TOKEN_LENGTH) throw new Error(`a ${role} token is shorter than ${MIN_TOKEN_LENGTH} characters`)
    if (tokens.has(token)) throw new Error(`a ${role} token reuses another entry's token`)
    tokens.add(token)
    return { role, digest: digestOf(token) }
  })
}

/** The role a bearer header belongs to, or null. Compares every digest so timing says nothing. */
export function authenticate(header: string | undefined, tokens: RoleToken[]): Role | null {
  const match = /^Bearer\s+(\S+)$/i.exec(header ?? '')
  if (!match?.[1]) return null
  const presented = digestOf(match[1])
  let role: Role | null = null
  for (const candidate of tokens) {
    if (timingSafeEqual(presented, candidate.digest)) role = candidate.role
  }
  return role
}
