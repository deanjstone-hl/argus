/**
 * The AFK directives record's shape. These are the rules argus-config's
 * `tests/check_directives.py` and `hooks/directives_effective.py` apply to the directives
 * file's front matter, so a record the store accepts is one the loop can read. The server
 * numbers versions, so a record carries no `version` of its own.
 */

const REQUIRED_KEYS = ['cadence_minutes', 'max_slots', 'repo_holds', 'take_next', 'ordering'] as const
const OPTIONAL_KEYS = [
  'max_load',
  'max_io_pressure',
  'max_memory_pressure',
  'max_disk_percent',
  'reserve_percent',
  'awaiting_ci_cap',
  'host_caps',
  'host_gates',
  'trunk_repos',
  'budget_exempt_repos',
  'budget_exempt_issues',
  'order_groups',
  'map_order',
  'overrides',
] as const
const KNOWN_KEYS: readonly string[] = [...REQUIRED_KEYS, ...OPTIONAL_KEYS]

const HOSTS = ['wsl2', 'homelab']
const GATE_KEYS = ['max_load', 'max_io_pressure', 'max_memory_pressure', 'max_disk_percent']
// argus#69 (argus-config#1427): quiet_window is a host_gates key only, not a numeric gate: it has no top-level
// value and is never an override key.
const HOST_GATE_KEYS = [...GATE_KEYS, 'quiet_window']
const ORDER_GROUPS = ['bug', 'homelab', 'map_child', 'rest']
const OVERRIDE_KEYS = [
  'max_slots',
  'host_caps',
  'max_load',
  'max_memory_pressure',
  'max_io_pressure',
  'max_disk_percent',
  'repo_holds',
  'ignore_weekly_budget',
  'lift_budget_rung',
]
const LIFT_FIELDS = ['slots', 'models', 'weekly_ceiling_percent']
/** argus#73: the worker models a `lift_budget_rung` override may allow; Opus is never one of them. */
const LIFT_MODELS = ['sonnet', 'haiku'] as const
const OVERRIDE_FIELDS = ['key', 'value', 'until', 'reason']

// HH:MM-HH:MM, 24-hour, as argus-config's hooks/directives_effective.py QUIET_WINDOW.
const QUIET_WINDOW = /^([01]\d|2[0-3]):([0-5]\d)-([01]\d|2[0-3]):([0-5]\d)$/

const REPO_NAME = /^[\w.-]+\/[\w.-]+$/
const ISSUE_REF = /^[\w.-]+\/[\w.-]+#[1-9]\d*$/
// An ISO date-time with an offset: a date-time without one has no instant to compare with.
const AWARE_DATE_TIME = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/

type Mapping = Record<string, unknown>

const isMapping = (value: unknown): value is Mapping => typeof value === 'object' && value !== null && !Array.isArray(value)
const isInteger = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value)
const isPositiveInteger = (value: unknown): value is number => isInteger(value) && value > 0
const isPositiveNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0
const isText = (value: unknown): value is string => typeof value === 'string' && value.trim() !== ''

const isAwareDateTime = (value: unknown): boolean =>
  typeof value === 'string' && AWARE_DATE_TIME.test(value.trim()) && Number.isFinite(Date.parse(value.trim().replace(' ', 'T')))

/** A valid `HH:MM-HH:MM` quiet window: start and end differ, start after end spans midnight. */
function isQuietWindow(value: unknown): boolean {
  if (typeof value !== 'string') return false
  const match = QUIET_WINDOW.exec(value)
  if (!match) return false
  return Number(match[1]) * 60 + Number(match[2]) !== Number(match[3]) * 60 + Number(match[4])
}

