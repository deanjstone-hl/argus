/**
 * argus#75: change the directives record by naming only the keys that change, and show what a
 * write changed. `directives_set` took the whole record, so a one-key change meant copying every
 * other key by hand, and a slip (v91 dropped `deanjstone-hl/argus-config` from `trunk_repos`)
 * changed an unrelated key with nothing to catch it.
 */

type Mapping = Record<string, unknown>

/** The edits a patch makes to the current record. A key may be in only one of `set`, `unset`, `add` and `remove`, except that `add` and `remove` may name the same list. */
export interface DirectivesPatch {
  /** Keys to set, replacing a whole value (a new key, or a scalar, a mapping or a list in full). */
  set?: Record<string, unknown>
  /** Keys to remove from the record. */
  unset?: string[]
  /** Entries to append to a list key, which is created when absent. An entry already listed is left alone. */
  add?: Record<string, unknown[]>
  /** Entries to remove from a list key. An entry that is not listed is refused. */
  remove?: Record<string, unknown[]>
}

/** One top-level key that differs between two versions. */
export interface DirectivesChange {
  key: string
  change: 'added' | 'removed' | 'changed'
  before?: unknown
  after?: unknown
  /** For a list that changed: the entries it gained. */
  list_added?: unknown[]
  /** For a list that changed: the entries it lost. */
  list_removed?: unknown[]
  /** For a list that changed with the same entries: only the order differs. */
  reordered?: true
}

const PATCH_OPS = ['set', 'unset', 'add', 'remove'] as const

const isMapping = (value: unknown): value is Mapping => typeof value === 'object' && value !== null && !Array.isArray(value)

/** JSON with every mapping's keys sorted, so two values compare equal whatever order their keys were written in. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (isMapping(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

const sameValue = (a: unknown, b: unknown) => canonical(a) === canonical(b)
const includesEntry = (list: unknown[], entry: unknown) => list.some((existing) => sameValue(existing, entry))

/**
 * Every top-level key whose value differs between `before` and `after`, sorted by key. A list shows the
 * entries it gained and lost; any other value shows both sides.
 */
export function diffDirectives(before: Mapping, after: Mapping): DirectivesChange[] {
  const changes: DirectivesChange[] = []
  for (const key of [...new Set([...Object.keys(before), ...Object.keys(after)])].sort()) {
    const inBefore = key in before
    const inAfter = key in after
    if (inBefore && inAfter && sameValue(before[key], after[key])) continue
    if (!inBefore) changes.push({ key, change: 'added', after: after[key] })
    else if (!inAfter) changes.push({ key, change: 'removed', before: before[key] })
    else {
      const was = before[key]
      const now = after[key]
      const change: DirectivesChange = { key, change: 'changed', before: was, after: now }
      if (Array.isArray(was) && Array.isArray(now)) {
        const added = now.filter((entry) => !includesEntry(was, entry))
        const removed = was.filter((entry) => !includesEntry(now, entry))
        if (added.length > 0) change.list_added = added
        if (removed.length > 0) change.list_removed = removed
        if (added.length === 0 && removed.length === 0) change.reordered = true
      }
      changes.push(change)
    }
  }
  return changes
}

/**
 * Apply `patch` to a copy of `current`. Returns the new record, or every problem found: an unknown
 * operation, a key named twice, a key that is not there to unset or remove from, an entry that is not
 * listed, a list operation on a value that is not a list, or a patch that changes nothing. Nothing is
 * written here; the caller validates the result as it does any record.
 */
export function applyDirectivesPatch(current: Mapping, patch: unknown): { record: Mapping } | { problems: string[] } {
  if (!isMapping(patch)) return { problems: ['patch must be an object with set, unset, add or remove'] }
  const problems: string[] = []
  for (const name of Object.keys(patch)) {
    if (!(PATCH_OPS as readonly string[]).includes(name)) problems.push(`patch.${name} is not an operation: use ${PATCH_OPS.join(', ')}`)
  }
  const set = patch['set'] ?? {}
  const unset = patch['unset'] ?? []
  const add = patch['add'] ?? {}
  const remove = patch['remove'] ?? {}
  if (!isMapping(set)) problems.push('patch.set must be an object of key to new value')
  if (!Array.isArray(unset) || unset.some((key) => typeof key !== 'string')) problems.push('patch.unset must be a list of key names')
  for (const [name, entries] of [['add', add], ['remove', remove]] as const) {
    if (!isMapping(entries)) problems.push(`patch.${name} must be an object of key to a list of entries`)
    else for (const [key, list] of Object.entries(entries)) if (!Array.isArray(list)) problems.push(`patch.${name}.${key} must be a list of entries`)
  }
  if (problems.length > 0) return { problems }

  const setValues = set as Mapping
  const addLists = add as Record<string, unknown[]>
  const removeLists = remove as Record<string, unknown[]>
  const setKeys = Object.keys(setValues)
  const unsetKeys = unset as string[]
  const addKeys = Object.keys(addLists)
  const removeKeys = Object.keys(removeLists)
  if (setKeys.length + unsetKeys.length + addKeys.length + removeKeys.length === 0) return { problems: ['the patch names no change'] }

  const exclusive = [...setKeys, ...unsetKeys]
  for (const key of new Set(exclusive)) {
    const uses = [setKeys.includes(key) && 'set', unsetKeys.includes(key) && 'unset', addKeys.includes(key) && 'add', removeKeys.includes(key) && 'remove'].filter(Boolean)
    if (uses.length > 1) problems.push(`${key} is named in ${uses.join(' and ')}: a key takes one of set, unset, or add/remove`)
  }
  for (const key of new Set(unsetKeys)) if (unsetKeys.filter((other) => other === key).length > 1) problems.push(`${key} is named twice in unset`)
  if (setKeys.includes('version')) problems.push('version is numbered by the server: it cannot be set')

  const next: Mapping = { ...current }
  for (const key of unsetKeys) {
    if (!(key in current)) problems.push(`unset ${key}: the record has no such key`)
    else delete next[key]
  }
  for (const key of setKeys) next[key] = setValues[key]

  for (const key of removeKeys) {
    const list = next[key]
    if (!(key in current)) problems.push(`remove from ${key}: the record has no such key`)
    else if (!Array.isArray(list)) problems.push(`remove from ${key}: it is not a list`)
    else {
      const entries = removeLists[key] ?? []
      for (const entry of entries) {
        if (!includesEntry(list, entry)) problems.push(`remove from ${key}: ${JSON.stringify(entry)} is not listed`)
      }
      next[key] = list.filter((existing) => !includesEntry(entries, existing))
    }
  }
  for (const key of addKeys) {
    const list = key in next ? next[key] : []
    if (!Array.isArray(list)) problems.push(`add to ${key}: it is not a list`)
    else {
      const grown = [...list]
      for (const entry of addLists[key] ?? []) if (!includesEntry(grown, entry)) grown.push(entry)
      next[key] = grown
    }
  }

  if (problems.length > 0) return { problems }
  if (diffDirectives(current, next).length === 0) return { problems: ['the patch changes nothing: every entry it adds is already listed and every value it sets is already that value'] }
  return { record: next }
}
