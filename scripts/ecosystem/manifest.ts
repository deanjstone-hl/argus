/**
 * The ecosystem manifest: the apps, projects and skills of the Argus system and the edges
 * between them, which the shell's System Map page draws (deanjstone/myargus#310). The source
 * is `ecosystem/manifest.json` at the repo root, published as the `ecosystem.json` asset of
 * the argus release tagged `ecosystem`; the hub fetches it, keeps the last valid copy and
 * serves it at `GET /api/ecosystem`. The shape is a contract with the shell's reader in
 * myargus (`apps/shell/src/lib/ecosystem.ts`): change them together.
 */

export const CATEGORIES = ['app', 'project', 'skill'] as const
export const STATUSES = ['live', 'active', 'scaffold', 'archived'] as const

export type Category = (typeof CATEGORIES)[number]
export type Status = (typeof STATUSES)[number]

export interface Entry {
  name: string
  description: string
  category: Category
  href?: string
  status?: Status
  tags?: string[]
  /** Names of other entries this one is linked to. */
  connects?: string[]
}

export interface Manifest {
  version: 1
  entries: Entry[]
}

export type ParseResult = { ok: true; manifest: Manifest } | { ok: false; errors: string[] }

const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
const isStringArray = (value: unknown): value is string[] => Array.isArray(value) && value.every((item) => typeof item === 'string')

function isHttpUrl(value: string): boolean {
  try {
    const { protocol } = new URL(value)
    return protocol === 'https:' || protocol === 'http:'
  } catch {
    return false
  }
}

/** Check an untrusted value against the manifest contract, reporting every problem found. */
export function parseManifest(input: unknown): ParseResult {
  if (!isObject(input)) return { ok: false, errors: ['the manifest must be an object'] }
  const errors: string[] = []
  if (input.version !== 1) errors.push('version must be 1')
  const entries = input.entries
  if (!Array.isArray(entries)) {
    errors.push('entries must be an array')
    return { ok: false, errors }
  }
  if (entries.length === 0) errors.push('entries must not be empty')

  const names = new Set<string>()
  entries.forEach((entry: unknown, index) => {
    const at = `entries[${index}]`
    if (!isObject(entry)) {
      errors.push(`${at} must be an object`)
      return
    }
    if (typeof entry.name !== 'string' || entry.name === '') errors.push(`${at}.name must be a non-empty string`)
    else if (names.has(entry.name)) errors.push(`${at}.name "${entry.name}" is already used`)
    else names.add(entry.name)
    if (typeof entry.description !== 'string') errors.push(`${at}.description must be a string`)
    if (!CATEGORIES.includes(entry.category as Category)) errors.push(`${at}.category must be one of ${CATEGORIES.join(', ')}`)
    if (entry.status !== undefined && !STATUSES.includes(entry.status as Status)) errors.push(`${at}.status must be one of ${STATUSES.join(', ')}`)
    if (entry.href !== undefined && !(typeof entry.href === 'string' && isHttpUrl(entry.href))) errors.push(`${at}.href must be an http(s) URL`)
    if (entry.tags !== undefined && !isStringArray(entry.tags)) errors.push(`${at}.tags must be an array of strings`)
    if (entry.connects !== undefined && !isStringArray(entry.connects)) errors.push(`${at}.connects must be an array of strings`)
  })

  // Edges are checked once every name is known, so an edge may point forward in the list.
  entries.forEach((entry: unknown, index) => {
    if (!isObject(entry) || !isStringArray(entry.connects)) return
    for (const target of entry.connects) if (!names.has(target)) errors.push(`entries[${index}].connects names "${target}", which is not an entry`)
  })

  return errors.length > 0 ? { ok: false, errors } : { ok: true, manifest: input as unknown as Manifest }
}
