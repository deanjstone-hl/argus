import { DatabaseSync, type SQLInputValue } from 'node:sqlite'

import { budgetExemptIssues, directivesProblems, ignoreWeeklyBudgetLive } from './directives.js'
import { planRebuild, type RebuildPlan, type World } from './rebuild.js'
import type { Role } from './roles.js'

/**
 * The loop-state db: slots, loop status, leases, Aquila's ledger and the event log the
 * quiet-tick gate reads.
 * Every write goes through a method here that names the calling role and is checked
 * against TOOL_ROLES, so the MCP layer cannot reach the db around the access rules.
 */

export const DEFAULT_CADENCE_MS = 30 * 60_000
/** Slack before a tick counts as missed: `schedule_task` fires a little late under load. */
export const DEFAULT_GRACE_MS = 5 * 60_000
/** A thread woken by POST /wake/check must answer with a model tick within this, or it is stalled (argus#831). */
export const WAKE_ACK_MS = 10 * 60_000
/** The primary is woken anyway once the model has recorded no tick for this long, however quiet the loop is. */
export const HEARTBEAT_MS = 4 * 60 * 60_000
/**
 * argus#1167: change kinds that are never the only reason POST /wake/check wakes a thread. They are
 * Aquila's own ledger writes (an owner turn, an away note, a push, a child's start or close): nothing in
 * them is left for a model tick to do. Next to a real reason they are left out of its name; tick_gate
 * still reports them.
 */
const isWakeNoise = (reason: string) =>
  reason === 'owner_turn' || reason === 'owner_thread_set' || reason === 'away_noted' || reason === 'notified' || reason === 'promoted' || reason.startsWith('child_')

/**
 * argus#1167: a pressure level that differs from the last recorded tick wakes POST /wake/check only once
 * the check has seen the same new level for this long. Shorter than the 30 min cadence, so two polls in a
 * row at the new level always satisfy it, and a flip that is gone by the next poll never wakes.
 */
export const DEFAULT_PRESSURE_DWELL_MS = 20 * 60_000
/**
 * argus#1189: ops-hub's POST /wake/request. The same issue is refused again for this long after a request
 * was recorded, and every issue together is capped per hour, so repeated presses cannot wake Aquila in a loop.
 */
export const WAKE_REQUEST_COOLDOWN_MS = 2 * 60_000
export const WAKE_REQUEST_HOURLY_CAP = 6
const WAKE_REQUEST_WINDOW_MS = 60 * 60_000
/** status_read counts the ticks of this window, so the saving from client-recorded quiet ticks can be measured. */
const TICK_COUNT_WINDOW_MS = 7 * 24 * 60 * 60_000

/** Which roles may call each tool. The MCP layer registers a tool only for these roles. */
export const TOOL_ROLES = {
  slot_start: ['afk'],
  slot_park: ['afk'],
  slot_close: ['afk'],
  slot_free: ['afk'],
  slot_unpark: ['direction'],
  slot_report: ['worker'],
  slot_await_ci: ['worker'],
  slot_resume_ci: ['direction'],
  slot_list: ['afk', 'direction', 'worker'],
  slot_rebuild: ['afk', 'direction'],
  status_tick: ['afk', 'direction'],
  tick_gate: ['afk', 'direction'],
  status_read: ['afk', 'direction', 'worker'],
  lease_read: ['afk', 'direction'],
  lease_move: ['direction'],
  lease_release: ['direction'],
  lease_failover: ['afk', 'direction'],
  lease_reclaim: ['afk', 'direction'],
  child_start: ['direction'],
  child_close: ['direction'],
  owner_turn: ['direction'],
  owner_thread_set: ['direction'],
  away_note: ['direction'],
  notify_claim: ['direction'],
  outage_observe: ['direction'],
  ledger_read: ['direction'],
  directives_read: ['afk', 'direction'],
  directives_set: ['direction'],
  // Not an MCP tool: the loop-wake client's HTTP route, POST /wake/check.
  wake_check: ['afk', 'direction'],
} as const satisfies Record<string, readonly Role[]>
export type ToolName = keyof typeof TOOL_ROLES

export const SLOT_STATES = ['running', 'parked', 'ready', 'awaiting_ci'] as const
export type SlotState = (typeof SLOT_STATES)[number]

/** argus-config#1169: how many slots may await CI at once when the directives set no `awaiting_ci_cap`. */
export const DEFAULT_AWAITING_CI_CAP = 3

export const REPORT_OUTCOMES = ['complete', 'needs_owner', 'failed'] as const
export type ReportOutcome = (typeof REPORT_OUTCOMES)[number]

/**
 * The window ladder (#659): ≥70% no new Opus workers, ≥85% no new slots, ≥95% gate-only ticks.
 * The weekly budget ladder (argus#62: weekly pace again, replacing #871's burn ÷ allowance) uses the same levels;
 * the effective level is the stricter of the two.
 */
export const PRESSURE_LEVELS = ['unknown', 'normal', 'no_opus', 'no_new_slots', 'gate_only'] as const
export type PressureLevel = (typeof PRESSURE_LEVELS)[number]

export type TickingRole = Exclude<Role, 'worker'>

export const CHILD_OUTCOMES = ['done', 'failed', 'abandoned'] as const
export type ChildOutcome = (typeof CHILD_OUTCOMES)[number]

/** Aquila's brrr notification classes (#660): new needs:owner items, the AFK loop stalling, window ≥85%. */
export const NOTIFY_CLASSES = ['needs_owner', 'stall', 'window'] as const
export type NotifyClass = (typeof NOTIFY_CLASSES)[number]

/** Presence = an owner turn in the direction thread within the last 30 minutes (#660). */
export const PRESENCE_MS = 30 * 60_000

/** A refusal the caller can act on: a role rule, a bad argument, or a slot in the wrong state. */
export class Refused extends Error {}

/**
 * A refusal that keeps the lease_conflict event it recorded. It is thrown before the call
 * writes anything else, so committing the transaction commits only the event.
 */
class LeaseRefused extends Refused {}

export interface StoreOptions {
  path: string
  now?: () => number
  cadenceMs?: number
  graceMs?: number
  /** How long a pressure flip must hold before POST /wake/check wakes for it (argus#1167). 0 wakes at the first poll. */
  pressureDwellMs?: number
  /**
   * Refuse an afk slot write or an owner_turn that names no `caller_thread_id` (argus#882,
   * argus#1042). Off by default for one release: a charter that does not pass the id yet is
   * accepted with a warning event instead of stalling the loop.
   */
  requireCallerThread?: boolean
  /**
   * Refuse a call that names its own thread but arrives with no X-T3-Thread-Id header (argus#51).
   * Off by default: a caller whose headersHelper does not send it yet is accepted, as before.
   */
  requireThreadHeader?: boolean
  /** Where the missing-header notice goes. Default console.warn. */
  warn?: (message: string) => void
}

/** The prefix of the `errors` entry in which the afk holder hands a homelab slot to the standby's drain (argus#57). */
const DRAIN_LEFT_MARKER = 'drain-left:'

/** Whether `text` names `issue` (both lower case) as a whole token, so `owner/repo#1` is not found in `owner/repo#10`. */
const namesIssue = (text: string, issue: string): boolean => {
  for (let at = text.indexOf(issue); at !== -1; at = text.indexOf(issue, at + 1)) {
    if (!/\d/.test(text[at + issue.length] ?? '')) return true
  }
  return false
}

/** Who is writing a slot, so the server can check the afk lease. `host` is the caller's own host, for the drain. */
export interface SlotCaller {
  caller_thread_id?: string
  host?: Host
}

/** A slot write's result: the slot, and a warning when the afk lease was not checked. */
export interface SlotWrite {
  slot: Slot
  warning?: string
}

const withWarning = (slot: Slot, warning: string | null): SlotWrite => (warning === null ? { slot } : { slot, warning })

/**
 * What slot_close and slot_free answer with (argus#1191): the slot's last row, relabelled. The
 * row is deleted, so its own `state` would read `running` and look like a refused close;
 * `previous_state` keeps what it was.
 */
export type EndedSlot = Omit<Slot, 'state'> & { state: 'closed' | 'freed'; previous_state: SlotState }
export type ClosedSlot = EndedSlot & { state: 'closed'; verified: string; closed_at: string }
export type FreedSlot = EndedSlot & { state: 'freed'; reason: string; freed_at: string }

const withEndedWarning = <T extends EndedSlot>(slot: T, warning: string | null): { slot: T; warning?: string } =>
  warning === null ? { slot } : { slot, warning }

export interface Slot {
  issue: string
  thread_id: string
  state: SlotState
  host: Host
  started_at: string
  updated_at: string
  note: string | null
  /** Tool approvals the worker thread is waiting on, as the AFK tick last read them; 0 unless the slot is running. */
  pending_approvals: number
  /** argus#1171: started for an efficiency:orchestrator issue, outside the budget ladder and the slot caps. */
  budget_exempt: boolean
  /** argus-config#1169: the PR URL or trunk SHA an awaiting_ci slot waits on; null in every other state. */
  ci_ref: string | null
  report: { outcome: ReportOutcome; note: string | null; pr: string | null; at: string } | null
}

export interface Change {
  kind: string
  issue: string | null
  role: Role
  at: string
  /** A `promoted` change only (argus#1118): the repo and the deploy tips it moved between. */
  repo?: string
  from_sha?: string | null
  to_sha?: string
  source?: string
}

/** ops-hub's report that it moved a repo's `deploy` branch (argus#1118). */
export interface PromotedInput {
  repo: string
  from_sha: string | null
  to_sha: string
  at: string
  source: 'approve' | 'webhook'
}

/**
 * The budget ladder as a wake request answers it (argus#47): the rung the slot gate enforces, and whether
 * hysteresis holds it. `budget_rung` is null while no tick has recorded a weekly figure: the ladder is unseen.
 */
export interface WakeBudget {
  budget_rung: BudgetRung | null
  budget_rung_held: boolean
}

/** The answer to a wake request (argus#1189): recorded, folded into one still pending, or refused by the rate limit. Each carries the budget rung. */
export type WakeRequestResult = WakeBudget &
  ({ recorded: true } | { recorded: false; reason: 'pending' } | { rate_limited: true; retry_after_seconds: number })

export interface TickInput {
  thread_id: string
  directives_version: string
  needs_owner: string[]
  /** The total slot cap. `total_cap` is the same field under its ladder v2 name; if both are given, `total_cap` wins. */
  slot_cap?: number
  total_cap?: number
  /** Per-host caps from the directives; a host left out has none. */
  host_caps?: HostCaps
  /** Repos (`owner/repo`) whose slots sit outside the slot caps (argus#1012, #1033). Nothing else is waived. */
  budget_exempt_repos?: string[]
  errors?: string[]
  window_used_percent?: number
  pressure?: PressureLevel
  /** The week's usage and when the week resets (ISO UTC); given together. */
  weekly_used_percent?: number
  weekly_resets_at?: string
  /** The share of the week held back, 0 up to 100; default 10. */
  reserve_percent?: number
}

/** status_tick only: the count per running slot, keyed by issue. An issue left out keeps its count; 0 clears it. */
export interface StatusTickInput extends TickInput {
  pending_approvals?: Record<string, number>
}

/** Whether the ticking thread holds its role's lease. A non-holder's tick records nothing. */
export interface LeaseCheck {
  holds_lease: boolean
  lease_holder: string | null
}

export interface GateResult extends LeaseCheck {
  changed: boolean
  reasons: string[]
  changes: Change[]
  recorded: boolean
  since: string | null
}

/** Who recorded a tick: the model (tick_gate, status_tick) or the loop-wake client (POST /wake/check). */
export type TickRecorder = 'model' | 'client'

export interface WakeCheckInput {
  role: TickingRole
  host: Host
  thread_id: string
  directives_version: string
  needs_owner: string[]
  window_used_percent?: number
  weekly_used_percent?: number
  weekly_resets_at?: string
  reserve_percent?: number
  /** afk only: how many issues the loop could take now. */
  takeable?: number
  /** argus#1171: how many of the takeable issues carry efficiency:orchestrator. Needed to wake at no_new_slots. */
  takeable_exempt?: number
  /**
   * argus#1167, afk only: whether the host's own gates (load, memory pressure, disk, quiet window) allow a
   * start. `false` stops `free_slot` waking, since the thread could not start the slot. Left out reads as true.
   */
  host_gates_ok?: boolean
}

export interface WakeResult {
  wake: boolean
  reason: string
  recorded: boolean
}

export interface Lease {
  thread_id: string
  since: string
  /** The thread a failover hands the lease back to: the last thread given it by lease_move. */
  primary_thread_id: string | null
  /** The host of the primary: lease_reclaim hands the lease to a new thread on it. Null when lease_move was given no host. */
  primary_host: Host | null
}

/** Where a slot's worker thread runs: each host's T3 lists only its own threads. */
export const HOSTS = ['wsl2', 'homelab'] as const
export type Host = (typeof HOSTS)[number]

export interface LeaseHandoverInput {
  role: TickingRole
  to_thread_id: string
  from_thread_id: string
  /** lease_reclaim only: the host of the thread reclaiming. A thread other than the recorded primary succeeds when this is the primary_host. */
  host?: Host
}

export interface LeaseMoveInput {
  role: TickingRole
  to_thread_id: string
  /** The host the thread taking the lease runs on; recorded as the lease's primary_host. */
  host?: Host
  from_thread_id?: string
  old_schedule_task_deleted?: boolean
}

export interface LeaseReleaseInput {
  role: TickingRole
  from_thread_id: string
  old_schedule_task_deleted?: boolean
}

export interface Child {
  thread_id: string
  purpose: string
  issue: string | null
  started_at: string
  closed_at: string | null
  outcome: ChildOutcome | null
  note: string | null
}

export type DirectivesSource = 'owner' | 'import'

/** One version of the directives record, without the record itself: the history list. */
export interface DirectivesSummary {
  version: number
  set_at: string
  set_by: string | null
  source: DirectivesSource
  reason: string
}

export interface DirectivesEntry extends DirectivesSummary {
  record: Record<string, unknown>
}

export interface OwnerPresence {
  last_turn_at: string | null
  present: boolean
  stepped_away: boolean
}

export interface AwayNote {
  at: string
  text: string
  issue: string | null
}

export interface Outage {
  reason: string
  opened_at: string
  closed_at: string | null
}

/**
 * Event scopes. Both gates read `loop` events; only Aquila's gate reads `direction` events
 * (lease conflicts and Aquila's own ledger), so they never wake the AFK loop.
 */
type EventScope = 'loop' | 'direction'

/**
 * Schema versions, applied in order and tracked in `PRAGMA user_version`. Later tickets
 * (leases and the ledger, argus-config#667) append a version; never edit a shipped one.
 */
