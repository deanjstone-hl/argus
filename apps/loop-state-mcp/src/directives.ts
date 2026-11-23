/**
 * The AFK directives record's shape. These are the rules argus-config's
 * `tests/check_directives.py` and `hooks/directives_effective.py` apply to the directives
 * file's front matter, so a record the store accepts is one the loop can read. The server
 * numbers versions, so a record carries no `version` of its own.
 */

type Mapping = Record<string, unknown>
type Check = (value: unknown, key: string, maxSlots: unknown) => string[]

/** Where a directive key may appear: the record's top level, a `host_gates.<host>` entry, or an override's `key`. */
export const KEY_PLACES = ['record', 'host_gate', 'override'] as const
export type KeyPlace = (typeof KEY_PLACES)[number]

interface KeyRule extends Partial<Record<KeyPlace, Check>> {
  required?: true
}

const HOSTS = ['wsl2', 'homelab']
const ORDER_GROUPS = ['bug', 'homelab', 'map_child', 'rest']
const OVERRIDE_FIELDS = ['key', 'value', 'until', 'reason']
const LIFT_FIELDS = ['slots', 'models', 'weekly_ceiling_percent']
/** argus#73: the worker models a `lift_budget_rung` override may allow; Opus is never one of them. */
const LIFT_MODELS = ['sonnet', 'haiku'] as const
const PACE_BONUS_FIELDS = ['below_pace', 'total_cap']

const QUIET_WINDOW = /^([01]\d|2[0-3]):([0-5]\d)-([01]\d|2[0-3]):([0-5]\d)$/
const REPO_NAME = /^[\w.-]+\/[\w.-]+$/
const ISSUE_REF = /^[\w.-]+\/[\w.-]+#[1-9]\d*$/
const AWARE_DATE_TIME = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/

const isMapping = (value: unknown): value is Mapping => typeof value === 'object' && value !== null && !Array.isArray(value)
const isInteger = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value)
const isPositiveInteger = (value: unknown): value is number => isInteger(value) && value > 0
const isPositiveNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0
const isText = (value: unknown): value is string => typeof value === 'string' && value.trim() !== ''
const unless = (ok: boolean, problem: string): string[] => (ok ? [] : [problem])

function untilMs(value: unknown): number | null {
  if (typeof value !== 'string' || !AWARE_DATE_TIME.test(value.trim())) return null
  const ms = Date.parse(value.trim().replace(' ', 'T'))
  return Number.isFinite(ms) ? ms : null
}

function isQuietWindow(value: unknown): boolean {
  const match = typeof value === 'string' ? QUIET_WINDOW.exec(value) : null
  return match !== null && Number(match[1]) * 60 + Number(match[2]) !== Number(match[3]) * 60 + Number(match[4])
}

const positiveInteger: Check = (value, key) => unless(isPositiveInteger(value), `${key} must be a positive integer`)
const positiveNumber: Check = (value, key) => unless(isPositiveNumber(value), `${key} must be a positive number`)
const percentage: Check = (value, key) => unless(isPositiveNumber(value) && value <= 100, `${key} must be a percentage above 0 and at most 100`)

const listOf =
  (pattern: RegExp, shape: string): Check =>
  (value, key) =>
    Array.isArray(value)
      ? value.flatMap((entry, index) => unless(typeof entry === 'string' && pattern.test(entry), `${key}[${index}]: must be ${shape}`))
      : [`${key} must be a list`]

const uniqueListOf =
  (valid: (entry: unknown) => boolean, shape: string, noun: string): Check =>
  (value, key) => {
    if (!Array.isArray(value)) return [`${key} must be a list`]
    return [
      ...value.flatMap((entry, index) => unless(valid(entry), `${key}[${index}]: must be ${shape}`)),
      ...unless(new Set(value.map(String)).size === value.length, `${key} must not repeat a ${noun}`),
    ]
  }

const hostCaps: Check = (value, key, maxSlots) => {
  if (!isMapping(value) || Object.keys(value).length === 0 || !Object.keys(value).every((host) => HOSTS.includes(host))) {
    return [`${key} must be a mapping of wsl2 and/or homelab`]
  }
  return Object.entries(value).flatMap(([host, cap]) =>
    unless(isInteger(cap) && cap >= 0 && !(isPositiveInteger(maxSlots) && cap > maxSlots), `${key}.${host} must be a non-negative integer, at most max_slots`),
  )
}