/** Why `value` is not valid for an override or gate `key`, or null. */
function valueProblem(key: string, value: unknown, maxSlots: unknown): string | null {
  switch (key) {
    case 'quiet_window':
      return isQuietWindow(value) ? null : 'quiet_window must be HH:MM-HH:MM (Sydney time, start and end differ), e.g. 04:00-05:00'
    case 'max_slots':
      return isPositiveInteger(value) ? null : 'max_slots must be a positive integer'
    case 'max_load':
      return isPositiveNumber(value) ? null : 'max_load must be a positive number'
    case 'max_memory_pressure':
    case 'max_io_pressure':
    case 'max_disk_percent':
      return isPositiveNumber(value) && value <= 100 ? null : `${key} must be a percentage above 0 and at most 100`
    case 'host_caps':
      if (!isMapping(value) || Object.keys(value).length === 0 || !Object.keys(value).every((host) => HOSTS.includes(host))) {
        return 'host_caps must be a mapping of wsl2 and/or homelab'
      }
      for (const cap of Object.values(value)) {
        if (!isInteger(cap) || cap < 0 || (isPositiveInteger(maxSlots) && cap > maxSlots)) {
          return 'host_caps values must be non-negative integers, at most max_slots'
        }
      }
      return null
    case 'repo_holds':
      return Array.isArray(value) && value.length > 0 && value.every((repo) => typeof repo === 'string' && REPO_NAME.test(repo))
        ? null
        : 'repo_holds must be a non-empty list of owner/repo'
    case 'ignore_weekly_budget':
      return value === true ? null : 'ignore_weekly_budget must be true'
    case 'lift_budget_rung':
      return liftProblem(value, maxSlots)
    default:
      return 'unknown key'
  }
}

/** Why `value` is not a valid `lift_budget_rung` mapping (argus#73), or null. */
function liftProblem(value: unknown, maxSlots: unknown): string | null {
  if (!isMapping(value)) return 'lift_budget_rung must be a mapping of slots, models and weekly_ceiling_percent'
  const extra = Object.keys(value).filter((field) => !LIFT_FIELDS.includes(field))
  if (extra.length > 0) return `lift_budget_rung has unknown field: ${extra.sort().join(', ')}`
  if (!('slots' in value)) return 'lift_budget_rung needs slots'
  if (!('weekly_ceiling_percent' in value)) return 'lift_budget_rung needs weekly_ceiling_percent'
  if (!isPositiveInteger(value['slots'])) return 'lift_budget_rung slots must be a positive integer'
  if (isPositiveInteger(maxSlots) && value['slots'] > maxSlots) return 'lift_budget_rung slots must be at most max_slots'
  const ceiling = value['weekly_ceiling_percent']
  if (!(isPositiveNumber(ceiling) && ceiling <= 100)) return 'lift_budget_rung weekly_ceiling_percent must be above 0 and at most 100'
  if ('models' in value && !modelsOf(value['models'])) return 'lift_budget_rung models must be a non-empty list of sonnet and/or haiku'
  return null
}

const modelsOf = (value: unknown): string[] | null =>
  Array.isArray(value) && value.length > 0 && value.every((model) => (LIFT_MODELS as readonly unknown[]).includes(model))
    ? [...new Set(value as string[])]
    : null

/** A live `lift_budget_rung` override (argus#73): the cap and models it sets and the weekly use it stops at. */
export interface BudgetRungLift {
  slots: number
  models: string[]
  weeklyCeilingPercent: number
  /** When the override ends, as the record wrote it. */
  until: number
}

/**
 * argus#73: the `lift_budget_rung` override in `record` that is time-live at `atMs`, or null. Like
 * `ignoreWeeklyBudgetLive` an expired or malformed entry is ignored; of several live ones the one that
 * allows the fewest slots wins, so a second entry can never widen the first. The weekly ceiling is not
 * checked here: it needs the week's use, which the store has.
 */
export function budgetRungLift(record: unknown, atMs: number): BudgetRungLift | null {
  if (!isMapping(record) || !Array.isArray(record['overrides'])) return null
  let found: BudgetRungLift | null = null
  for (const entry of record['overrides']) {
    if (!isMapping(entry) || entry['key'] !== 'lift_budget_rung' || !isAwareDateTime(entry['until'])) continue
    const until = Date.parse(String(entry['until']).trim().replace(' ', 'T'))
    if (atMs >= until || liftProblem(entry['value'], undefined) !== null) continue
    const value = entry['value'] as Mapping
    const lift: BudgetRungLift = {
      slots: value['slots'] as number,
      models: 'models' in value ? (modelsOf(value['models']) as string[]) : [...LIFT_MODELS],
      weeklyCeilingPercent: value['weekly_ceiling_percent'] as number,
      until,
    }
    if (found === null || lift.slots < found.slots) found = lift
  }
  return found
}

/**
 * argus-config#1573: whether a live `ignore_weekly_budget` override is in `record` at `atMs`. An entry applies
 * only while now < until; an expired or malformed entry is ignored, as hooks/directives_effective.py does.
 * The server reads this so the weekly ladder is skipped whatever figures a tick sends.
 */