export const MIGRATIONS = [
  `
  CREATE TABLE slots (
    issue          TEXT PRIMARY KEY,
    thread_id      TEXT NOT NULL,
    state          TEXT NOT NULL CHECK (state IN ('running', 'parked', 'ready')),
    started_at     INTEGER NOT NULL,
    updated_at     INTEGER NOT NULL,
    note           TEXT,
    report_outcome TEXT CHECK (report_outcome IN ('complete', 'needs_owner', 'failed')),
    report_note    TEXT,
    report_pr      TEXT,
    reported_at    INTEGER
  );
  CREATE TABLE events (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    at        INTEGER NOT NULL,
    kind      TEXT NOT NULL,
    role      TEXT NOT NULL,
    issue     TEXT,
    thread_id TEXT,
    detail    TEXT
  );
  CREATE TABLE loop_status (
    role                TEXT PRIMARY KEY CHECK (role IN ('afk', 'direction')),
    thread_id           TEXT NOT NULL,
    last_tick_at        INTEGER NOT NULL,
    event_cursor        INTEGER NOT NULL,
    directives_version  TEXT NOT NULL,
    needs_owner         TEXT NOT NULL,
    slot_cap            INTEGER,
    errors              TEXT NOT NULL,
    pressure            TEXT NOT NULL,
    window_used_percent REAL
  );
  `,
  // argus-config#667: one lease per orchestrator role, and event scopes for Aquila-only events.
  `
  CREATE TABLE leases (
    role      TEXT PRIMARY KEY CHECK (role IN ('afk', 'direction')),
    thread_id TEXT NOT NULL,
    moved_at  INTEGER NOT NULL
  );
  ALTER TABLE events ADD COLUMN scope TEXT NOT NULL DEFAULT 'loop' CHECK (scope IN ('loop', 'direction'));
  `,
  // argus-config#667: Aquila's ledger. Only the direction role writes these tables.
  `
  CREATE TABLE ledger_children (
    thread_id  TEXT PRIMARY KEY,
    purpose    TEXT NOT NULL,
    issue      TEXT,
    started_at INTEGER NOT NULL,
    closed_at  INTEGER,
    outcome    TEXT CHECK (outcome IN ('done', 'failed', 'abandoned')),
    note       TEXT
  );
  CREATE TABLE ledger_owner (
    id           INTEGER PRIMARY KEY CHECK (id = 1),
    last_turn_at INTEGER NOT NULL,
    stepped_away INTEGER NOT NULL
  );
  CREATE TABLE ledger_away_notes (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    at           INTEGER NOT NULL,
    text         TEXT NOT NULL,
    issue        TEXT,
    presented_at INTEGER
  );
  CREATE TABLE ledger_notified (
    class       TEXT NOT NULL CHECK (class IN ('needs_owner', 'stall', 'window')),
    item        TEXT NOT NULL,
    notified_at INTEGER NOT NULL,
    PRIMARY KEY (class, item)
  );
  CREATE TABLE ledger_outages (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    reason    TEXT NOT NULL,
    opened_at INTEGER NOT NULL,
    closed_at INTEGER
  );
  `,
  // argus-config#770: homelab standbys. A lease remembers its primary so a failover can hand
  // it back, and a slot records which host's T3 runs its worker.
  `
  ALTER TABLE leases ADD COLUMN primary_thread_id TEXT;
  UPDATE leases SET primary_thread_id = thread_id;
  ALTER TABLE slots ADD COLUMN host TEXT NOT NULL DEFAULT 'wsl2' CHECK (host IN ('wsl2', 'homelab'));
  `,
  // argus#831: server-decided ticks. Every tick until now was the model's own.
  `
  ALTER TABLE loop_status ADD COLUMN last_model_tick_at INTEGER;
  ALTER TABLE loop_status ADD COLUMN last_recorded_by TEXT NOT NULL DEFAULT 'model' CHECK (last_recorded_by IN ('model', 'client'));
  UPDATE loop_status SET last_model_tick_at = last_tick_at;
  CREATE TABLE ticks (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    at          INTEGER NOT NULL,
    role        TEXT NOT NULL CHECK (role IN ('afk', 'direction')),
    thread_id   TEXT NOT NULL,
    recorded_by TEXT NOT NULL CHECK (recorded_by IN ('model', 'client'))
  );
  CREATE INDEX ticks_role_at ON ticks (role, at);
  CREATE TABLE wakes (
    role          TEXT NOT NULL CHECK (role IN ('afk', 'direction')),
    thread_id     TEXT NOT NULL,
    last_wake_at  INTEGER NOT NULL,
    last_reason   TEXT NOT NULL,
    pending_since INTEGER,
    PRIMARY KEY (role, thread_id)
  );
  `,
  // argus#836: how many tool approvals a slot's worker thread is waiting on, as the AFK tick last read them.
  `
  ALTER TABLE slots ADD COLUMN pending_approvals INTEGER NOT NULL DEFAULT 0 CHECK (pending_approvals >= 0);
  `,
  // argus#861: the weekly pace ladder. window_level keeps the 5-hour side, so the effective level can be recombined.
  `
  ALTER TABLE loop_status ADD COLUMN window_level TEXT;
  ALTER TABLE loop_status ADD COLUMN weekly_used_percent REAL;
  ALTER TABLE loop_status ADD COLUMN weekly_resets_at INTEGER;
  ALTER TABLE loop_status ADD COLUMN weekly_pace REAL;
  UPDATE loop_status SET window_level = pressure;
  `,
  // argus#871: the remaining-budget ladder. Readings keep each weekly figure a tick was given,
  // so the trailing 24h burn can be taken from them; loop_status keeps the ladder's state.
  `
  CREATE TABLE weekly_readings (
    at        INTEGER NOT NULL,
    used      REAL NOT NULL,
    resets_at INTEGER NOT NULL
  );
  CREATE INDEX weekly_readings_at ON weekly_readings (at);
  ALTER TABLE loop_status ADD COLUMN host_caps TEXT;
  ALTER TABLE loop_status ADD COLUMN reserve_percent REAL;
  ALTER TABLE loop_status ADD COLUMN budget_rung TEXT;
  ALTER TABLE loop_status ADD COLUMN budget_held INTEGER;
  ALTER TABLE loop_status ADD COLUMN burn_per_day REAL;
  ALTER TABLE loop_status ADD COLUMN allowance_per_day REAL;
  ALTER TABLE loop_status ADD COLUMN budget_ratio REAL;
  `,
  // argus#1012: trunk-trial repos whose slots skip the budget ladder's cut of the total cap.
  `
  ALTER TABLE loop_status ADD COLUMN budget_exempt_repos TEXT;
  `,
  // argus#1046: a lease remembers its primary's host, so a new thread on that host can reclaim it.
  `
  ALTER TABLE leases ADD COLUMN primary_host TEXT CHECK (primary_host IN ('wsl2', 'homelab'));
  `,
  // argus#1067: the AFK directives as an owner-set record. One row per version, never edited or deleted.
  `
  CREATE TABLE directives (
    version INTEGER PRIMARY KEY CHECK (version > 0),
    record  TEXT NOT NULL,
    set_at  INTEGER NOT NULL,
    set_by  TEXT,
    source  TEXT NOT NULL CHECK (source IN ('owner', 'import')),
    reason  TEXT NOT NULL
  );
  `,
  // argus#1171: a slot started for an efficiency:orchestrator issue sits outside the budget ladder and the slot caps.
  `
  ALTER TABLE slots ADD COLUMN budget_exempt INTEGER NOT NULL DEFAULT 0 CHECK (budget_exempt IN (0, 1));
  `,
  // argus#1118: promotions ops-hub has reported. One row per repo + to_sha makes the report idempotent; the `promoted` event wakes Aquila.
  `
  CREATE TABLE promotions (
    repo     TEXT NOT NULL,
    to_sha   TEXT NOT NULL,
    from_sha TEXT,
    at       TEXT NOT NULL,
    source   TEXT NOT NULL CHECK (source IN ('approve', 'webhook')),
    PRIMARY KEY (repo, to_sha)
  );
  `,
  // argus-config#1169: the awaiting_ci slot state. A CHECK cannot be altered, so the table is rebuilt
  // with the wider list and a ci_ref column for the PR URL or SHA the slot waits on.
  `
  CREATE TABLE slots_v2 (
    issue             TEXT PRIMARY KEY,
    thread_id         TEXT NOT NULL,
    state             TEXT NOT NULL CHECK (state IN ('running', 'parked', 'ready', 'awaiting_ci')),
    started_at        INTEGER NOT NULL,
    updated_at        INTEGER NOT NULL,
    note              TEXT,
    report_outcome    TEXT CHECK (report_outcome IN ('complete', 'needs_owner', 'failed')),
    report_note       TEXT,
    report_pr         TEXT,
    reported_at       INTEGER,
    host              TEXT NOT NULL DEFAULT 'wsl2' CHECK (host IN ('wsl2', 'homelab')),
    pending_approvals INTEGER NOT NULL DEFAULT 0 CHECK (pending_approvals >= 0),
    budget_exempt     INTEGER NOT NULL DEFAULT 0 CHECK (budget_exempt IN (0, 1)),
    ci_ref            TEXT
  );
  INSERT INTO slots_v2 (issue, thread_id, state, started_at, updated_at, note, report_outcome, report_note, report_pr, reported_at, host, pending_approvals, budget_exempt)
    SELECT issue, thread_id, state, started_at, updated_at, note, report_outcome, report_note, report_pr, reported_at, host, pending_approvals, budget_exempt FROM slots;
  DROP TABLE slots;
  ALTER TABLE slots_v2 RENAME TO slots;
  `,
  // argus#50: the last time a lease's holder was seen working (an owner turn, a directives write, a child or a slot
  // write), so an owner-busy holder whose tick prompts queue behind the conversation is not read as stalled.
  `
  CREATE TABLE holder_activity (
    role      TEXT PRIMARY KEY CHECK (role IN ('afk', 'direction')),
    thread_id TEXT NOT NULL,
    at        INTEGER NOT NULL
  );
  `,
  // argus#54: the owner chat registered per host for the split tick thread. It lives beside the leases, not in
  // them, so lease_move, lease_release, lease_failover and lease_reclaim (which rewrite or delete a lease row)
  // leave it alone.
  `
  CREATE TABLE owner_threads (
    host      TEXT PRIMARY KEY CHECK (host IN ('wsl2', 'homelab')),
    thread_id TEXT NOT NULL,
    set_at    INTEGER NOT NULL
  );
  `,
]

const GREEN_NOTE_PATTERN = /^\s*checks green\b/i
/**
 * What an awaiting_ci slot waits on: a PR URL, the SHA of a push to the issue's own trunk repo's main,
 * or owner/repo@<40-hex SHA> for a push to another repo (argus#55: a multi-repo worker names the repo,
 * since a bare SHA means nothing outside the issue's repo). ci_ref is stored and shown as given.
 */