const liftCheck: Check = (value, key, maxSlots) => {
  if (!isMapping(value)) return [`${key} must be a mapping of slots, models and weekly_ceiling_percent`]
  const extra = Object.keys(value).filter((field) => !LIFT_FIELDS.includes(field))
  if (extra.length > 0) return [`${key} has unknown field: ${extra.sort().join(', ')}`]
  if (!('slots' in value)) return [`${key} needs slots`]
  if (!('weekly_ceiling_percent' in value)) return [`${key} needs weekly_ceiling_percent`]
  if (!isPositiveInteger(value['slots'])) return [`${key} slots must be a positive integer`]
  if (isPositiveInteger(maxSlots) && value['slots'] > maxSlots) return [`${key} slots must be at most max_slots`]
  const ceiling = value['weekly_ceiling_percent']
  if (!(isPositiveNumber(ceiling) && ceiling <= 100)) return [`${key} weekly_ceiling_percent must be above 0 and at most 100`]
  if ('models' in value && !modelsOf(value['models'])) return [`${key} models must be a non-empty list of sonnet and/or haiku`]
  return []
}

const paceBonusCheck: Check = (value, key, maxSlots) => {
  if (!isMapping(value)) return [`${key} must be a mapping of below_pace and total_cap`]
  const extra = Object.keys(value).filter((field) => !PACE_BONUS_FIELDS.includes(field))
  if (extra.length > 0) return [`${key} has unknown field: ${extra.sort().join(', ')}`]
  if (!('below_pace' in value)) return [`${key} needs below_pace`]
  if (!('total_cap' in value)) return [`${key} needs total_cap`]
  if (!isPositiveNumber(value['below_pace'])) return [`${key} below_pace must be a positive number`]
  if (!isPositiveInteger(value['total_cap'])) return [`${key} total_cap must be a positive integer`]
  if (isPositiveInteger(maxSlots) && value['total_cap'] < maxSlots) return [`${key} total_cap must be at least max_slots`]
  return []
}

const repoHolds: Check = (value, key) =>
  Array.isArray(value)
    ? value.flatMap((hold, index) => {
        const entry = isMapping(hold) ? hold : {}
        return [
          ...unless(REPO_NAME.test(String(entry['repo'] ?? '')), `${key}[${index}]: repo must be owner/name`),
          ...unless(isText(entry['reason']), `${key}[${index}]: reason must be a non-empty string`),
        ]
      })
    : [`${key} must be a list`]

const overrideRepoHolds: Check = (value, key) =>
  unless(Array.isArray(value) && value.length > 0 && value.every((repo) => typeof repo === 'string' && REPO_NAME.test(repo)), `${key} must be a non-empty list of owner/repo`)

const hostGates: Check = (value, key, maxSlots) => {
  if (!isMapping(value) || Object.keys(value).length === 0 || !Object.keys(value).every((host) => HOSTS.includes(host))) {
    return [`${key} must be a mapping of wsl2 and/or homelab`]
  }
  return Object.entries(value).flatMap(([host, entry]) => {
    if (!isMapping(entry) || Object.keys(entry).length === 0 || !Object.keys(entry).every((gate) => HOST_GATE_KEYS.includes(gate))) {
      return [`${key}.${host} must be a mapping of ${HOST_GATE_KEYS.join(', ')}`]
    }
    return Object.entries(entry).flatMap(([gate, gateValue]) => (ruleOf(gate).host_gate as Check)(gateValue, gate, maxSlots).map((problem) => `${key}.${host}.${problem}`))
  })
}

const overrides: Check = (value, key, maxSlots) => {
  if (value === null) return []
  if (!Array.isArray(value)) return [`${key} must be a list`]
  return value.flatMap((entry, index) => overrideEntryProblems(entry, maxSlots).map((problem) => `${key}[${index}]: ${problem}`))
}

/** A numeric host gate: a top-level default, a per-host value under `host_gates`, and a time-boxed override. */
const gate = (check: Check): KeyRule => ({ record: check, host_gate: check, override: check })

/**
 * Every directive key, and the check for each place it may appear. A key's places are declared here and
 * nowhere else, so a gate added as `gate(...)` is accepted at the top level, under host_gates and as an
 * override at once.
 */