export function ignoreWeeklyBudgetLive(record: unknown, atMs: number): boolean {
  if (!isMapping(record) || !Array.isArray(record['overrides'])) return false
  return record['overrides'].some(
    (entry) =>
      isMapping(entry) &&
      entry['key'] === 'ignore_weekly_budget' &&
      entry['value'] === true &&
      isAwareDateTime(entry['until']) &&
      atMs < Date.parse(String(entry['until']).trim().replace(' ', 'T')),
  )
}

/**
 * argus#60: the owner-named issues in a record's `budget_exempt_issues`, sorted, without repeats. An entry that
 * is not an `owner/repo#N` string is skipped (the validator refuses it at write), so a reader never throws.
 */
export function budgetExemptIssues(record: unknown): string[] {
  const listed = isMapping(record) ? record['budget_exempt_issues'] : undefined
  if (!Array.isArray(listed)) return []
  return [...new Set(listed.filter((entry): entry is string => typeof entry === 'string' && ISSUE_REF.test(entry)))].sort()
}

function overrideEntryProblems(entry: unknown, maxSlots: unknown): string[] {
  if (!isMapping(entry)) return ['must be a mapping of key, value, until and reason']
  const found: string[] = []
  const missing = OVERRIDE_FIELDS.filter((field) => !(field in entry))
  const extra = Object.keys(entry).filter((field) => !OVERRIDE_FIELDS.includes(field))
  if (missing.length > 0) found.push(`missing field: ${missing.sort().join(', ')}`)
  if (extra.length > 0) found.push(`unknown field: ${extra.sort().join(', ')}`)
  if (missing.length > 0) return found
  const key = String(entry['key'])
  if (!OVERRIDE_KEYS.includes(key)) {
    found.push(`key must be one of ${OVERRIDE_KEYS.join(', ')}`)
  } else {
    const problem = valueProblem(key, entry['value'], maxSlots)
    if (problem) found.push(problem)
  }
  if (!isAwareDateTime(entry['until'])) found.push('until must be an ISO date-time with an offset, e.g. 2026-11-04T18:00:00+11:00')
  if (!isText(entry['reason'])) found.push('reason must be a non-empty string')
  return found
}

function listOfStrings(record: Mapping, key: string, pattern: RegExp, shape: string): string[] {
  const value = record[key]
  if (value === undefined) return []
  if (!Array.isArray(value)) return [`${key} must be a list`]
  return value.flatMap((entry, index) => (typeof entry === 'string' && pattern.test(entry) ? [] : [`${key}[${index}]: must be ${shape}`]))
}