const CI_REF_PATTERN =
  /^(https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/[1-9]\d*|[0-9a-f]{7,40}|[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+@[0-9a-f]{40})$/
const REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/
const ISSUE_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+#[1-9]\d*$/

type Row = Record<string, SQLInputValue>

const iso = (ms: number) => new Date(ms).toISOString()
const optionalText = (value: SQLInputValue | undefined) => (value === null || value === undefined ? null : String(value))

export function pressureFor(percent: number): PressureLevel {
  if (percent >= 95) return 'gate_only'
  if (percent >= 85) return 'no_new_slots'
  if (percent >= 70) return 'no_opus'
  return 'normal'
}

const DAY_MS = 24 * 60 * 60_000
const WEEK_MS = 7 * DAY_MS
const FIRST_HOUR_MS = 60 * 60_000
/** Readings older than a week and a day can never be a baseline, so they are dropped as new ones arrive. */
const READING_KEEP_MS = WEEK_MS + DAY_MS

/** The share of the week held back (#871): the loop plans as if the week ends at 100 - reserve % used. */
const DEFAULT_RESERVE_PERCENT = 10

/**
 * The budget ladder's edges (argus#62, owner 22 Nov 2026): weekly pace (used ÷ elapsed share of the week) above each
 * steps the level up. A rung releases below its edge - HYSTERESIS. Before argus#62 the trigger was #871's
 * trailing-24h burn ÷ allowance, which let one busy day gate the rest of the week.
 */
const BUDGET_EDGES = [
  { rung: 'no_opus', over: 1.1 },
  { rung: 'no_new_slots', over: 1.25 },
  { rung: 'gate_only', over: 1.5 },
] as const
const HYSTERESIS = 0.05
/** How much of the week must be gone before pace sets a rung (argus#62); before it only the spent allowance gates. */
const PACE_READABLE_AFTER_MS = DAY_MS

/** What the ladder's rung is: `normal` or a pressure level that limits starts. */
export type BudgetRung = 'normal' | (typeof BUDGET_EDGES)[number]['rung']

const rungIndex = (rung: BudgetRung) => PRESSURE_LEVELS.indexOf(rung)
const isBudgetRung = (value: unknown): value is BudgetRung => value === 'normal' || BUDGET_EDGES.some((edge) => edge.rung === value)

export interface Weekly {
  used: number
  resetsAt: number
  /** Used ÷ elapsed share of the week; null in the first hour of the week. It drives the rung (argus#62). */
  pace: number | null
  /** Trailing-24h rise in % used, per day. Null while no reading is at least 24h old. Information only since argus#62. */
  burnPerDay: number | null
  /** What the rest of the week allows per day, keeping the reserve back; 0 when none is left. Null once the week is over. */
  allowancePerDay: number | null
  /** burn ÷ allowance; null when either is unknown or the allowance is spent. Information only since argus#62. */
  ratio: number | null
  rung: BudgetRung
  /** The rung is held by hysteresis: the pace alone would give a lower one. */
  held: boolean
  reservePercent: number
}

/** A tick's resolved pressure: the effective level, and the window and weekly sides it was built from. */
interface Pressure {
  level: PressureLevel
  windowLevel: PressureLevel
  percent: number | null
  weekly: Weekly | null
}

export function weeklyPace(used: number, resetsAt: number, at: number): number | null {
  const elapsedMs = Math.min(WEEK_MS, at - (resetsAt - WEEK_MS))
  if (elapsedMs < FIRST_HOUR_MS) return null
  return used / ((elapsedMs / WEEK_MS) * 100)
}

/** The rung a weekly pace gives, given the rung held before it. Engages above an edge, releases below the edge - HYSTERESIS. */
export function budgetRungFor(pace: number | null, prior: BudgetRung): { rung: BudgetRung; held: boolean } {
  if (pace === null) return { rung: 'normal', held: false }
  let rung: BudgetRung = 'normal'
  let alone: BudgetRung = 'normal'
  for (const edge of BUDGET_EDGES) {
    if (pace > edge.over) alone = edge.rung
    if (pace > edge.over || (rungIndex(prior) >= rungIndex(edge.rung) && pace >= edge.over - HYSTERESIS)) rung = edge.rung
  }
  return { rung, held: rung !== alone }
}

/** The stricter of the window and weekly levels. A weekly `normal` adds no limit, so it never turns an unknown window into `normal`. */
function stricter(windowLevel: PressureLevel, weeklyLevel: PressureLevel): PressureLevel {
  if (weeklyLevel === 'normal') return windowLevel
  return PRESSURE_LEVELS.indexOf(weeklyLevel) > PRESSURE_LEVELS.indexOf(windowLevel) ? weeklyLevel : windowLevel
}

/**
 * The directives total cap under the budget ladder (argus#62): unchanged at `normal` and `no_opus` (Sonnet or Haiku
 * workers only), 0 from `no_new_slots` up, where the level already refuses new starts.
 */
export function effectiveSlotCap(slotCap: number | null, weekly: Weekly | null): number | null {
  if (weekly === null || weekly.rung === 'normal' || weekly.rung === 'no_opus') return slotCap
  return 0
}

/** Per-host caps from the directives. A host left out has no cap of its own. */
export type HostCaps = Partial<Record<Host, number>>

function requireIssue(issue: string): string {
  if (!ISSUE_PATTERN.test(issue)) throw new Refused(`issue must be owner/repo#number, got "${issue}"`)
  return issue
}

function requireText(value: string, field: string): string {
  if (!value.trim()) throw new Refused(`${field} must not be blank`)
  return value
}

const normaliseQueue = (issues: string[]) => [...new Set(issues.map(requireIssue))].sort()

function requireApprovalCounts(counts: Record<string, number>): [string, number][] {
  return Object.entries(counts).map(([issue, count]) => {
    if (!Number.isInteger(count) || count < 0) throw new Refused(`pending_approvals for ${issue} must be a whole number, 0 or more`)
    return [requireIssue(issue), count]
  })
}

function toSlot(row: Row): Slot {
  const outcome = optionalText(row.report_outcome) as ReportOutcome | null
  return {
    issue: String(row.issue),
    thread_id: String(row.thread_id),
    state: row.state as SlotState,
    host: String(row.host) as Host,
    started_at: iso(Number(row.started_at)),
    updated_at: iso(Number(row.updated_at)),
    note: optionalText(row.note),
    pending_approvals: Number(row.pending_approvals),
    budget_exempt: Number(row.budget_exempt) === 1,
    ci_ref: optionalText(row.ci_ref),
    report: outcome
      ? { outcome, note: optionalText(row.report_note), pr: optionalText(row.report_pr), at: iso(Number(row.reported_at)) }
      : null,
  }
}

function toChild(row: Row): Child {
  return {
    thread_id: String(row.thread_id),
    purpose: String(row.purpose),
    issue: optionalText(row.issue),
    started_at: iso(Number(row.started_at)),
    closed_at: row.closed_at === null ? null : iso(Number(row.closed_at)),
    outcome: optionalText(row.outcome) as ChildOutcome | null,
    note: optionalText(row.note),
  }
}

const toAwayNote = (row: Row): AwayNote => ({ at: iso(Number(row.at)), text: String(row.text), issue: optionalText(row.issue) })

const toOutage = (row: Row): Outage => ({
  reason: String(row.reason),
  opened_at: iso(Number(row.opened_at)),
  closed_at: row.closed_at === null ? null : iso(Number(row.closed_at)),
})

function toChange(row: Row): Change {
  const change: Change = { kind: String(row.kind), issue: optionalText(row.issue), role: row.role as Role, at: iso(Number(row.at)) }
  if (change.kind !== 'promoted') return change
  const detail = JSON.parse(String(row.detail)) as Pick<PromotedInput, 'repo' | 'from_sha' | 'to_sha' | 'source'>
  return { ...change, repo: detail.repo, from_sha: detail.from_sha, to_sha: detail.to_sha, source: detail.source }
}

export type Store = ReturnType<typeof openStore>

export function openStore(options: StoreOptions) {
  const now = options.now ?? Date.now
  const cadenceMs = options.cadenceMs ?? DEFAULT_CADENCE_MS
  const graceMs = options.graceMs ?? DEFAULT_GRACE_MS
  const pressureDwellMs = options.pressureDwellMs ?? DEFAULT_PRESSURE_DWELL_MS
  /** POST /wake/check: the new pressure level each (role, thread) has been seen at since when. In memory: a restart only restarts the dwell. */
  const pressureFlips = new Map<string, { level: PressureLevel; since: number }>()
  /** argus#51: the (role, thread) pairs already logged for sending no thread header. In memory: a restart logs them once more. */
  const headerMissingSeen = new Set<string>()
  const warn = options.warn ?? ((message: string) => console.warn(message))

  const db = new DatabaseSync(options.path)
  // busy_timeout first: switching to WAL takes a lock, and a connection opening while
  // another holds it must wait rather than fail with "database is locked".
  db.exec('PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;')
  migrate(db)

  /** An IMMEDIATE transaction: a second connection waits on the write lock instead of reading a row about to change. */
  function write<T>(work: () => T): T {
    db.exec('BEGIN IMMEDIATE')
    try {
      const result = work()
      db.exec('COMMIT')
      return result
    } catch (error) {
      if (error instanceof LeaseRefused) {
        db.exec('COMMIT')
      } else {
        db.exec('ROLLBACK')
      }
      throw error
    }
  }

  function permit(role: Role, tool: ToolName) {
    const allowed: readonly Role[] = TOOL_ROLES[tool]
    if (!allowed.includes(role)) throw new Refused(`role ${role} may not call ${tool} (allowed: ${allowed.join(', ')})`)
  }

  const insertEvent = db.prepare('INSERT INTO events (at, kind, role, issue, thread_id, detail, scope) VALUES (?, ?, ?, ?, ?, ?, ?)')
  const record = (
    kind: string,
    role: Role,
    issue: string | null,
    threadId: string | null,
    detail: Record<string, unknown> = {},
    scope: EventScope = 'loop',
  ) => insertEvent.run(now(), kind, role, issue, threadId, JSON.stringify(detail), scope)

  const selectSlot = db.prepare('SELECT * FROM slots WHERE issue = ?')
  const selectSlots = db.prepare('SELECT * FROM slots ORDER BY started_at, issue')
  const deleteSlot = db.prepare('DELETE FROM slots WHERE issue = ?')
  const selectStatus = db.prepare('SELECT * FROM loop_status WHERE role = ?')
  const selectEventsAfter = db.prepare('SELECT * FROM events WHERE id > ? ORDER BY id')
  const selectLoopEventsAfter = db.prepare("SELECT * FROM events WHERE id > ? AND scope = 'loop' ORDER BY id")
  const insertPromotion = db.prepare('INSERT OR IGNORE INTO promotions (repo, to_sha, from_sha, at, source) VALUES (?, ?, ?, ?, ?)')
  // argus#1189: wake requests. Pending = after the direction tick's event cursor, the same cursor `promoted` rides.
  const selectWakeRequestsAfter = db.prepare("SELECT issue FROM events WHERE id > ? AND kind = 'wake_requested' ORDER BY id")
  const selectWakeRequestPending = db.prepare(
    "SELECT 1 FROM events WHERE kind = 'wake_requested' AND issue = ? AND id > COALESCE((SELECT event_cursor FROM loop_status WHERE role = 'direction'), 0) LIMIT 1",
  )
  const selectWakeRequestLast = db.prepare("SELECT MAX(at) AS at FROM events WHERE kind = 'wake_requested' AND issue = ?")
  const selectWakeRequestsSince = db.prepare("SELECT at FROM events WHERE kind = 'wake_requested' AND at > ? ORDER BY at")
  const selectLease = db.prepare('SELECT * FROM leases WHERE role = ?')
  const selectActivity = db.prepare('SELECT * FROM holder_activity WHERE role = ?')
  const upsertActivity = db.prepare(`
    INSERT INTO holder_activity (role, thread_id, at) VALUES (?, ?, ?)
    ON CONFLICT (role) DO UPDATE SET thread_id = excluded.thread_id, at = excluded.at`)
  const upsertLease = db.prepare(`
    INSERT INTO leases (role, thread_id, moved_at, primary_thread_id, primary_host) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (role) DO UPDATE SET thread_id = excluded.thread_id, moved_at = excluded.moved_at,
                                     primary_thread_id = excluded.primary_thread_id, primary_host = excluded.primary_host`)
  const deleteLease = db.prepare('DELETE FROM leases WHERE role = ?')
  const selectOwnerThreads = db.prepare('SELECT host, thread_id FROM owner_threads')
  const selectOwnerThreadByHost = db.prepare('SELECT thread_id FROM owner_threads WHERE host = ?')
  const selectOwnerThreadById = db.prepare('SELECT 1 FROM owner_threads WHERE thread_id = ? LIMIT 1')
  const upsertOwnerThread = db.prepare(`
    INSERT INTO owner_threads (host, thread_id, set_at) VALUES (?, ?, ?)
    ON CONFLICT (host) DO UPDATE SET thread_id = excluded.thread_id, set_at = excluded.set_at`)
  const selectLastEvent = db.prepare('SELECT COALESCE(MAX(id), 0) AS id FROM events')
  const countSlots = db.prepare('SELECT state, COUNT(*) AS n FROM slots GROUP BY state')

  function slotOrRefuse(issue: string): Row {
    const row = selectSlot.get(requireIssue(issue)) as Row | undefined
    if (!row) throw new Refused(`no slot for ${issue}`)
    return row
  }

  function requireState(row: Row, wanted: SlotState, action: string) {
    if (row.state !== wanted) throw new Refused(`cannot ${action} ${String(row.issue)}: it is ${String(row.state)}, not ${wanted}`)
  }

  function parseWeekly(input: TickInput): { used: number; resetsAt: number } | null {
    const { weekly_used_percent: used, weekly_resets_at: resets } = input
    if (used === undefined && resets === undefined) return null
    if (used === undefined || resets === undefined) throw new Refused('weekly_used_percent and weekly_resets_at must be given together')
    if (!Number.isFinite(used) || used < 0 || used > 100) throw new Refused('weekly_used_percent must be between 0 and 100')
    const resetsAt = Date.parse(resets)
    if (!Number.isFinite(resetsAt)) throw new Refused(`weekly_resets_at must be an ISO 8601 time, got "${resets}"`)
    return { used, resetsAt }
  }

  const insertReading = db.prepare('INSERT INTO weekly_readings (at, used, resets_at) VALUES (?, ?, ?)')
  const pruneReadings = db.prepare('DELETE FROM weekly_readings WHERE at < ?')
  const selectBaseline = db.prepare('SELECT at, used FROM weekly_readings WHERE at >= ? AND at <= ? ORDER BY at DESC LIMIT 1')

  /**
   * The rung, from the weekly pace (argus#62), and the burn and allowance shown beside it. The burn
   * (% of the week used per day) is the rise since the latest reading at least 24h old, per day of
   * the span between them; with no such reading there is no burn and no ratio (argus#1091). Burn,
   * allowance and ratio are information only. The allowance spent (100 - reserve used) still
   * gates whatever the pace.
   */
  function budgetOf(used: number, resetsAt: number, at: number, reservePercent: number, pace: number | null, prior: BudgetRung): Omit<Weekly, 'used' | 'resetsAt' | 'pace' | 'reservePercent'> {
    const daysLeft = (resetsAt - at) / DAY_MS
    const weekStart = resetsAt - WEEK_MS
    const allowancePerDay = daysLeft > 0 ? Math.max(0, (100 - used - reservePercent) / daysLeft) : null
    let burnPerDay: number | null = null
    if (daysLeft > 0) {
      const baseline = selectBaseline.get(weekStart, at - DAY_MS) as Row | undefined
      if (baseline) burnPerDay = Math.max(0, used - Number(baseline.used)) / ((at - Number(baseline.at)) / DAY_MS)
    }
    const ratio = burnPerDay === null || allowancePerDay === null || allowancePerDay <= 0 ? null : burnPerDay / allowancePerDay
    const { rung, held } = budgetRungFor(pace, prior)
    const spent = allowancePerDay === 0
    return { burnPerDay, allowancePerDay, ratio, rung: spent ? 'gate_only' : rung, held: spent ? false : held }
  }

  const deriveWeekly = (weekly: { used: number; resetsAt: number }, reservePercent: number, prior: BudgetRung): Weekly => {
    const at = now()
    const pace = weeklyPace(weekly.used, weekly.resetsAt, at)
    // argus#62: a few points in the first day swing pace far past every edge, so pace drives no rung until a day is gone.
    const rungPace = at - (weekly.resetsAt - WEEK_MS) >= PACE_READABLE_AFTER_MS ? pace : null
    return { ...weekly, pace, reservePercent, ...budgetOf(weekly.used, weekly.resetsAt, at, reservePercent, rungPace, prior) }
  }

  /**
   * argus#60 (argus-config#1573): the owner's time-boxed `ignore_weekly_budget` override. While it is live the
   * weekly ladder adds nothing, whatever a tick sends or an earlier tick stored, so every reader of a row's weekly
   * figures (`weeklyOf`, `pressureOf`) sees none. Read from the current directives record, as `awaitingCiCap` is.
   */
  function weeklyBudgetIgnored(): boolean {
    const row = selectCurrentDirectives.get() as Row | undefined
    return row !== undefined && ignoreWeeklyBudgetLive(JSON.parse(String(row.record)), now())
  }

  /**
   * argus#60: the directives' `budget_exempt_issues` as written. Read from the current record, as
   * `awaitingCiCap` is, so a start needs no client flag.
   */
  function exemptIssuesOfDirectives(): string[] {
    const row = selectCurrentDirectives.get() as Row | undefined
    return row === undefined ? [] : budgetExemptIssues(JSON.parse(String(row.record)))
  }

  /** The same, lower-cased for comparing: GitHub names are case-insensitive. */
  const listedExemptIssues = () => exemptIssuesOfDirectives().map((issue) => issue.toLowerCase())

  const weeklyOf = (row: Row): Weekly | null =>
    row.weekly_used_percent === null || row.weekly_used_percent === undefined || weeklyBudgetIgnored()
      ? null
      : {
          used: Number(row.weekly_used_percent),
          resetsAt: Number(row.weekly_resets_at),
          pace: row.weekly_pace === null ? null : Number(row.weekly_pace),
          burnPerDay: row.burn_per_day === null || row.burn_per_day === undefined ? null : Number(row.burn_per_day),
          allowancePerDay: row.allowance_per_day === null || row.allowance_per_day === undefined ? null : Number(row.allowance_per_day),
          ratio: row.budget_ratio === null || row.budget_ratio === undefined ? null : Number(row.budget_ratio),
          rung: isBudgetRung(row.budget_rung) ? row.budget_rung : 'normal',
          held: Number(row.budget_held ?? 0) === 1,
          reservePercent: row.reserve_percent === null || row.reserve_percent === undefined ? DEFAULT_RESERVE_PERCENT : Number(row.reserve_percent),
        }

  /** The rung a row last held, unless its week is over: a new week starts with no rung to hold. */
  const heldRungOf = (row: Row | undefined): BudgetRung => {
    const weekly = row ? weeklyOf(row) : null
    return weekly !== null && weekly.resetsAt > now() ? weekly.rung : 'normal'
  }

  function requireReserve(percent: number | undefined): number | undefined {
    if (percent === undefined) return undefined
    if (!Number.isFinite(percent) || percent < 0 || percent >= 100) throw new Refused('reserve_percent must be 0 or more and under 100')
    return percent
  }

  /** What a tick last recorded, read back from its loop_status row. */
  const pressureOf = (row: Row): Pressure => ({
    // The stored level is the stricter of the window and weekly sides: while the weekly side is ignored, only the window's counts.
    level: (weeklyBudgetIgnored() ? (row.window_level ?? row.pressure) : row.pressure) as PressureLevel,
    windowLevel: (row.window_level ?? row.pressure) as PressureLevel,
    percent: row.window_used_percent === null ? null : Number(row.window_used_percent),
    weekly: weeklyOf(row),
  })

  /**
   * The effective pressure of a tick: the stricter of the window ladder and the budget ladder.
   * With `previous` (tick_gate, wake/check), what the caller leaves out carries forward; the
   * budget is recomputed against now, and a week that has reset since drops out. Without it
   * (status_tick) what is left out is unknown. `held` is the row whose rung hysteresis holds:
   * the previous tick's. Null when there is nothing to compare.
   */
  function resolvePressure(input: TickInput, previous?: Row, held: Row | undefined = previous): Pressure | null {
    const percent = input.window_used_percent
    let window: { level: PressureLevel; percent: number | null } | null = null
    if (percent !== undefined) {
      if (!Number.isFinite(percent) || percent < 0 || percent > 100) throw new Refused('window_used_percent must be between 0 and 100')
      const derived = pressureFor(percent)
      if (input.pressure && input.pressure !== derived) {
        throw new Refused(`pressure ${input.pressure} contradicts ${percent}% used, which is ${derived}`)
      }
      window = { level: derived, percent }
    } else if (input.pressure) {
      window = { level: input.pressure, percent: null }
    }

    // Still validated, so a malformed figure is refused as ever; while the override is live it is then dropped.
    const sent = parseWeekly(input)
    const given = weeklyBudgetIgnored() ? null : sent
    const reserve = requireReserve(input.reserve_percent)
    const carried = previous ? weeklyOf(previous) : null
    const carriedLive = carried !== null && carried.resetsAt > now() ? carried : null
    if (!window && !given && !carried) return null

    const resolvedWindow = window ?? (previous ? { level: pressureOf(previous).windowLevel, percent: pressureOf(previous).percent } : { level: 'unknown' as const, percent: null })
    const prior = heldRungOf(held)
    const weekly = given
      ? deriveWeekly(given, reserve ?? DEFAULT_RESERVE_PERCENT, prior)
      : carriedLive
        ? deriveWeekly(carriedLive, reserve ?? carriedLive.reservePercent, prior)
        : null
    return {
      level: weekly ? stricter(resolvedWindow.level, weekly.rung) : resolvedWindow.level,
      windowLevel: resolvedWindow.level,
      percent: resolvedWindow.percent,
      weekly,
    }
  }

  const upsertStatus = db.prepare(`
    INSERT INTO loop_status (role, thread_id, last_tick_at, event_cursor, directives_version, needs_owner,
                             slot_cap, errors, pressure, window_used_percent,
                             window_level, weekly_used_percent, weekly_resets_at, weekly_pace,
                             host_caps, reserve_percent, budget_rung, budget_held, burn_per_day, allowance_per_day, budget_ratio,
                             budget_exempt_repos)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (role) DO UPDATE SET
      thread_id = excluded.thread_id, last_tick_at = excluded.last_tick_at, event_cursor = excluded.event_cursor,
      directives_version = excluded.directives_version, needs_owner = excluded.needs_owner,
      slot_cap = excluded.slot_cap, errors = excluded.errors, pressure = excluded.pressure,
      window_used_percent = excluded.window_used_percent, window_level = excluded.window_level,
      weekly_used_percent = excluded.weekly_used_percent, weekly_resets_at = excluded.weekly_resets_at,
      weekly_pace = excluded.weekly_pace, host_caps = excluded.host_caps, reserve_percent = excluded.reserve_percent,
      budget_rung = excluded.budget_rung, budget_held = excluded.budget_held, burn_per_day = excluded.burn_per_day,
      allowance_per_day = excluded.allowance_per_day, budget_ratio = excluded.budget_ratio,
      budget_exempt_repos = excluded.budget_exempt_repos`)

  interface TickValues {
    slotCap: number | null
    hostCaps: HostCaps | null
    exemptRepos: string[] | null
    errors: string[]
    pressure: Pressure
  }

  const markTick = db.prepare(`
    UPDATE loop_status SET last_recorded_by = ?,
           last_model_tick_at = CASE WHEN ? = 'model' THEN last_tick_at ELSE last_model_tick_at END
     WHERE role = ?`)
  const insertTick = db.prepare('INSERT INTO ticks (at, role, thread_id, recorded_by) VALUES (?, ?, ?, ?)')

  function writeTick(role: TickingRole, input: TickInput, values: TickValues, recordedBy: TickRecorder = 'model') {
    const cursor = Number((selectLastEvent.get() as Row).id)
    upsertStatus.run(
      role,
      requireText(input.thread_id, 'thread_id'),
      now(),
      cursor,
      requireText(input.directives_version, 'directives_version'),
      JSON.stringify(normaliseQueue(input.needs_owner)),
      values.slotCap,
      JSON.stringify(values.errors),
      values.pressure.level,
      values.pressure.percent,
      values.pressure.windowLevel,
      values.pressure.weekly?.used ?? null,
      values.pressure.weekly?.resetsAt ?? null,
      values.pressure.weekly?.pace ?? null,
      values.hostCaps === null ? null : JSON.stringify(values.hostCaps),
      values.pressure.weekly?.reservePercent ?? null,
      values.pressure.weekly?.rung ?? null,
      values.pressure.weekly ? (values.pressure.weekly.held ? 1 : 0) : null,
      values.pressure.weekly?.burnPerDay ?? null,
      values.pressure.weekly?.allowancePerDay ?? null,
      values.pressure.weekly?.ratio ?? null,
      values.exemptRepos === null ? null : JSON.stringify(values.exemptRepos),
    )
    // Only a figure the caller gave is a reading; one carried forward is not new information.
    if (input.weekly_used_percent !== undefined && input.weekly_resets_at !== undefined) {
      insertReading.run(now(), input.weekly_used_percent, Date.parse(input.weekly_resets_at))
      pruneReadings.run(now() - READING_KEEP_MS)
    }
    markTick.run(recordedBy, recordedBy, role)
    insertTick.run(now(), role, input.thread_id, recordedBy)
  }

  function requireSlotCap(cap: number | undefined): number | null {
    if (cap === undefined) return null
    if (!Number.isInteger(cap) || cap < 0) throw new Refused('slot_cap must be a whole number, 0 or more')
    return cap
  }

  /** The total cap a tick passed: `total_cap`, or `slot_cap` from a caller that has not moved to the new name. */
  const totalCapOf = (input: TickInput) => requireSlotCap(input.total_cap ?? input.slot_cap)

  function requireHostCaps(caps: HostCaps | undefined): HostCaps | null {
    if (caps === undefined) return null
    const out: HostCaps = {}
    for (const [host, cap] of Object.entries(caps)) {
      requireHost(host)
      if (cap === undefined) continue
      if (!Number.isInteger(cap) || cap < 0) throw new Refused(`host_caps.${host} must be a whole number, 0 or more`)
      out[host] = cap
    }
    return out
  }

  const hostCapsOf = (row: Row | undefined): HostCaps | null =>
    row?.host_caps === null || row?.host_caps === undefined ? null : (JSON.parse(String(row.host_caps)) as HostCaps)

  function requireExemptRepos(repos: string[] | undefined): string[] | null {
    if (repos === undefined) return null
    for (const repo of repos) {
      if (!REPO_PATTERN.test(repo)) throw new Refused(`budget_exempt_repos must each be owner/repo, got "${repo}"`)
    }
    return [...new Set(repos)].sort()
  }

  const exemptReposOf = (row: Row | undefined): string[] =>
    row?.budget_exempt_repos === null || row?.budget_exempt_repos === undefined ? [] : (JSON.parse(String(row.budget_exempt_repos)) as string[])

  function asTicking(role: Role, tool: ToolName): TickingRole {
    permit(role, tool)
    return role as TickingRole
  }

  function requireTickingRole(value: string): TickingRole {
    if (value !== 'afk' && value !== 'direction') throw new Refused(`a lease belongs to afk or direction, not "${value}"`)
    return value
  }

  const holderOf = (role: TickingRole) => optionalText((selectLease.get(role) as Row | undefined)?.thread_id)

  /**
   * A tick counts only from the thread holding its role's lease. A stray tick (a retired
   * thread whose last tick was in flight, or a successor booting early) records nothing but
   * a lease conflict, which only Aquila's gate reads. Runs inside the caller's transaction.
   */
  function checkLease(role: TickingRole, threadId: string): LeaseCheck {
    const holder = holderOf(role)
    if (holder === threadId) return { holds_lease: true, lease_holder: holder }
    record('lease_conflict', role, null, threadId, { role, holder }, 'direction')
    return { holds_lease: false, lease_holder: holder }
  }

  const selectWake = db.prepare('SELECT * FROM wakes WHERE role = ? AND thread_id = ?')
  const upsertWake = db.prepare(`
    INSERT INTO wakes (role, thread_id, last_wake_at, last_reason, pending_since) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (role, thread_id) DO UPDATE SET last_wake_at = excluded.last_wake_at, last_reason = excluded.last_reason,
                                                pending_since = COALESCE(wakes.pending_since, excluded.pending_since)`)
  const clearWake = db.prepare('UPDATE wakes SET pending_since = NULL WHERE role = ? AND thread_id = ?')
  const countTicks = db.prepare('SELECT recorded_by, COUNT(*) AS n FROM ticks WHERE role = ? AND at >= ? GROUP BY recorded_by')
  const setApprovals = db.prepare("UPDATE slots SET pending_approvals = ? WHERE issue = ? AND state = 'running'")
  const selectApprovals = db.prepare("SELECT issue, pending_approvals FROM slots WHERE state = 'running' AND pending_approvals > 0 ORDER BY issue")
  const selectRunningHostIssues = db.prepare("SELECT issue FROM slots WHERE host = ? AND state = 'running'")

  /** A model tick call (tick_gate or status_tick) answers any wake sent to that thread, lease or not. */
  const acknowledgeWake = (role: TickingRole, threadId: string) => clearWake.run(role, threadId)

  /** A wake to this thread that no model tick answered within WAKE_ACK_MS: the thread is stalled. */
  function wakeUnanswered(role: TickingRole, threadId: string): boolean {
    const row = selectWake.get(role, threadId) as Row | undefined
    return row?.pending_since != null && now() - Number(row.pending_since) >= WAKE_ACK_MS
  }

  const missedSince = (lastSeen: number) => Math.max(0, Math.floor((now() - lastSeen - graceMs) / cadenceMs))

  /**
   * argus#50: record that a role's lease holder just did owner-driven work. Its tick prompts queue behind the owner's
   * conversation, so a long turn leaves no tick for over an hour; the work itself shows it is alive. Called only
   * after the write passed its lease check, so a stray thread's write never lands here.
   */
  function touchHolder(of: TickingRole, threadId: string | null) {
    if (threadId !== null) upsertActivity.run(of, threadId, now())
  }

  /** When the lease's holder last did work, or null: only activity of the thread holding the lease now counts. */
  function holderActivityAt(of: TickingRole, threadId: string): number | null {
    const row = selectActivity.get(of) as Row | undefined
    return row && String(row.thread_id) === threadId ? Number(row.at) : null
  }

  /**
   * When a lease's holder was last seen: its last tick or work, or when it took the lease if it never ticked.
   * Work counts as seen (argus#50), a tick from a thread that is not the holder never does.
   */
  function holderSeen(of: TickingRole, lease: Row): number {
    const status = selectStatus.get(of) as Row | undefined
    const threadId = String(lease.thread_id)
    const tickAt = status && String(status.thread_id) === threadId ? Number(status.last_tick_at) : Number(lease.moved_at)
    return Math.max(tickAt, holderActivityAt(of, threadId) ?? 0)
  }

  /** Missed ticks of a lease's holder, counted from when it was last seen. */
  function holderMissed(of: TickingRole, lease: Row): { missed: number; lastSeen: number } {
    const lastSeen = holderSeen(of, lease)
    return { missed: missedSince(lastSeen), lastSeen }
  }

  /** Failover needs 2+ missed ticks (about an hour); an unanswered wake alone is only late (argus#1038). */
  const holderStalled = (of: TickingRole, lease: Row) => holderMissed(of, lease).missed >= 2
  /**
   * A running homelab slot the lease holder's last tick says it could not drain: an `errors` entry that starts with
   * `drain-left:` (any case) and names the slot's issue, e.g. `drain-left: deanjstone/argus#9 homelab not reachable`
   * (the charter's hand-off to the standby's drain). Nothing looser counts: a routine line that merely mentions
   * homelab or a homelab URL must not wake the standby for an empty turn (argus#57). False with no running homelab
   * slot, or when the tick is not the holder's.
   */
  const holderLeftHomelabSlots = (of: TickingRole, lease: Row): boolean => {
    const issues = (selectRunningHostIssues.all('homelab') as Row[]).map((row) => String(row.issue).toLowerCase())
    if (issues.length === 0) return false
    const status = selectStatus.get(of) as Row | undefined
    if (!status || String(status.thread_id) !== String(lease.thread_id)) return false
    const handOffs = (JSON.parse(String(status.errors)) as string[])
      .map((error) => error.trim().toLowerCase())
      .filter((error) => error.startsWith(DRAIN_LEFT_MARKER))
      .map((error) => error.slice(DRAIN_LEFT_MARKER.length))
    return handOffs.some((handOff) => issues.some((issue) => namesIssue(handOff, issue)))
  }

  /** The status row's last tick, or the holder's later work (argus#50): what liveness counts missed ticks from. */
  function lastSeenOf(of: TickingRole, row: Row): number {
    const lease = selectLease.get(of) as Row | undefined
    return lease ? Math.max(Number(row.last_tick_at), holderActivityAt(of, String(lease.thread_id)) ?? 0) : Number(row.last_tick_at)
  }

  /**
   * The liveness state status_read reports: 2+ missed ticks is stalled, 1 is late, and a wake
   * unanswered past its ack window keeps an otherwise alive thread late. The unanswered wake
   * stops client quiet ticks being recorded, so a dead thread still reaches 2 missed ticks.
   */
  function livenessState(of: TickingRole): 'never' | 'alive' | 'late' | 'stalled' {
    const row = selectStatus.get(of) as Row | undefined
    if (!row) return 'never'
    const threadId = holderOf(of) ?? String(row.thread_id)
    const missed = missedSince(lastSeenOf(of, row))
    if (missed >= 2) return 'stalled'
    return missed === 1 || wakeUnanswered(of, threadId) ? 'late' : 'alive'
  }

  /**
   * What tick_gate compares: the directives version, the needs:owner set, the pressure level
   * when given, and every event in the role's scope since its last recorded tick.
   */
  function compareTick(ticking: TickingRole, previous: Row, input: TickInput, queue: string, pressure: Pressure | null) {
    const reasons: string[] = []
    if (previous.directives_version !== input.directives_version) reasons.push('directives')
    if (previous.needs_owner !== queue) reasons.push('needs_owner')
    if (pressure && pressure.level !== previous.pressure) reasons.push('pressure')
    const events = ticking === 'afk' ? selectLoopEventsAfter : selectEventsAfter
    const changes = (events.all(Number(previous.event_cursor)) as Row[]).map(toChange)
    for (const change of changes) if (!reasons.includes(change.kind)) reasons.push(change.kind)
    return { reasons, changes }
  }

  /**
   * argus#1167: is this check's pressure level a flip that has not yet held for the dwell? Tracks what the
   * check has seen: the level it differs at, and since when. A level equal to the recorded one ends the flip.
   */
  function pressureFlipPending(key: string, previous: Row, pressure: Pressure | null): boolean {
    if (!pressure || pressure.level === previous.pressure) {
      pressureFlips.delete(key)
      return false
    }
    // Nothing held to flip back to: a first reading after `unknown` is new information, not a flap.
    if (previous.pressure === 'unknown') return false
    const seen = pressureFlips.get(key)
    if (seen?.level !== pressure.level) {
      pressureFlips.set(key, { level: pressure.level, since: now() })
      return pressureDwellMs > 0
    }
    return now() - seen.since < pressureDwellMs
  }

  /** A quiet tick carries forward whatever the caller left out. */
  function quietTickValues(previous: Row, input: TickInput, pressure: Pressure | null): TickValues {
    return {
      slotCap: input.total_cap === undefined && input.slot_cap === undefined ? (previous.slot_cap as number | null) : totalCapOf(input),
      hostCaps: input.host_caps === undefined ? hostCapsOf(previous) : requireHostCaps(input.host_caps),
      exemptRepos: input.budget_exempt_repos === undefined ? exemptReposOf(previous) : requireExemptRepos(input.budget_exempt_repos),
      errors: input.errors ?? (JSON.parse(String(previous.errors)) as string[]),
      pressure: pressure ?? pressureOf(previous),
    }
  }

  const selectChild = db.prepare('SELECT * FROM ledger_children WHERE thread_id = ?')
  const selectOwner = db.prepare('SELECT * FROM ledger_owner WHERE id = 1')
  const selectPendingNotes = db.prepare('SELECT * FROM ledger_away_notes WHERE presented_at IS NULL ORDER BY id')
  const selectOpenOutage = db.prepare('SELECT * FROM ledger_outages WHERE closed_at IS NULL ORDER BY id DESC LIMIT 1')
  const selectNotified = db.prepare('SELECT 1 FROM ledger_notified WHERE class = ? AND item = ?')
  // A push this tick = a `notified` event of the class after Aquila's last recorded tick.
  const selectPushThisTick = db.prepare(`
    SELECT 1 FROM events
     WHERE kind = 'notified' AND json_extract(detail, '$.class') = ?
       AND id > COALESCE((SELECT event_cursor FROM loop_status WHERE role = 'direction'), 0)
     LIMIT 1`)

  function ownerPresence(): OwnerPresence {
    const row = selectOwner.get() as Row | undefined
    if (!row) return { last_turn_at: null, present: false, stepped_away: false }
    const steppedAway = Number(row.stepped_away) === 1
    const lastTurn = Number(row.last_turn_at)
    return { last_turn_at: iso(lastTurn), present: !steppedAway && now() - lastTurn < PRESENCE_MS, stepped_away: steppedAway }
  }

  /** Ledger writes are Aquila-only events: they wake Aquila's gate, never the AFK loop's. */
  const recordLedger = (kind: string, threadId: string | null, detail: Record<string, unknown> = {}) =>
    record(kind, 'direction', null, threadId, detail, 'direction')

  const slotHostOf = (issue: string) => optionalText((selectSlot.get(issue) as Row | undefined)?.host)

  function requireHost(host: string): asserts host is Host {
    if (!(HOSTS as readonly string[]).includes(host)) throw new Refused(`host must be one of ${HOSTS.join(', ')}, not "${host}"`)
  }

  /** The AFK thread hands over only the afk lease; Aquila, the lease writer, either. */
  function requireOwnLease(role: Role, value: string): TickingRole {
    const of = requireTickingRole(value)
    if (role === 'afk' && of !== 'afk') throw new Refused(`the afk role cannot hand over the ${of} lease`)
    return of
  }

  const leaseOf = (row: Row): Lease => ({
    thread_id: String(row.thread_id),
    since: iso(Number(row.moved_at)),
    primary_thread_id: optionalText(row.primary_thread_id),
    primary_host: optionalText(row.primary_host) as Host | null,
  })

  /** The lease row, refused unless it exists and from_thread_id names its holder. */
  function heldBy(of: TickingRole, from: string): Row {
    const row = selectLease.get(of) as Row | undefined
    if (!row) throw new Refused(`nobody holds the ${of} lease`)
    if (String(row.thread_id) !== from) throw new Refused(`the ${of} lease is held by ${String(row.thread_id)}, not ${from}`)
    return row
  }

  /** Moving or releasing a held lease names its holder and comes after that holder's schedule_task is gone. */
  function requireRetired(role: TickingRole, holder: string, input: { from_thread_id?: string; old_schedule_task_deleted?: boolean }) {
    if (input.from_thread_id !== holder) {
      throw new Refused(`the ${role} lease is held by ${holder}: pass it as from_thread_id to retire it`)
    }
    if (input.old_schedule_task_deleted !== true) {
      throw new Refused(`retire first: delete ${holder}'s schedule_task, then pass old_schedule_task_deleted: true`)
    }
  }

  const selectRunning = db.prepare("SELECT issue, host, budget_exempt FROM slots WHERE state = 'running'")

  /** The repo (owner/repo) an issue name (owner/repo#n) belongs to. */
  const repoOf = (issue: string) => issue.slice(0, issue.lastIndexOf('#'))

  /**
   * Running slots per host, 0 for a host with none. argus#1033: a slot in a budget-exempt repo is
   * outside the slot caps, so it is left out of the count unless `countExempt` asks for every slot.
   * argus#1171: so is a slot started with `budget_exempt`.
   */
  function runningByHost(exemptRepos: readonly string[], countExempt = false): Record<Host, number> {
    const counts: Record<Host, number> = { wsl2: 0, homelab: 0 }
    const exemptIssues = listedExemptIssues()
    for (const row of selectRunning.all() as Row[]) {
      const exempt =
        Number(row.budget_exempt) === 1 || exemptRepos.includes(repoOf(String(row.issue))) || exemptIssues.includes(String(row.issue).toLowerCase())
      if (!countExempt && exempt) continue
      const host = String(row.host)
      if (host in counts) counts[host as Host] += 1
    }
    return counts
  }

  const isListedExemptIssue = (issue: string) => listedExemptIssues().includes(issue.toLowerCase())

  const hasRunningExemptSlot = () => (selectRunning.all() as Row[]).some((row) => Number(row.budget_exempt) === 1)

  const selectSlotShape = db.prepare('SELECT issue, state, host, budget_exempt FROM slots ORDER BY issue')

  /**
   * argus-config#1357: what a `free_slot` answer rested on. A parked slot whose worker is still live holds its
   * host, which the server cannot see: it counts running slots only. So once the model has answered a `free_slot`
   * wake and started nothing, the same slot set, takeable counts and pressure level are not woken for again.
   */
  const freeSlotSignature = (takeable: number, takeableExempt: number, level: PressureLevel) =>
    JSON.stringify([takeable, takeableExempt, level, (selectSlotShape.all() as Row[]).map((row) => [row.issue, row.state, row.host, row.budget_exempt])])

  /** The signature each thread's last unanswered-by-a-start `free_slot` wake carried. In memory: a restart costs one more wake. */
  const freeSlotHeld = new Map<string, string>()

  /**
   * Whether the waking thread could start another non-exempt slot somewhere: room under the total cap and under
   * the `host_caps` entry of a host it may start on. argus-config#1366: a homelab thread starts slots only on its
   * own host, so room on the other host is no reason to wake it. argus#58: the wsl2 `afk` holder also fills free
   * homelab slots through the linked environment (charter, "Starting slots" under Cross-env control), so room on
   * any host wakes it. Only the lease holder reaches here: a standby returns earlier, and is never woken for a slot.
   */
  function slotRoom(status: Row, weekly: Weekly | null, host: Host): boolean {
    const totalCap = status.slot_cap === null ? null : Number(status.slot_cap)
    const exemptRepos = exemptReposOf(status)
    // The poll does not know which repo the takeable work is in: while any repo is exempt, count room against the uncut total.
    const cap = exemptRepos.length > 0 ? totalCap : effectiveSlotCap(totalCap, weekly)
    const perHost = runningByHost(exemptRepos)
    const running = perHost.wsl2 + perHost.homelab
    if (cap !== null && running >= cap) return false
    const hostCaps = hostCapsOf(status)
    const startHosts: readonly Host[] = host === 'wsl2' ? ['wsl2', 'homelab'] : [host]
    return startHosts.some((candidate) => hostCaps?.[candidate] === undefined || perHost[candidate] < (hostCaps[candidate] as number))
  }

  /**
   * The server-side half of the pressure ladders (#861, #871): no start at `no_new_slots` or
   * `gate_only`, none past the effective total cap, and none past the starting host's cap, from
   * the AFK loop's last recorded tick. Before any tick there is nothing to enforce.
   *
   * argus#1012, #1033: a slot in a `budget_exempt_repos` repo skips the budget ladder's cut and
   * sits outside the total, effective and host caps, both as a start and as a running slot that
   * others count. It keeps one running slot per repo and still obeys the pressure levels.
   *
   * argus#1171: a `budgetExempt` start (an efficiency:orchestrator issue) is the same outside the
   * caps and the ladder's cut, but keeps one running exempt slot in all, passes no_new_slots and
   * still stops at gate_only.
   *
   * argus#60: an issue in the directives' `budget_exempt_issues` passes no_new_slots and gate_only, sits outside
   * the caps and keeps one running such issue; the pressure ladders are the only gate the server holds for it.
   */
  function requireRoomForSlot(host: Host, issue: string, budgetExempt: boolean) {
    const status = selectStatus.get('afk') as Row | undefined
    if (!status) return
    const pressure = pressureOf(status)
    const listed = isListedExemptIssue(issue)
    // argus#1171: an efficiency:orchestrator start goes through no_new_slots, never gate_only. argus#60: a listed issue goes through both.
    if ((pressure.level === 'gate_only' && !listed) || (pressure.level === 'no_new_slots' && !budgetExempt && !listed)) {
      throw new Refused(`pressure is ${pressure.level}: no new slot starts until it eases`)
    }
    const refusal = capRefusal(status, pressure, host, issue, budgetExempt)
    if (refusal !== null) throw new Refused(refusal)
  }

  /**
   * Why the caps leave no running room for `issue`, or null. The cap half of requireRoomForSlot,
   * which argus-config#1169's resume from awaiting_ci uses alone: the worker is already running
   * work, so pressure does not stop it, only the caps do.
   */
  function capRefusal(status: Row, pressure: Pressure, host: Host, issue: string, budgetExempt: boolean): string | null {
    if (isListedExemptIssue(issue)) {
      const running = (selectRunning.all() as Row[]).find((row) => row.issue !== issue && isListedExemptIssue(String(row.issue)))
      return running === undefined ? null : `${String(running.issue)} already runs a budget-exempt issue: only one runs at a time`
    }
    if (budgetExempt) {
      const running = (selectRunning.all() as Row[]).find((row) => Number(row.budget_exempt) === 1)
      return running === undefined ? null : `${String(running.issue)} already runs a budget-exempt slot: only one runs at a time`
    }
    const exemptRepos = exemptReposOf(status)
    const repo = repoOf(issue)
    if (exemptRepos.includes(repo)) {
      const sameRepo = (selectRunning.all() as Row[]).find((row) => repoOf(String(row.issue)) === repo)
      return sameRepo ? `${repo} already runs a slot (${String(sameRepo.issue)}): a budget-exempt repo keeps one running slot` : null
    }
    const totalCap = status.slot_cap === null ? null : Number(status.slot_cap)
    const cap = effectiveSlotCap(totalCap, pressure.weekly)
    const perHost = runningByHost(exemptRepos)
    const running = perHost.wsl2 + perHost.homelab
    if (cap !== null && running >= cap) return `the effective slot cap ${cap} is reached (${running} running)`
    const hostCap = hostCapsOf(status)?.[host]
    if (hostCap !== undefined && perHost[host] >= hostCap) return `the ${host} slot cap ${hostCap} is reached (${perHost[host]} running there)`
    return null
  }

  /** What a slot write by a non-holder may do on its own host: wind slots down, never start one. */
  const DRAIN_TOOLS: readonly ToolName[] = ['slot_close', 'slot_park', 'slot_free']

  const unchecked = (tool: ToolName) =>
    `${tool} named no caller_thread_id, so the afk lease was not checked: pass your own thread id (a missing one will be refused in a later release)`

  /**
   * argus#882: an afk slot write counts only from the thread holding the afk lease, as a tick
   * does. Both hosts' afk MCP servers carry the same role token, so the token cannot tell the
   * WSL2 orchestrator from the homelab standby; the caller says who it is. A non-holder is
   * refused and leaves a lease_conflict event for Aquila's gate. The exception is the standby
   * drain (charter, Homelab standby): a non-holder that is not the lease's primary may close,
   * park or free a slot whose host is the host it names, never start one. The primary is
   * excluded because while a standby holds the lease it must reclaim before it writes (the
   * 26 Oct breach); an existing slot is the only thing a drain can touch.
   * Runs first in the caller's transaction. Returns a warning when the check was skipped.
   */
  function requireAfkLease(role: Role, tool: ToolName, caller: SlotCaller, issue: string | null, slotHost: string | null): string | null {
    if (role !== 'afk') return null
    const threadId = caller.caller_thread_id
    if (threadId === undefined || threadId === '') {
      if (options.requireCallerThread) throw new Refused(`${tool} must name your own thread as caller_thread_id: the afk lease is checked against it`)
      record('slot_write_unchecked', role, issue, null, { tool }, 'direction')
      touchHolder('afk', holderOf('afk'))
      return unchecked(tool)
    }
    const lease = selectLease.get('afk') as Row | undefined
    const holder = optionalText(lease?.thread_id)
    if (holder === threadId) {
      touchHolder('afk', threadId)
      return null
    }
    const primary = optionalText(lease?.primary_thread_id)
    const drains = DRAIN_TOOLS.includes(tool) && caller.host !== undefined && slotHost === caller.host && threadId !== primary
    if (drains) return null
    record('lease_conflict', role, issue, threadId, { role, holder, tool }, 'direction')
    const who = holder === null ? 'no thread holds the afk lease' : `the afk lease is held by ${holder}`
    throw new LeaseRefused(
      `${who}, not ${threadId}: ${tool} is refused. Run lease_read and route the role first. A non-holder may only close, park or free a slot on its own host, passing host.`,
    )
  }

  /** argus#54: whether a thread is the registered owner chat of either host. */
  const isOwnerThread = (threadId: string) => selectOwnerThreadById.get(threadId) !== undefined

  /**
   * argus#1042: an owner turn counts only from the thread holding the direction lease, so a
   * stray thread launched in the orchestrator's workspace (it inherits the direction token)
   * cannot record presence or take the "since you left" lines. Same shape as requireAfkLease,
   * without the standby drain: a non-holder is refused and leaves a lease_conflict event.
   * argus#54: for owner_turn alone, a thread registered by owner_thread_set (the owner chat of
   * a split tick) counts too; it is no activity of the holder, so it does not touch it.
   * Runs first in the caller's transaction. Returns a warning when the check was skipped.
   */
  function requireDirectionLease(role: Role, callerThreadId: string | undefined, tool: 'owner_turn' | 'directives_set' | 'owner_thread_set' = 'owner_turn'): string | null {
    if (callerThreadId === undefined || callerThreadId === '') {
      // A new tool has no charter to wait for: only owner_turn, which shipped without the id, gets the grace.
      if (tool !== 'owner_turn' || options.requireCallerThread) {
        throw new Refused(`${tool} must name your own thread as caller_thread_id: the direction lease is checked against it`)
      }
      record('owner_turn_unchecked', role, null, null, { tool }, 'direction')
      touchHolder('direction', holderOf('direction'))
      return 'owner_turn named no caller_thread_id, so the direction lease was not checked: pass your own thread id (a missing one will be refused in a later release)'
    }
    const holder = holderOf('direction')
    if (holder === callerThreadId) {
      touchHolder('direction', callerThreadId)
      return null
    }
    if (tool === 'owner_turn' && isOwnerThread(callerThreadId)) return null
    record('lease_conflict', role, null, callerThreadId, { role, holder, tool }, 'direction')
    const who = holder === null ? 'no thread holds the direction lease' : `the direction lease is held by ${holder}`
    const only = tool === 'owner_turn' ? 'records an owner turn' : tool === 'owner_thread_set' ? 'registers the owner thread' : 'sets the directives'
    throw new LeaseRefused(`${who}, not ${callerThreadId}: ${tool} is refused. Only the orchestrator thread ${only}.`)
  }

  const selectDirectives = db.prepare('SELECT * FROM directives WHERE version = ?')
  const selectCurrentDirectives = db.prepare('SELECT * FROM directives ORDER BY version DESC LIMIT 1')
  const selectDirectivesHistory = db.prepare('SELECT version, set_at, set_by, source, reason FROM directives ORDER BY version DESC')
  const insertDirectives = db.prepare('INSERT INTO directives (version, record, set_at, set_by, source, reason) VALUES (?, ?, ?, ?, ?, ?)')

  const toDirectivesSummary = (row: Row): DirectivesSummary => ({
    version: Number(row.version),
    set_at: iso(Number(row.set_at)),
    set_by: optionalText(row.set_by),
    source: row.source as DirectivesSource,
    reason: String(row.reason),
  })
  const toDirectives = (row: Row): DirectivesEntry => ({ ...toDirectivesSummary(row), record: JSON.parse(String(row.record)) as Record<string, unknown> })
  const currentDirectivesVersion = () => Number((selectCurrentDirectives.get() as Row | undefined)?.version ?? 0)

  const countAwaitingCi = db.prepare("SELECT COUNT(*) AS n FROM slots WHERE state = 'awaiting_ci'")
  const awaitingCiCount = () => Number((countAwaitingCi.get() as Row).n)

  /**
   * argus-config#1169: how many slots may await CI at once, from the current directives record's
   * `awaiting_ci_cap` (0 turns the state off), else the default. Read here, not carried on a tick,
   * so setting the directives key needs no charter or tick change.
   */
  function awaitingCiCap(): number {
    const row = selectCurrentDirectives.get() as Row | undefined
    if (!row) return DEFAULT_AWAITING_CI_CAP
    const cap = (JSON.parse(String(row.record)) as Record<string, unknown>).awaiting_ci_cap
    return typeof cap === 'number' && Number.isInteger(cap) && cap >= 0 ? cap : DEFAULT_AWAITING_CI_CAP
  }

  function requireValidDirectives(record: unknown): Record<string, unknown> {
    const problems = directivesProblems(record)
    if (problems.length > 0) throw new Refused(`the directives record is invalid:\n- ${problems.join('\n- ')}`)
    return record as Record<string, unknown>
  }

  return {
    slotStart(role: Role, issue: string, threadId: string, host: Host = 'wsl2', callerThreadId?: string, budgetExempt = false): SlotWrite {
      permit(role, 'slot_start')
      requireIssue(issue)
      requireText(threadId, 'thread_id')
      requireHost(host)
      return write(() => {
        const warning = requireAfkLease(role, 'slot_start', { caller_thread_id: callerThreadId }, issue, null)
        const existing = selectSlot.get(issue) as Row | undefined
        const at = now()
        if (existing?.state === 'awaiting_ci') throw new Refused(`${issue} awaits CI: it resumes only after Aquila resumes it (slot_resume_ci)`)
        if (existing?.state !== 'running') requireRoomForSlot(host, issue, budgetExempt)
        if (existing) {
          if (existing.state === 'parked') throw new Refused(`${issue} is parked: it resumes only after Aquila un-parks it`)
          if (existing.state === 'running') {
            throw new Refused(`${issue} already holds a running slot (thread ${String(existing.thread_id)})`)
          }
          db.prepare(
            `UPDATE slots SET thread_id = ?, state = 'running', host = ?, started_at = ?, updated_at = ?, note = NULL,
                    budget_exempt = ?, pending_approvals = 0, report_outcome = NULL, report_note = NULL, report_pr = NULL, reported_at = NULL
              WHERE issue = ?`,
          ).run(threadId, host, at, at, budgetExempt ? 1 : 0, issue)
        } else {
          db.prepare(
            "INSERT INTO slots (issue, thread_id, state, host, started_at, updated_at, budget_exempt) VALUES (?, ?, 'running', ?, ?, ?, ?)",
          ).run(issue, threadId, host, at, at, budgetExempt ? 1 : 0)
        }
        record('slot_started', role, issue, threadId, budgetExempt ? { budget_exempt: true } : undefined)
        return withWarning(toSlot(selectSlot.get(issue) as Row), warning)
      })
    },

    slotPark(role: Role, issue: string, note?: string, caller: SlotCaller = {}): SlotWrite {
      permit(role, 'slot_park')
      return write(() => {
        const warning = requireAfkLease(role, 'slot_park', caller, issue, slotHostOf(issue))
        const row = slotOrRefuse(issue)
        requireState(row, 'running', 'park')
        db.prepare("UPDATE slots SET state = 'parked', note = ?, pending_approvals = 0, updated_at = ? WHERE issue = ?").run(note ?? null, now(), issue)
        record('slot_parked', role, issue, String(row.thread_id), { note: note ?? null })
        return withWarning(toSlot(selectSlot.get(issue) as Row), warning)
      })
    },

    slotUnpark(role: Role, issue: string, note?: string): Slot {
      permit(role, 'slot_unpark')
      return write(() => {
        const row = slotOrRefuse(issue)
        requireState(row, 'parked', 'un-park')
        db.prepare("UPDATE slots SET state = 'ready', note = ?, updated_at = ? WHERE issue = ?").run(note ?? null, now(), issue)
        record('slot_unparked', role, issue, String(row.thread_id), { note: note ?? null })
        touchHolder('direction', holderOf('direction'))
        return toSlot(selectSlot.get(issue) as Row)
      })
    },

    slotReport(
      role: Role,
      input: { issue: string; thread_id: string; outcome: ReportOutcome; note?: string; pr?: string },
    ): Slot {
      permit(role, 'slot_report')
      return write(() => {
        const row = slotOrRefuse(input.issue)
        requireState(row, 'running', 'report on')
        if (row.thread_id !== input.thread_id) {
          throw new Refused(`${input.issue} is held by thread ${String(row.thread_id)}, not ${input.thread_id}`)
        }
        db.prepare(
          'UPDATE slots SET report_outcome = ?, report_note = ?, report_pr = ?, reported_at = ?, updated_at = ? WHERE issue = ?',
        ).run(input.outcome, input.note ?? null, input.pr ?? null, now(), now(), input.issue)
        record('slot_reported', role, input.issue, input.thread_id, { outcome: input.outcome })
        return toSlot(selectSlot.get(input.issue) as Row)
      })
    },

    /**
     * argus-config#1169: the worker's PR is open and its checks have started, so it gives up its
     * slot's place under the caps and ends its turn. Refused past the awaiting cap: the worker
     * then keeps its running slot and waits as it did before.
     */
    slotAwaitCi(role: Role, input: { issue: string; thread_id: string; ref: string; note?: string }): Slot {
      permit(role, 'slot_await_ci')
      if (!CI_REF_PATTERN.test(input.ref)) throw new Refused(
        'ref must be the PR URL (https://github.com/owner/repo/pull/N), the pushed commit SHA, or owner/repo@<40-hex sha> for a push in another repo',
      )
      return write(() => {
        const row = slotOrRefuse(input.issue)
        requireState(row, 'running', 'await CI on')
        if (row.thread_id !== input.thread_id) {
          throw new Refused(`${input.issue} is held by thread ${String(row.thread_id)}, not ${input.thread_id}`)
        }
        const waiting = awaitingCiCount()
        const cap = awaitingCiCap()
        if (waiting >= cap) throw new Refused(`${waiting} slots already await CI (cap ${cap}): keep your slot and wait for the checks`)
        db.prepare("UPDATE slots SET state = 'awaiting_ci', ci_ref = ?, note = ?, pending_approvals = 0, updated_at = ? WHERE issue = ?").run(
          input.ref,
          input.note ?? null,
          now(),
          input.issue,
        )
        record('slot_awaiting_ci', role, input.issue, input.thread_id, { ref: input.ref })
        return toSlot(selectSlot.get(input.issue) as Row)
      })
    },

    /**
     * argus-config#1169: Aquila's move when an awaiting slot's checks finish, green or red. The slot
     * counts against the caps again: running if they have room, else ready, where it waits for a
     * free slot like an un-parked one. Pressure does not stop it, the worker is already mid-task.
     *
     * argus/37: with `reportOnly` a green slot has nothing left to build, only a Resolution to
     * post and a report to make, so it skips the total, effective and host caps and always goes
     * to running. Only a note that says "checks green" may ask for it; a red resume does real
     * work and stays capped.
     */
    slotResumeCi(role: Role, issue: string, note?: string, reportOnly = false): { slot: Slot; resumed: boolean; reason?: string } {
      permit(role, 'slot_resume_ci')
      if (reportOnly && !GREEN_NOTE_PATTERN.test(note ?? '')) {
        throw new Refused('report_only skips the slot caps, so it needs note to say "checks green"; a red resume stays capped')
      }
      return write(() => {
        const row = slotOrRefuse(issue)
        requireState(row, 'awaiting_ci', 'resume')
        const status = selectStatus.get('afk') as Row | undefined
        const refusal =
          status && !reportOnly
            ? capRefusal(status, pressureOf(status), String(row.host) as Host, issue, Number(row.budget_exempt) === 1)
            : null
        const state = refusal === null ? 'running' : 'ready'
        db.prepare('UPDATE slots SET state = ?, ci_ref = NULL, note = ?, updated_at = ? WHERE issue = ?').run(state, note ?? null, now(), issue)
        record(refusal === null ? 'slot_resumed' : 'slot_resume_deferred', role, issue, String(row.thread_id), {
          note: note ?? null,
          ...(reportOnly ? { report_only: true } : {}),
          ...(refusal === null ? {} : { reason: refusal }),
        })
        touchHolder('direction', holderOf('direction'))
        const slot = toSlot(selectSlot.get(issue) as Row)
        return refusal === null ? { slot, resumed: true } : { slot, resumed: false, reason: refusal }
      })
    },

    slotClose(role: Role, issue: string, verified: string, caller: SlotCaller = {}): { slot: ClosedSlot; warning?: string } {
      permit(role, 'slot_close')
      if (!verified.startsWith('Verified:')) throw new Refused('verified must be the closeout\'s "Verified:" line, with its evidence')
      return write(() => {
        const warning = requireAfkLease(role, 'slot_close', caller, issue, slotHostOf(issue))
        const row = slotOrRefuse(issue)
        if (row.state !== 'running' && row.state !== 'ready') {
          throw new Refused(`cannot close ${String(row.issue)}: it is ${String(row.state)}, not running or ready`)
        }
        deleteSlot.run(issue)
        record('slot_closed', role, issue, String(row.thread_id), { verified })
        const { state: previous_state, ...last } = toSlot(row)
        const closed: ClosedSlot = { ...last, state: 'closed', previous_state, verified, closed_at: iso(now()) }
        return withEndedWarning(closed, warning)
      })
    },

    slotFree(role: Role, issue: string, reason: string, caller: SlotCaller = {}): { slot: FreedSlot; warning?: string } {
      permit(role, 'slot_free')
      requireText(reason, 'reason')
      return write(() => {
        const warning = requireAfkLease(role, 'slot_free', caller, issue, slotHostOf(issue))
        const row = slotOrRefuse(issue)
        deleteSlot.run(issue)
        record('slot_freed', role, issue, String(row.thread_id), { reason, state: row.state })
        const { state: previous_state, ...last } = toSlot(row)
        const freed: FreedSlot = { ...last, state: 'freed', previous_state, reason, freed_at: iso(now()) }
        return withEndedWarning(freed, warning)
      })
    },

    slotList(role: Role, state?: SlotState): Slot[] {
      permit(role, 'slot_list')
      const slots = (selectSlots.all() as Row[]).map(toSlot)
      return state ? slots.filter((slot) => slot.state === state) : slots
    },

    /**
     * Rebuild-from-GitHub: set the slots against the world the caller observed (GitHub's
     * assignee and needs:owner mirror, and the T3 thread list). Compare-only unless `apply`:
     * a compare writes nothing at all, so the cut gate can check the seed before the lease
     * moves. Aquila may apply only while no AFK thread holds its lease (seeding at the cut);
     * with the loop running, the AFK thread reconciles its own slots.
     */
    slotRebuild(role: Role, world: World, apply = false, host?: Host, callerThreadId?: string): RebuildPlan & { applied: boolean; agrees: boolean; warning?: string } {
      permit(role, 'slot_rebuild')
      if (host !== undefined) requireHost(host)
      for (const issue of world.issues) {
        requireIssue(issue.issue)
        if (issue.claimed_by !== undefined) requireText(issue.claimed_by, 'claimed_by')
      }
      for (const thread of world.threads) {
        requireText(thread.thread_id, 'thread_id')
        if (thread.issue !== undefined) requireIssue(thread.issue)
      }
      const planFor = () => {
        const rows = selectSlots.all() as Row[]
        // A host sees only its own T3 threads, so it reconciles only its own slots: the other
        // host's slots and their issues stay out of the plan entirely.
        const foreign = new Set(host === undefined ? [] : rows.filter((row) => row.host !== host).map((row) => String(row.issue)))
        const current = rows
          .filter((row) => !foreign.has(String(row.issue)))
          .map((row) => ({ issue: String(row.issue), state: row.state as SlotState, thread_id: String(row.thread_id) }))
        return planRebuild(current, { ...world, issues: world.issues.filter((issue) => !foreign.has(issue.issue)) })
      }
      if (!apply) {
        const plan = planFor()
        return { applied: false, agrees: plan.changes.length === 0, ...plan }
      }
      return write(() => {
        const warning = requireAfkLease(role, 'slot_rebuild', { caller_thread_id: callerThreadId }, null, null)
        if (role === 'direction') {
          const holder = holderOf('afk')
          if (holder !== null) throw new Refused(`the afk lease is held by ${holder}: that thread writes slots, so run the rebuild compare-only`)
        }
        const plan = planFor()
        const at = now()
        for (const change of plan.changes) {
          if (change.action === 'remove') {
            deleteSlot.run(change.issue)
          } else if (change.action === 'add' && change.to) {
            db.prepare('INSERT INTO slots (issue, thread_id, state, host, started_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(
              change.issue,
              change.to.thread_id,
              change.to.state,
              host ?? 'wsl2',
              at,
              at,
            )
          } else if (change.to && change.from?.thread_id !== change.to.thread_id) {
            // A different worker: a fresh start, and the old worker's report no longer applies.
            db.prepare(
              `UPDATE slots SET thread_id = ?, state = ?, started_at = ?, updated_at = ?, pending_approvals = 0,
                      report_outcome = NULL, report_note = NULL, report_pr = NULL, reported_at = NULL
                WHERE issue = ?`,
            ).run(change.to.thread_id, change.to.state, at, at, change.issue)
          } else if (change.to) {
            db.prepare(
              "UPDATE slots SET state = ?, updated_at = ?, pending_approvals = CASE WHEN ? = 'running' THEN pending_approvals ELSE 0 END WHERE issue = ?",
            ).run(change.to.state, at, change.to.state, change.issue)
          }
          record('slot_rebuilt', role, change.issue, (change.to ?? change.from)?.thread_id ?? null, {
            action: change.action,
            from: change.from,
            to: change.to,
          })
        }
        return { applied: true, agrees: plan.changes.length === 0, ...plan, ...(warning === null ? {} : { warning }) }
      })
    },

    /**
     * A full tick's closing write: a snapshot of what the tick saw. Omitted fields are recorded
     * as unknown. Records nothing unless the caller holds its role's lease.
     */
    statusTick(role: Role, input: StatusTickInput): LeaseCheck & { recorded: boolean } {
      const ticking = asTicking(role, 'status_tick')
      requireText(input.thread_id, 'thread_id')
      const pressure = resolvePressure(input, undefined, selectStatus.get(ticking) as Row | undefined) ?? { level: 'unknown' as const, windowLevel: 'unknown' as const, percent: null, weekly: null }
      const slotCap = totalCapOf(input)
      const hostCaps = requireHostCaps(input.host_caps)
      const exemptRepos = requireExemptRepos(input.budget_exempt_repos)
      const approvals = requireApprovalCounts(input.pending_approvals ?? {})
      return write(() => {
        acknowledgeWake(ticking, input.thread_id)
        const lease = checkLease(ticking, input.thread_id)
        if (!lease.holds_lease) return { recorded: false, ...lease }
        writeTick(ticking, input, { slotCap, hostCaps, exemptRepos, errors: input.errors ?? [], pressure })
        // A slot freed or parked since the tick read its worker has nothing left to count: skipped, not an error.
        for (const [issue, count] of approvals) setApprovals.run(count, issue)
        return { recorded: true, ...lease }
      })
    },

    /**
     * The quiet-tick gate: has anything changed since this role's last recorded tick? A quiet
     * tick is recorded here, carrying forward whatever the caller omitted, so the whole quiet
     * tick is this call plus re-arming. A changed tick records nothing: the full checklist
     * ends with status_tick, which moves the cursor past the changes it handled.
     */
    tickGate(role: Role, input: TickInput): GateResult {
      const ticking = asTicking(role, 'tick_gate')
      requireText(input.thread_id, 'thread_id')
      requireText(input.directives_version, 'directives_version')
      resolvePressure(input)
      requireExemptRepos(input.budget_exempt_repos)
      const queue = JSON.stringify(normaliseQueue(input.needs_owner))
      return write(() => {
        acknowledgeWake(ticking, input.thread_id)
        const lease = checkLease(ticking, input.thread_id)
        if (!lease.holds_lease) return { changed: false, reasons: [], changes: [], recorded: false, since: null, ...lease }

        const previous = selectStatus.get(ticking) as Row | undefined
        if (!previous) return { changed: true, reasons: ['first_tick'], changes: [], recorded: false, since: null, ...lease }

        const pressure = resolvePressure(input, previous)
        const { reasons, changes } = compareTick(ticking, previous, input, queue, pressure)
        const since = iso(Number(previous.last_tick_at))
        if (reasons.length > 0) return { changed: true, reasons, changes, recorded: false, since, ...lease }

        writeTick(ticking, input, quietTickValues(previous, input, pressure))
        return { changed: false, reasons, changes, recorded: true, since, ...lease }
      })
    },

    /**
     * POST /events/promoted (argus#1118): ops-hub reports that it moved a repo's `deploy` branch.
     * Idempotent on repo + to_sha: a repeat (the Approve path and the webhook both report the same
     * push) records nothing. The event is Aquila's alone, so it wakes the direction gate and never the AFK loop's.
     */
    recordPromoted(input: PromotedInput): { recorded: boolean } {
      return write(() => {
        const inserted = insertPromotion.run(input.repo, input.to_sha, input.from_sha, input.at, input.source)
        if (Number(inserted.changes) === 0) return { recorded: false }
        record('promoted', 'direction', null, null, { repo: input.repo, from_sha: input.from_sha, to_sha: input.to_sha, at: input.at, source: input.source }, 'direction')
        return { recorded: true }
      })
    },

    /**
     * POST /wake/request (argus#1189): ops-hub asks for an Aquila wake for a named issue. Records a
     * `wake_requested` event on the direction gate, which POST /wake/check answers on its next poll and the
     * model tick that follows acknowledges. It writes no slot, lease or directive: a wake only starts a
     * tick, and the tick's own gates (slot cap, budget rungs, load) decide whether anything starts.
     * Every answer names the budget rung (argus#47), which the hub's bearer cannot read elsewhere.
     * Rate-limited from the events themselves, so a restart does not reset it.
     */
    recordWakeRequest(issue: string): WakeRequestResult {
      requireIssue(issue)
      return write((): WakeRequestResult => {
        // The AFK loop's last tick, the row requireRoomForSlot enforces: a read, so the route still writes nothing but the event.
        const afkStatus = selectStatus.get('afk') as Row | undefined
        const weekly = afkStatus ? weeklyOf(afkStatus) : null
        const budget: WakeBudget = { budget_rung: weekly?.rung ?? null, budget_rung_held: weekly?.held ?? false }
        if (selectWakeRequestPending.get(issue) !== undefined) return { recorded: false, reason: 'pending', ...budget }
        const retryAfter = (untilMs: number): WakeRequestResult => ({
          rate_limited: true,
          retry_after_seconds: Math.max(1, Math.ceil((untilMs - now()) / 1000)),
          ...budget,
        })
        const last = Number((selectWakeRequestLast.get(issue) as Row).at ?? 0)
        if (last > 0 && now() - last < WAKE_REQUEST_COOLDOWN_MS) return retryAfter(last + WAKE_REQUEST_COOLDOWN_MS)
        const recent = (selectWakeRequestsSince.all(now() - WAKE_REQUEST_WINDOW_MS) as Row[]).map((row) => Number(row.at))
        if (recent.length >= WAKE_REQUEST_HOURLY_CAP) return retryAfter(recent[recent.length - WAKE_REQUEST_HOURLY_CAP]! + WAKE_REQUEST_WINDOW_MS)
        record('wake_requested', 'direction', issue, null, {}, 'direction')
        return { recorded: true, ...budget }
      })
    },

    /**
     * POST /wake/check (argus#831): does this tick need a model turn? The loop-wake client posts
     * the gate inputs it gathered without a model. A quiet tick on the primary is recorded here,
     * marked as recorded by the client; any wake must be answered by a model tick within
     * WAKE_ACK_MS, or the thread is stalled, so client-recorded quiet ticks never hide a dead
     * thread. Writes no event: polling never wakes the other role's gate.
     */
    wakeCheck(role: Role, input: WakeCheckInput): WakeResult {
      permit(role, 'wake_check')
      const of = requireTickingRole(input.role)
      if (of !== role) throw new Refused(`a ${role} token cannot check the ${of} role`)
      requireHost(input.host)
      requireText(input.thread_id, 'thread_id')
      requireText(input.directives_version, 'directives_version')
      const queue = JSON.stringify(normaliseQueue(input.needs_owner))
      resolvePressure(input)
      if (of === 'afk' && input.takeable === undefined) throw new Refused('an afk check must pass takeable')
      if (input.takeable !== undefined && (!Number.isInteger(input.takeable) || input.takeable < 0)) {
        throw new Refused('takeable must be a whole number, 0 or more')
      }
      if (input.takeable_exempt !== undefined && (!Number.isInteger(input.takeable_exempt) || input.takeable_exempt < 0)) {
        throw new Refused('takeable_exempt must be a whole number, 0 or more')
      }

      return write((): WakeResult => {
        const quiet = (reason: string): WakeResult => ({ wake: false, reason, recorded: false })
        const wake = (reason: string): WakeResult => {
          upsertWake.run(of, input.thread_id, now(), reason, now())
          return { wake: true, reason, recorded: false }
        }
        const sinceLastWake = () => {
          const row = selectWake.get(of, input.thread_id) as Row | undefined
          return row ? now() - Number(row.last_wake_at) : Number.POSITIVE_INFINITY
        }

        const lease = selectLease.get(of) as Row | undefined
        if (!lease) return quiet('no_lease')
        const holder = String(lease.thread_id)

        // A homelab thread that is the lease's primary follows the primary's path below (argus#1046).
        if (input.host === 'homelab' && input.thread_id !== optionalText(lease.primary_thread_id)) {
          // A standby: its ticks matter only while the primary is down, or while its own workers drain.
          if (holder === input.thread_id) return sinceLastWake() >= cadenceMs ? wake('standby_cadence') : quiet('standby_waiting')
          if (holderStalled(of, lease)) return wake('failover')
          // Only a running worker has a report to settle; a parked slot waits on the owner, a ready one on the lease holder.
          // And only when the holder could not drain it itself: a live WSL2 holder drains homelab slots directly (charter,
          // Cross-env control), so waking the standby for them is an empty model turn (argus#57).
          if (of === 'afk' && sinceLastWake() >= cadenceMs && holderLeftHomelabSlots(of, lease)) return wake('drain')
          return quiet('primary_alive')
        }

        if (holder !== input.thread_id) return input.thread_id === optionalText(lease.primary_thread_id) ? wake('reclaim') : quiet('not_holder')

        const previous = selectStatus.get(of) as Row | undefined
        if (!previous) return wake('first_tick')
        // argus#1189: ops-hub asked for a wake. Answered until a model tick passes the request, then it is spent.
        if (of === 'direction') {
          const requested = [...new Set((selectWakeRequestsAfter.all(Number(previous.event_cursor)) as Row[]).map((row) => String(row.issue)))]
          if (requested.length > 0) return wake(`wake_requested:${requested.join(',')}`)
        }
        // argus-config#1351: a `promoted` event is recorded and reaches tick_gate, but wakes nothing here. tick-prep wakes
        // Aquila (`promoted_followup`) only when the flagged issue has an owner step waiting.
        const pressure = resolvePressure(input, previous)
        const flipPending = pressureFlipPending(`${of}:${input.thread_id}`, previous, pressure)
        const reasons = compareTick(of, previous, input, queue, pressure).reasons.filter(
          (reason) => !isWakeNoise(reason) && !(reason === 'pressure' && flipPending),
        )
        if (reasons.length > 0) return wake(`changed:${reasons.join(',')}`)

        if (of === 'direction') {
          const outageOpen = selectOpenOutage.get() !== undefined
          const afkStalled = livenessState('afk') === 'stalled'
          if (afkStalled !== outageOpen) return wake(afkStalled ? 'outage_opened' : 'outage_closed')
        } else {
          // A worker blocked on an approval prompt reads as idle: wake the AFK thread to park it, whatever the pressure.
          if (selectApprovals.all().length > 0) return wake('pending_approvals')
          // A flip still inside its dwell counts only when it is the stricter level: an improvement that may flip back starts nothing.
          const held = previous.pressure as PressureLevel
          const level = flipPending && pressure ? (PRESSURE_LEVELS.indexOf(pressure.level) > PRESSURE_LEVELS.indexOf(held) ? pressure.level : held) : (pressure?.level ?? held)
          // argus#1167: with the host's gates closed the thread could not start a slot, so a free one is no reason to wake.
          const hostAllowsStart = input.host_gates_ok !== false
          const startsSlots = level !== 'no_new_slots' && level !== 'gate_only'
          const takeable = input.takeable ?? 0
          const takeableExempt = input.takeable_exempt ?? 0
          const freeSlotKey = `${of}:${input.thread_id}`
          const wantsSlot =
            hostAllowsStart &&
            ((startsSlots && takeable > 0 && slotRoom(previous, (pressure ?? pressureOf(previous)).weekly, input.host)) ||
              // argus#1171: at no_new_slots only an efficiency:orchestrator start is allowed, and only one runs at a time.
              (level === 'no_new_slots' && takeableExempt > 0 && !hasRunningExemptSlot()))
          if (wantsSlot) {
            const signature = freeSlotSignature(takeable, takeableExempt, level)
            const answered = (selectWake.get(of, input.thread_id) as Row | undefined)?.pending_since == null
            if (!(answered && freeSlotHeld.get(freeSlotKey) === signature)) {
              freeSlotHeld.set(freeSlotKey, signature)
              return wake('free_slot')
            }
          } else {
            freeSlotHeld.delete(freeSlotKey)
          }
        }

        const lastModelTick = previous.last_model_tick_at === null ? null : Number(previous.last_model_tick_at)
        if (lastModelTick === null || now() - lastModelTick >= HEARTBEAT_MS) return wake('heartbeat')
        if ((selectWake.get(of, input.thread_id) as Row | undefined)?.pending_since != null) return wake('unanswered')

        // A flip inside its dwell is not recorded: the tick keeps the held level, so a flip back is no flip.
        writeTick(of, input, quietTickValues(previous, input, flipPending ? null : pressure), 'client')
        return { wake: false, reason: 'quiet', recorded: true }
      })
    },

    leaseRead(role: Role): { leases: Record<TickingRole, Lease | null>; owner_threads?: Record<Host, string | null> } {
      permit(role, 'lease_read')
      const read = (of: TickingRole): Lease | null => {
        const row = selectLease.get(of) as Row | undefined
        return row ? leaseOf(row) : null
      }
      const ownerThreads: Record<Host, string | null> = { wsl2: null, homelab: null }
      const registered = selectOwnerThreads.all() as Row[]
      for (const row of registered) ownerThreads[String(row.host) as Host] = String(row.thread_id)
      // Shown only once one is registered (argus#54), so the result is what it was before for a db that has none.
      const leases = { afk: read('afk'), direction: read('direction') }
      return registered.length === 0 ? { leases } : { leases, owner_threads: ownerThreads }
    },

    /**
     * Give a role's lease to a thread. An unheld lease is simply taken (first boot, or after a
     * release). A held one moves only in the retire-first order: the retiring holder's
     * schedule_task is deleted first, then the lease moves, then the old thread is settled
     * and the successor boots.
     */
    leaseMove(role: Role, input: LeaseMoveInput): { lease: Lease } {
      permit(role, 'lease_move')
      const of = requireTickingRole(input.role)
      requireText(input.to_thread_id, 'to_thread_id')
      if (input.host !== undefined) requireHost(input.host)
      return write(() => {
        const holder = holderOf(of)
        if (holder === input.to_thread_id) throw new Refused(`${holder} already holds the ${of} lease`)
        if (holder !== null) requireRetired(of, holder, input)
        const primaryHost = input.host ?? null
        upsertLease.run(of, input.to_thread_id, now(), input.to_thread_id, primaryHost)
        record('lease_moved', role, null, input.to_thread_id, { role: of, from: holder, host: primaryHost })
        return { lease: { thread_id: input.to_thread_id, since: iso(now()), primary_thread_id: input.to_thread_id, primary_host: primaryHost } }
      })
    },

    /**
     * A standby takes a lease while its holder is stalled (2+ missed ticks): the holder's host
     * is offline, so it cannot retire first. The primary is kept, so lease_reclaim can hand
     * the lease back. The AFK thread may fail over only its own lease; Aquila either.
     */
    leaseFailover(role: Role, input: LeaseHandoverInput): { lease: Lease } {
      permit(role, 'lease_failover')
      const of = requireOwnLease(role, input.role)
      requireText(input.to_thread_id, 'to_thread_id')
      return write(() => {
        const row = heldBy(of, input.from_thread_id)
        if (row.thread_id === input.to_thread_id) throw new Refused(`${input.to_thread_id} already holds the ${of} lease`)
        const { missed, lastSeen } = holderMissed(of, row)
        const unanswered = wakeUnanswered(of, String(row.thread_id))
        if (missed < 2) {
          throw new Refused(
            `${String(row.thread_id)} is not stalled (${missed} missed tick(s), last seen ${iso(lastSeen)}${unanswered ? ', wake unanswered but that alone is only late' : ''}): a failover needs 2 missed ticks`,
          )
        }
        const primary = optionalText(row.primary_thread_id) ?? String(row.thread_id)
        const primaryHost = optionalText(row.primary_host) as Host | null
        upsertLease.run(of, input.to_thread_id, now(), primary, primaryHost)
        acknowledgeWake(of, input.to_thread_id)
        record(
          'lease_failover',
          role,
          null,
          input.to_thread_id,
          { role: of, from: String(row.thread_id), missed_ticks: missed, unanswered_wake: unanswered },
          'direction',
        )
        return { lease: { thread_id: input.to_thread_id, since: iso(now()), primary_thread_id: primary, primary_host: primaryHost } }
      })
    },

    /**
     * Hand a failed-over lease back to its primary, which may do so at any time once it is back.
     * WSL2's primary changes thread id often (argus#1046), so a new thread on the lease's
     * primary_host also reclaims it when it passes that host, and becomes the primary.
     */
    leaseReclaim(role: Role, input: LeaseHandoverInput): { lease: Lease } {
      permit(role, 'lease_reclaim')
      const of = requireOwnLease(role, input.role)
      requireText(input.to_thread_id, 'to_thread_id')
      if (input.host !== undefined) requireHost(input.host)
      return write(() => {
        const row = heldBy(of, input.from_thread_id)
        const primary = optionalText(row.primary_thread_id)
        const primaryHost = optionalText(row.primary_host) as Host | null
        const isPrimary = primary !== null && input.to_thread_id === primary
        const onPrimaryHost = input.host !== undefined && primaryHost !== null && input.host === primaryHost
        if (!isPrimary && !onPrimaryHost) {
          throw new Refused(
            `only the ${of} lease's primary (${primary ?? 'none recorded'}${primaryHost === null ? '' : ` on ${primaryHost}`}) or a new thread on its primary host, passing host, can reclaim it`,
          )
        }
        if (String(row.thread_id) === input.to_thread_id) throw new Refused(`${input.to_thread_id} already holds the ${of} lease`)
        upsertLease.run(of, input.to_thread_id, now(), input.to_thread_id, primaryHost)
        acknowledgeWake(of, input.to_thread_id)
        record('lease_reclaimed', role, null, input.to_thread_id, { role: of, from: String(row.thread_id), host: input.host ?? null }, 'direction')
        return { lease: { thread_id: input.to_thread_id, since: iso(now()), primary_thread_id: input.to_thread_id, primary_host: primaryHost } }
      })
    },

    /** Rollback: release a role's lease so no thread's tick counts until the next move. */
    leaseRelease(role: Role, input: LeaseReleaseInput): { released: Lease } {
      permit(role, 'lease_release')
      const of = requireTickingRole(input.role)
      return write(() => {
        const row = selectLease.get(of) as Row | undefined
        if (!row) throw new Refused(`nobody holds the ${of} lease`)
        requireRetired(of, String(row.thread_id), input)
        deleteLease.run(of)
        record('lease_released', role, null, String(row.thread_id), { role: of })
        return { released: leaseOf(row) }
      })
    },

    statusRead(role: Role, of: TickingRole = 'afk') {
      permit(role, 'status_read')
      const row = selectStatus.get(of) as Row | undefined
      const counts = Object.fromEntries((countSlots.all() as Row[]).map((count) => [String(count.state), Number(count.n)]))
      const used = counts.running ?? 0
      const cap = row?.slot_cap === null || row?.slot_cap === undefined ? null : Number(row.slot_cap)
      const pending_approvals = Object.fromEntries((selectApprovals.all() as Row[]).map((slot) => [String(slot.issue), Number(slot.pending_approvals)]))
      const hostCaps = hostCapsOf(row)
      const perHost = runningByHost(exemptReposOf(row), true)
      const slots = {
        cap,
        used,
        free: cap === null ? null : Math.max(0, cap - used),
        hosts: Object.fromEntries(HOSTS.map((host) => [host, { used: perHost[host], cap: hostCaps?.[host] ?? null }])),
        parked: counts.parked ?? 0,
        ready: counts.ready ?? 0,
        awaiting_ci: counts.awaiting_ci ?? 0,
        awaiting_ci_cap: awaitingCiCap(),
        pending_approvals,
        budget_exempt_running: (selectRunning.all() as Row[]).filter((slot) => Number(slot.budget_exempt) === 1).length,
      }
      const cadence_minutes = cadenceMs / 60_000
      const ticks = (since: number) => {
        const counts = Object.fromEntries((countTicks.all(of, since) as Row[]).map((count) => [String(count.recorded_by), Number(count.n)]))
        return { model: counts.model ?? 0, client: counts.client ?? 0 }
      }
      const wakeThread = holderOf(of) ?? (row ? String(row.thread_id) : null)
      const wakeRow = wakeThread === null ? undefined : (selectWake.get(of, wakeThread) as Row | undefined)
      const pendingSince = wakeRow?.pending_since == null ? null : Number(wakeRow.pending_since)
      const tickProvenance = {
        // Model ticks are counted from the argus#831 migration; earlier ticks were not logged.
        ticks: { last_7_days: ticks(now() - TICK_COUNT_WINDOW_MS), all_time: ticks(0) },
        wake: {
          thread_id: wakeThread,
          last_wake_at: wakeRow ? iso(Number(wakeRow.last_wake_at)) : null,
          last_reason: wakeRow ? String(wakeRow.last_reason) : null,
          pending_since: pendingSince === null ? null : iso(pendingSince),
          ack_due_at: pendingSince === null ? null : iso(pendingSince + WAKE_ACK_MS),
          unanswered: wakeThread !== null && wakeUnanswered(of, wakeThread),
        },
      }

      if (!row) {
        return {
          role: of,
          thread_id: null,
          last_tick_at: null,
          directives_version: null,
          needs_owner: [],
          errors: [],
          pressure: {
            level: 'unknown',
            window_used_percent: null,
            weekly_used_percent: null,
            weekly_resets_at: null,
            weekly_pace: null,
            burn_per_day: null,
            allowance_per_day: null,
            budget_ratio: null,
            budget_rung: null,
            budget_rung_held: false,
            reserve_percent: null,
            effective_slot_cap: null,
          },
          slots,
          liveness: { state: livenessState(of), missed_ticks: null, cadence_minutes, next_due_at: null },
          last_activity_at: null,
          last_model_tick_at: null,
          last_tick_recorded_by: null,
          ...tickProvenance,
        }
      }

      const weekly = weeklyOf(row)
      const lastTick = Number(row.last_tick_at)
      const lastSeen = lastSeenOf(of, row)
      const missed = missedSince(lastSeen)
      const state = livenessState(of)
      const lease = selectLease.get(of) as Row | undefined
      const activityAt = lease ? holderActivityAt(of, String(lease.thread_id)) : null
      return {
        role: of,
        thread_id: String(row.thread_id),
        last_tick_at: iso(lastTick),
        last_activity_at: activityAt === null ? null : iso(activityAt),
        last_model_tick_at: row.last_model_tick_at === null ? null : iso(Number(row.last_model_tick_at)),
        last_tick_recorded_by: String(row.last_recorded_by) as TickRecorder,
        directives_version: String(row.directives_version),
        needs_owner: JSON.parse(String(row.needs_owner)) as string[],
        errors: JSON.parse(String(row.errors)) as string[],
        pressure: {
          level: pressureOf(row).level,
          window_used_percent: row.window_used_percent === null ? null : Number(row.window_used_percent),
          weekly_used_percent: weekly?.used ?? null,
          weekly_resets_at: weekly ? iso(weekly.resetsAt) : null,
          weekly_pace: weekly?.pace ?? null,
          burn_per_day: weekly?.burnPerDay ?? null,
          allowance_per_day: weekly?.allowancePerDay ?? null,
          budget_ratio: weekly?.ratio ?? null,
          budget_rung: weekly?.rung ?? null,
          budget_rung_held: weekly?.held ?? false,
          reserve_percent: weekly?.reservePercent ?? null,
          effective_slot_cap: effectiveSlotCap(cap, weekly),
          budget_exempt_repos: exemptReposOf(row),
          budget_exempt_issues: exemptIssuesOfDirectives(),
        },
        slots,
        liveness: { state, missed_ticks: missed, cadence_minutes, next_due_at: iso(lastSeen + cadenceMs) },
        ...tickProvenance,
      }
    },

    childStart(role: Role, input: { thread_id: string; purpose: string; issue?: string }): { child: Child } {
      permit(role, 'child_start')
      requireText(input.thread_id, 'thread_id')
      requireText(input.purpose, 'purpose')
      if (input.issue !== undefined) requireIssue(input.issue)
      return write(() => {
        if (selectChild.get(input.thread_id)) throw new Refused(`child ${input.thread_id} is already in the ledger`)
        db.prepare('INSERT INTO ledger_children (thread_id, purpose, issue, started_at) VALUES (?, ?, ?, ?)').run(
          input.thread_id,
          input.purpose,
          input.issue ?? null,
          now(),
        )
        recordLedger('child_started', input.thread_id, { issue: input.issue ?? null })
        touchHolder('direction', holderOf('direction'))
        return { child: toChild(selectChild.get(input.thread_id) as Row) }
      })
    },

    childClose(role: Role, input: { thread_id: string; outcome: ChildOutcome; note?: string }): { child: Child } {
      permit(role, 'child_close')
      return write(() => {
        const row = selectChild.get(input.thread_id) as Row | undefined
        if (!row) throw new Refused(`no child ${input.thread_id} in the ledger`)
        if (row.closed_at !== null) throw new Refused(`child ${input.thread_id} is already closed (${String(row.outcome)})`)
        db.prepare('UPDATE ledger_children SET closed_at = ?, outcome = ?, note = ? WHERE thread_id = ?').run(
          now(),
          input.outcome,
          input.note ?? null,
          input.thread_id,
        )
        recordLedger('child_closed', input.thread_id, { outcome: input.outcome })
        touchHolder('direction', holderOf('direction'))
        return { child: toChild(selectChild.get(input.thread_id) as Row) }
      })
    },

    /**
     * argus#51: a call that names its own thread (`caller_thread_id`, or `thread_id` on a tick or
     * a worker's slot call) is checked against X-T3-Thread-Id, the thread id the harness's
     * headersHelper sends from the session's own environment. The argument is self-asserted and a
     * fork inherits its parent's id; the header is not, so a fork naming its parent is refused and
     * leaves a lease_conflict event for the holder's next gate. Returns the thread id the call acts
     * as: the header when sent (so omitting `caller_thread_id` does not skip the lease check),
     * else what the call named. With no header the call is accepted until `requireThreadHeader`
     * is on, once every caller sends it; the first such call per thread is logged.
     */
    checkCallerThread(role: Role, tool: ToolName, named: string | undefined, header: string | undefined): string | undefined {
      if (header === undefined) {
        if (options.requireThreadHeader) {
          throw new Refused(`${tool} needs the X-T3-Thread-Id header: the session's headersHelper sends it, so the call cannot name another thread. Update the helper and reconnect the MCP server.`)
        }
        const key = `${role}:${named ?? ''}`
        if (named !== undefined && named !== '' && !headerMissingSeen.has(key)) {
          headerMissingSeen.add(key)
          warn(`loop-state-mcp: ${role} call ${tool} from ${named} sent no X-T3-Thread-Id, so its thread id is self-asserted`)
        }
        return named
      }
      if (named === undefined || named === '' || named === header) return header
      write(() => {
        record('lease_conflict', role, null, header, { role, tool, named, header, reason: 'thread_header_mismatch' }, 'direction')
        throw new LeaseRefused(
          `${tool} names thread ${named}, but this session is ${header} (X-T3-Thread-Id): refused. A forked thread must pass its own thread id, not its parent's.`,
        )
      })
      return header
    },

    /**
     * An owner turn in Aquila's thread: sets last_owner_turn, and hands over the "since you
     * left" record once. `stepping_away` switches to away at once. `caller_thread_id` must be
     * the direction lease holder (argus#1042).
     */
    ownerTurn(
      role: Role,
      input: { stepping_away?: boolean; caller_thread_id?: string } = {},
    ): { owner: OwnerPresence; since_you_left: AwayNote[]; warning?: string } {
      permit(role, 'owner_turn')
      return write(() => {
        const warning = requireDirectionLease(role, input.caller_thread_id)
        const at = now()
        db.prepare(
          `INSERT INTO ledger_owner (id, last_turn_at, stepped_away) VALUES (1, ?, ?)
           ON CONFLICT (id) DO UPDATE SET last_turn_at = excluded.last_turn_at, stepped_away = excluded.stepped_away`,
        ).run(at, input.stepping_away ? 1 : 0)
        const notes = (selectPendingNotes.all() as Row[]).map(toAwayNote)
        db.prepare('UPDATE ledger_away_notes SET presented_at = ? WHERE presented_at IS NULL').run(at)
        recordLedger('owner_turn', null, { stepping_away: input.stepping_away === true })
        return warning === null ? { owner: ownerPresence(), since_you_left: notes } : { owner: ownerPresence(), since_you_left: notes, warning }
      })
    },

    /**
     * argus#54: register the owner chat of a host, so the tick thread can hold the direction lease while the
     * owner chat still counts for presence (owner_turn). Only the direction holder, in a turn the owner is
     * driving. It is kept apart from the lease row: lease_move, lease_release, lease_failover and lease_reclaim
     * leave it alone.
     */
    ownerThreadSet(role: Role, input: { host: string; thread_id: string; caller_thread_id?: string }): { owner_threads: Record<Host, string | null> } {
      permit(role, 'owner_thread_set')
      requireHost(input.host)
      requireText(input.thread_id, 'thread_id')
      return write(() => {
        requireDirectionLease(role, input.caller_thread_id, 'owner_thread_set')
        const presence = ownerPresence()
        if (!presence.present) {
          const last = presence.stepped_away ? 'the owner stepped away' : presence.last_turn_at ? `the last owner turn was ${presence.last_turn_at}` : 'no owner turn is recorded'
          throw new Refused(`the owner is not present (${last}): the owner thread is registered only in a turn the owner is driving. Call owner_turn on the owner's turn, then register it.`)
        }
        const previous = optionalText((selectOwnerThreadByHost.get(input.host) as Row | undefined)?.thread_id)
        upsertOwnerThread.run(input.host, input.thread_id, now())
        recordLedger('owner_thread_set', input.caller_thread_id as string, { host: input.host, thread_id: input.thread_id, previous })
        return { owner_threads: this.leaseRead(role).owner_threads as Record<Host, string | null> }
      })
    },

    /**
     * argus#54: refuse a write whose caller is a registered owner thread (and not the holder). The owner chat
     * calls owner_turn and nothing else; every other loop-state write is the tick thread's. Names the holder and
     * leaves a lease_conflict event for the holder's next gate, as a stray thread's refusal does. `threadIds` are
     * the session's X-T3-Thread-Id and any thread the call names. A call from no registered owner thread is not
     * touched, so with no `owner_thread_set` ever called this changes nothing.
     */
    refuseOwnerThread(role: Role, tool: string, threadIds: (string | undefined)[]): void {
      const named = threadIds.filter((id): id is string => id !== undefined && id !== '' && isOwnerThread(id))
      if (named.length === 0) return
      write(() => {
        const holder = holderOf('direction')
        const caller = named.find((id) => id !== holder)
        if (caller === undefined) return
        record('lease_conflict', role, null, caller, { role, holder, tool, reason: 'owner_thread_write' }, 'direction')
        const who = holder === null ? 'no thread holds the direction lease' : `the direction lease is held by ${holder}`
        throw new LeaseRefused(`${who}, not ${caller}: ${tool} is refused. ${caller} is the registered owner chat; it calls owner_turn and makes no other loop-state write.`)
      })
    },

    awayNote(role: Role, input: { text: string; issue?: string }): { note: AwayNote } {
      permit(role, 'away_note')
      requireText(input.text, 'text')
      if (input.issue !== undefined) requireIssue(input.issue)
      return write(() => {
        db.prepare('INSERT INTO ledger_away_notes (at, text, issue) VALUES (?, ?, ?)').run(now(), input.text, input.issue ?? null)
        recordLedger('away_noted', null, { issue: input.issue ?? null })
        return { note: { at: iso(now()), text: input.text, issue: input.issue ?? null } }
      })
    },

    /**
     * Once-only notifications: returns the items not yet notified for a class and records them,
     * so Aquila sends one push batching them. A class gets at most one push per tick: a second
     * claim before Aquila's next recorded tick returns its new items as deferred, unrecorded.
     */
    notifyClaim(role: Role, input: { class: NotifyClass; items: string[] }): { push: boolean; items: string[]; deferred: string[] } {
      permit(role, 'notify_claim')
      if (!(NOTIFY_CLASSES as readonly string[]).includes(input.class)) throw new Refused(`unknown notification class "${input.class}"`)
      const items = [...new Set(input.items.map((item) => requireText(item, 'item').trim()))]
      return write(() => {
        const fresh = items.filter((item) => !selectNotified.get(input.class, item))
        if (fresh.length === 0) return { push: false, items: [], deferred: [] }
        if (selectPushThisTick.get(input.class)) return { push: false, items: [], deferred: fresh }
        const insert = db.prepare('INSERT INTO ledger_notified (class, item, notified_at) VALUES (?, ?, ?)')
        for (const item of fresh) insert.run(input.class, item, now())
        recordLedger('notified', null, { class: input.class, items: fresh })
        return { push: true, items: fresh, deferred: [] }
      })
    },

    /**
     * Stall-outage state: report whether the AFK loop is stalled right now. Returns `outage`
     * the first time it is (one push per outage), `recovery` the first time it is not after
     * that, and null otherwise.
     */
    outageObserve(role: Role, input: { stalled: boolean; reason?: string }): { notify: 'outage' | 'recovery' | null; outage: Outage | null } {
      permit(role, 'outage_observe')
      if (input.stalled) requireText(input.reason ?? '', 'reason')
      return write(() => {
        const open = selectOpenOutage.get() as Row | undefined
        if (input.stalled) {
          if (open) return { notify: null, outage: toOutage(open) }
          db.prepare('INSERT INTO ledger_outages (reason, opened_at) VALUES (?, ?)').run(input.reason as string, now())
          recordLedger('outage_opened', null, { reason: input.reason })
          return { notify: 'outage', outage: toOutage(selectOpenOutage.get() as Row) }
        }
        if (!open) return { notify: null, outage: null }
        db.prepare('UPDATE ledger_outages SET closed_at = ? WHERE id = ?').run(now(), Number(open.id))
        recordLedger('outage_closed', null, { reason: String(open.reason) })
        return { notify: 'recovery', outage: { ...toOutage(open), closed_at: iso(now()) } }
      })
    },

    ledgerRead(role: Role, options: { include_closed?: boolean } = {}) {
      permit(role, 'ledger_read')
      const children = db
        .prepare(`SELECT * FROM ledger_children ${options.include_closed ? '' : 'WHERE closed_at IS NULL'} ORDER BY started_at, thread_id`)
        .all() as Row[]
      const outage = selectOpenOutage.get() as Row | undefined
      return {
        owner: ownerPresence(),
        children: children.map(toChild),
        since_you_left: (selectPendingNotes.all() as Row[]).map(toAwayNote),
        outage: outage ? toOutage(outage) : null,
      }
    },

    /**
     * The directives record: the current version, one named by `version`, and with `history` the
     * summary of every version, newest first. Null when none has been set or imported.
     */
    directivesRead(role: Role, input: { version?: number; history?: boolean } = {}): { directives: DirectivesEntry | null; history?: DirectivesSummary[] } {
      permit(role, 'directives_read')
      const row = (input.version === undefined ? selectCurrentDirectives.get() : selectDirectives.get(input.version)) as Row | undefined
      if (!row && input.version !== undefined) throw new Refused(`no directives version ${input.version}`)
      const directives = row ? toDirectives(row) : null
      return input.history ? { directives, history: (selectDirectivesHistory.all() as Row[]).map(toDirectivesSummary) } : { directives }
    },

    /**
     * Set the directives: a new version, numbered by the server. Accepted only from the thread
     * holding the direction lease, in a turn the owner is driving (owner_turn within the
     * presence window, not stepped away), against the version the caller last read.
     */
    directivesSet(
      role: Role,
      input: { record: unknown; reason: string; expected_version: number; caller_thread_id?: string },
    ): { directives: DirectivesEntry } {
      permit(role, 'directives_set')
      const body = requireValidDirectives(input.record)
      requireText(input.reason, 'reason')
      if (!Number.isInteger(input.expected_version) || input.expected_version < 0) {
        throw new Refused('expected_version must be the version you last read (0 when none has been set)')
      }
      return write(() => {
        requireDirectionLease(role, input.caller_thread_id, 'directives_set')
        const presence = ownerPresence()
        if (!presence.present) {
          const last = presence.stepped_away ? 'the owner stepped away' : presence.last_turn_at ? `the last owner turn was ${presence.last_turn_at}` : 'no owner turn is recorded'
          throw new Refused(`the owner is not present (${last}): directives change only in a turn the owner is driving. Call owner_turn on the owner's turn, then set them.`)
        }
        const current = currentDirectivesVersion()
        if (input.expected_version !== current) {
          throw new Refused(`directives changed since you read them: the current version is ${current}, not ${input.expected_version}. Read them again and re-apply the change.`)
        }
        const version = current + 1
        insertDirectives.run(version, JSON.stringify(body), now(), input.caller_thread_id as string, 'owner', input.reason)
        record('directives_set', role, null, input.caller_thread_id as string, { version, reason: input.reason })
        return { directives: toDirectives(selectDirectives.get(version) as Row) }
      })
    },

    /**
     * The one-off import from the directives file: records each version the file carried, in
     * order, keeping its number. Not a tool and not role-checked: the owner runs it on the host
     * (import-directives.ts). Each version must be above the one before it, and the whole call
     * writes nothing if any is invalid.
     */
    directivesImport(entries: { version: number; record: unknown; reason: string }[]): { imported: number[]; current: number } {
      for (const entry of entries) {
        if (!Number.isInteger(entry.version) || entry.version <= 0) throw new Refused(`version must be a positive whole number, got ${String(entry.version)}`)
        requireValidDirectives(entry.record)
      }
      return write(() => {
        const imported: number[] = []
        for (const entry of entries) {
          const current = currentDirectivesVersion()
          if (entry.version <= current) throw new Refused(`version ${entry.version} is not above the current ${current}`)
          insertDirectives.run(entry.version, JSON.stringify(entry.record), now(), null, 'import', entry.reason)
          record('directives_set', 'direction', null, null, { version: entry.version, source: 'import' })
          imported.push(entry.version)
        }
        return { imported, current: currentDirectivesVersion() }
      })
    },

    close(): void {
      db.close()
    },
  }
}

/** Each step re-reads the version under the write lock, so two processes opening a fresh file cannot both apply it. */
function migrate(db: DatabaseSync) {
  for (;;) {
    db.exec('BEGIN IMMEDIATE')
    try {
      const version = Number((db.prepare('PRAGMA user_version').get() as Row).user_version)
      const step = MIGRATIONS[version]
      if (step === undefined) {
        db.exec('COMMIT')
        return
      }
      db.exec(step)
      db.exec(`PRAGMA user_version = ${version + 1}`)
      db.exec('COMMIT')
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  }
}