const KEY_RULES = {
  cadence_minutes: { required: true, record: positiveInteger },
  max_slots: { required: true, record: positiveInteger, override: positiveInteger },
  repo_holds: { required: true, record: repoHolds, override: overrideRepoHolds },
  take_next: { required: true, record: listOf(ISSUE_REF, 'owner/repo#N') },
  ordering: { required: true, record: (value, key) => unless(Array.isArray(value) && value.every(isText), `${key} must be a list of strings`) },
  max_load: gate(positiveNumber),
  max_io_pressure: gate(percentage),
  max_memory_pressure: gate(percentage),
  max_disk_percent: gate(percentage),
  quiet_window: {
    host_gate: (value, key) => unless(isQuietWindow(value), `${key} must be HH:MM-HH:MM (Sydney time, start and end differ), e.g. 04:00-05:00`),
  },
  reserve_percent: {
    record: (value, key) => unless(typeof value === 'number' && Number.isFinite(value) && value >= 0 && value < 100, `${key} must be a percentage from 0 to below 100`),
  },
  awaiting_ci_cap: { record: (value, key) => unless(isInteger(value) && value >= 0, `${key} must be a non-negative integer`) },
  host_caps: { record: hostCaps, override: hostCaps },
  host_gates: { record: hostGates },
  trunk_repos: { record: listOf(REPO_NAME, 'owner/repo') },
  pr_flow_repos: { record: listOf(REPO_NAME, 'owner/repo') },
  budget_exempt_repos: { record: listOf(REPO_NAME, 'owner/repo') },
  budget_exempt_issues: { record: listOf(ISSUE_REF, 'owner/repo#N') },
  order_groups: { record: uniqueListOf((group) => ORDER_GROUPS.includes(String(group)), `one of ${ORDER_GROUPS.join(', ')}`, 'group') },
  map_order: { record: uniqueListOf((ref) => ISSUE_REF.test(String(ref)), 'owner/repo#N', 'map') },
  overrides: { record: overrides },
  pace_slot_bonus: { record: paceBonusCheck },
  ignore_weekly_budget: { override: (value, key) => unless(value === true, `${key} must be true`) },
  lift_budget_rung: { override: liftCheck },
} satisfies Record<string, KeyRule>

export type DirectiveKey = keyof typeof KEY_RULES

const ruleOf = (key: string): KeyRule => (KEY_RULES as Record<string, KeyRule>)[key] as KeyRule
const RULES = Object.entries(KEY_RULES) as [DirectiveKey, KeyRule][]
const keysIn = (place: KeyPlace): string[] => RULES.filter(([, rule]) => rule[place] !== undefined).map(([key]) => key)
const REQUIRED_KEYS = RULES.filter(([, rule]) => rule.required).map(([key]) => key)
const RECORD_KEYS = keysIn('record')
const HOST_GATE_KEYS = keysIn('host_gate')
const OVERRIDE_KEYS = keysIn('override')

/** Each directive key and the places it may appear, for clients that validate a record before sending it. */
export function directiveKeyPlaces(): Record<DirectiveKey, KeyPlace[]> {
  return Object.fromEntries(RULES.map(([key, rule]) => [key, KEY_PLACES.filter((place) => rule[place] !== undefined)])) as Record<DirectiveKey, KeyPlace[]>
}

function overrideEntryProblems(entry: unknown, maxSlots: unknown): string[] {
  if (!isMapping(entry)) return ['must be a mapping of key, value, until and reason']
  const missing = OVERRIDE_FIELDS.filter((field) => !(field in entry))
  const extra = Object.keys(entry).filter((field) => !OVERRIDE_FIELDS.includes(field))
  const found = [...unless(missing.length === 0, `missing field: ${missing.sort().join(', ')}`), ...unless(extra.length === 0, `unknown field: ${extra.sort().join(', ')}`)]
  if (missing.length > 0) return found
  const key = String(entry['key'])
  const check = OVERRIDE_KEYS.includes(key) ? ruleOf(key).override : undefined
  found.push(...(check ? check(entry['value'], key, maxSlots) : [`key must be one of ${OVERRIDE_KEYS.join(', ')}`]))
  found.push(...unless(untilMs(entry['until']) !== null, 'until must be an ISO date-time with an offset, e.g. 2026-11-04T18:00:00+11:00'))
  found.push(...unless(isText(entry['reason']), 'reason must be a non-empty string'))
  return found
}