/** Every way `record` is not a valid directives record; empty when it is valid. */
export function directivesProblems(record: unknown): string[] {
  if (!isMapping(record)) return ['record must be an object']
  const found: string[] = []
  if ('version' in record) found.push('version is assigned by the server: leave it out of the record')
  found.push(...REQUIRED_KEYS.filter((key) => !(key in record)).map((key) => `missing key: ${key}`))
  found.push(...Object.keys(record).filter((key) => key !== 'version' && !KNOWN_KEYS.includes(key)).map((key) => `unknown key: ${key}`))

  for (const key of ['cadence_minutes', 'max_slots'] as const) {
    if (key in record && !isPositiveInteger(record[key])) found.push(`${key} must be a positive integer`)
  }
  const maxSlots = record['max_slots']
  if ('max_load' in record && !isPositiveNumber(record['max_load'])) found.push('max_load must be a positive number')
  for (const key of ['max_io_pressure', 'max_memory_pressure', 'max_disk_percent']) {
    if (key in record && !(isPositiveNumber(record[key]) && (record[key] as number) <= 100)) {
      found.push(`${key} must be a percentage above 0 and at most 100`)
    }
  }
  // argus-config#1169: how many slots may await CI at once; 0 turns awaiting_ci off, absent means 3.
  if ('awaiting_ci_cap' in record && !(isInteger(record['awaiting_ci_cap']) && (record['awaiting_ci_cap'] as number) >= 0)) {
    found.push('awaiting_ci_cap must be a non-negative integer')
  }
  if ('reserve_percent' in record) {
    const reserve = record['reserve_percent']
    if (!(typeof reserve === 'number' && Number.isFinite(reserve) && reserve >= 0 && reserve < 100)) {
      found.push('reserve_percent must be a percentage from 0 to below 100')
    }
  }

  if ('host_caps' in record) {
    const caps = record['host_caps']
    if (!isMapping(caps) || Object.keys(caps).length === 0 || !Object.keys(caps).every((host) => HOSTS.includes(host))) {
      found.push('host_caps must be a mapping of wsl2 and/or homelab')
    } else {
      for (const [host, cap] of Object.entries(caps)) {
        if (!isInteger(cap) || cap < 0 || (isPositiveInteger(maxSlots) && cap > maxSlots)) {
          found.push(`host_caps.${host} must be a non-negative integer, at most max_slots`)
        }
      }
    }
  }

  found.push(...listOfStrings(record, 'trunk_repos', REPO_NAME, 'owner/repo'))
  found.push(...listOfStrings(record, 'budget_exempt_repos', REPO_NAME, 'owner/repo'))
  found.push(...listOfStrings(record, 'budget_exempt_issues', ISSUE_REF, 'owner/repo#N'))

  if ('order_groups' in record) {
    const groups = record['order_groups']
    if (!Array.isArray(groups)) {
      found.push('order_groups must be a list')
    } else {
      groups.forEach((group, index) => {
        if (!ORDER_GROUPS.includes(String(group))) found.push(`order_groups[${index}]: must be one of ${ORDER_GROUPS.join(', ')}`)
      })
      if (new Set(groups.map(String)).size !== groups.length) found.push('order_groups must not repeat a group')
    }
  }

  if ('map_order' in record) {
    const maps = record['map_order']
    if (!Array.isArray(maps)) {
      found.push('map_order must be a list')
    } else {
      maps.forEach((ref, index) => {
        if (!ISSUE_REF.test(String(ref))) found.push(`map_order[${index}]: must be owner/repo#N`)
      })
      if (new Set(maps.map(String)).size !== maps.length) found.push('map_order must not repeat a map')
    }
  }

  const overrides = record['overrides']
  if (overrides !== undefined && overrides !== null) {
    if (!Array.isArray(overrides)) {
      found.push('overrides must be a list')
    } else {
      overrides.forEach((entry, index) => {
        found.push(...overrideEntryProblems(entry, maxSlots).map((problem) => `overrides[${index}]: ${problem}`))
      })
    }
  }

  if ('host_gates' in record) {
    const gates = record['host_gates']
    if (!isMapping(gates) || Object.keys(gates).length === 0 || !Object.keys(gates).every((host) => HOSTS.includes(host))) {
      found.push('host_gates must be a mapping of wsl2 and/or homelab')
    } else {
      for (const [host, entry] of Object.entries(gates)) {
        if (!isMapping(entry) || Object.keys(entry).length === 0 || !Object.keys(entry).every((key) => HOST_GATE_KEYS.includes(key))) {
          found.push(`host_gates.${host} must be a mapping of ${HOST_GATE_KEYS.join(', ')}`)
          continue
        }
        for (const [key, value] of Object.entries(entry)) {
          const problem = valueProblem(key, value, maxSlots)
          if (problem) found.push(`host_gates.${host}.${problem}`)
        }
      }
    }
  }

  const holds = record['repo_holds']
  if (holds !== undefined) {
    if (!Array.isArray(holds)) {
      found.push('repo_holds must be a list')
    } else {
      holds.forEach((hold, index) => {
        const entry = isMapping(hold) ? hold : {}
        if (!REPO_NAME.test(String(entry['repo'] ?? ''))) found.push(`repo_holds[${index}]: repo must be owner/name`)
        if (!isText(entry['reason'])) found.push(`repo_holds[${index}]: reason must be a non-empty string`)
      })
    }
  }

  const takeNext = record['take_next']
  if (takeNext !== undefined) {
    if (!Array.isArray(takeNext)) {
      found.push('take_next must be a list')
    } else {
      takeNext.forEach((ref, index) => {
        if (!ISSUE_REF.test(String(ref))) found.push(`take_next[${index}]: must be owner/repo#N`)
      })
    }
  }

  const ordering = record['ordering']
  if (ordering !== undefined && !(Array.isArray(ordering) && ordering.every(isText))) found.push('ordering must be a list of strings')

  return found
}