/** Every way `record` is not a valid directives record; empty when it is valid. */
export function directivesProblems(record: unknown): string[] {
  if (!isMapping(record)) return ['record must be an object']
  const maxSlots = record['max_slots']
  return [
    ...unless(!('version' in record), 'version is assigned by the server: leave it out of the record'),
    ...REQUIRED_KEYS.filter((key) => !(key in record)).map((key) => `missing key: ${key}`),
    ...Object.entries(record).flatMap(([key, value]) => {
      if (key === 'version') return []
      if (!RECORD_KEYS.includes(key)) return [`unknown key: ${key}`]
      return (ruleOf(key).record as Check)(value, key, maxSlots)
    }),
  ]
}

const modelsOf = (value: unknown): string[] | null =>
  Array.isArray(value) && value.length > 0 && value.every((model) => (LIFT_MODELS as readonly unknown[]).includes(model))
    ? [...new Set(value as string[])]
    : null

/** The override entries for `key` in `record` that are well formed and still live at `atMs`, each with its end. */
function liveOverrides(record: unknown, key: DirectiveKey, atMs: number): { value: unknown; until: number }[] {
  if (!isMapping(record) || !Array.isArray(record['overrides'])) return []
  const check = ruleOf(key).override as Check
  return record['overrides'].flatMap((entry) => {
    if (!isMapping(entry) || entry['key'] !== key) return []
    const until = untilMs(entry['until'])
    if (until === null || atMs >= until || check(entry['value'], key, undefined).length > 0) return []
    return [{ value: entry['value'], until }]
  })
}

/** The `pace_slot_bonus` setting (argus#64): the total cap while the week's pace is below `belowPace`. */
export interface PaceSlotBonus {
  belowPace: number
  totalCap: number
}

/** argus#64: the `pace_slot_bonus` in `record`, or null when it is absent or malformed. */
export function paceSlotBonus(record: unknown): PaceSlotBonus | null {
  if (!isMapping(record) || !('pace_slot_bonus' in record) || paceBonusCheck(record['pace_slot_bonus'], 'pace_slot_bonus', undefined).length > 0) return null
  const value = record['pace_slot_bonus'] as Mapping
  return { belowPace: value['below_pace'] as number, totalCap: value['total_cap'] as number }
}

/** A live `lift_budget_rung` override (argus#73): the cap and models it sets and the weekly use it stops at. */
export interface BudgetRungLift {
  slots: number
  models: string[]
  weeklyCeilingPercent: number
  until: number
}

/**
 * argus#73: the `lift_budget_rung` override in `record` that is live at `atMs`, or null. Of several live
 * ones the one that allows the fewest slots wins, so a second entry can never widen the first. The weekly
 * ceiling is not checked here: it needs the week's use, which the store has.
 */
export function budgetRungLift(record: unknown, atMs: number): BudgetRungLift | null {
  const lifts = liveOverrides(record, 'lift_budget_rung', atMs).map(({ value, until }): BudgetRungLift => {
    const lift = value as Mapping
    return {
      slots: lift['slots'] as number,
      models: 'models' in lift ? (modelsOf(lift['models']) as string[]) : [...LIFT_MODELS],
      weeklyCeilingPercent: lift['weekly_ceiling_percent'] as number,
      until,
    }
  })
  return lifts.reduce<BudgetRungLift | null>((found, lift) => (found === null || lift.slots < found.slots ? lift : found), null)
}

/** argus#64: whether a live `max_slots` override is in `record` at `atMs`; the pace bonus never moves a hand-set cap. */
export function maxSlotsOverrideLive(record: unknown, atMs: number): boolean {
  return liveOverrides(record, 'max_slots', atMs).length > 0
}

/** argus-config#1573: whether a live `ignore_weekly_budget` override is in `record` at `atMs`. */
export function ignoreWeeklyBudgetLive(record: unknown, atMs: number): boolean {
  return liveOverrides(record, 'ignore_weekly_budget', atMs).length > 0
}

/** argus#60: the owner-named issues in a record's `budget_exempt_issues`, sorted, without repeats. */
export function budgetExemptIssues(record: unknown): string[] {
  const listed = isMapping(record) ? record['budget_exempt_issues'] : undefined
  if (!Array.isArray(listed)) return []
  return [...new Set(listed.filter((entry): entry is string => typeof entry === 'string' && ISSUE_REF.test(entry)))].sort()
}
