import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'

import { THREAD_STATES } from './rebuild.js'
import type { Role } from './roles.js'
import {
  CHILD_OUTCOMES,
  HOSTS,
  NOTIFY_CLASSES,
  PRESSURE_LEVELS,
  REPORT_OUTCOMES,
  Refused,
  SLOT_STATES,
  TOOL_ROLES,
  type Store,
  type ToolName,
} from './store.js'

const INSTRUCTIONS = `The loop-state db shared by the AFK backlog loop and Aquila: slots, loop status, the quiet-tick gate, leases and Aquila's ledger.
Your role comes from the token in your MCP config, and you see only the tools your role may call.
Each orchestrator role (afk, direction) has one lease; only the holding thread's ticks count. A homelab standby takes a lease only while its WSL2 holder is stalled (lease_failover), and the primary takes it back (lease_reclaim).
A slot is one issue a worker thread is on: running, parked (waiting on the owner's needs:owner answer), ready (un-parked, waiting for a free slot) or awaiting_ci (its PR's checks are running; it counts toward no cap).
Results are JSON. Times are ISO 8601 UTC. An issue is named owner/repo#number.`

const json = (value: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }] })
const failure = (value: string) => ({ content: [{ type: 'text' as const, text: value }], isError: true })

/** Turn a refusal into a tool error the agent can read; anything else is a real fault. */
function guarded<A>(handler: (args: A) => unknown) {
  return async (args: A) => {
    try {
      return json(handler(args))
    } catch (error) {
      if (error instanceof Refused) return failure(error.message)
      throw error
    }
  }
}

const issue = z.string().describe('The issue, as owner/repo#number (e.g. deanjstone/argus#701).')
const threadId = z.string().describe('A T3 thread id.')
const hostField = z.enum(HOSTS)

const callerThreadId = z
  .string()
  .optional()
  .describe(
    'Your own T3 thread id. A slot write counts only from the thread holding the afk lease: any other thread is refused, naming the holder. Always pass it; a call without it is accepted with a warning for now and will be refused in a later release.',
  )
const drainHost = hostField
  .optional()
  .describe(
    "Your own host. A thread that does not hold the lease may still wind down slots on its own host (the homelab standby's drain): it passes its host and the slot's host must match. Never for slot_start.",
  )

const tickInput = {
  thread_id: z.string().describe('Your own T3 thread id.'),
  directives_version: z.string().describe('The version of the directives file this tick read.'),
  needs_owner: z
    .array(z.string())
    .describe('Every open needs:owner issue (owner/repo#number), from one gh search. Order does not matter.'),
  slot_cap: z.number().int().min(0).optional().describe('The total slot cap from the directives file (the name before ladder v2; total_cap is the same field and wins if both are given).'),
  total_cap: z.number().int().min(0).optional().describe('The total slot cap from the directives file: the sum of the host caps. Quota rungs lower it to 1.'),
  host_caps: z
    .object({ wsl2: z.number().int().min(0).optional(), homelab: z.number().int().min(0).optional() })
    .strict()
    .optional()
    .describe('Per-host slot caps from the directives file. slot_start is refused past the starting host\'s cap as well as the total. A host left out has no cap of its own; a status_tick that omits this records none.'),
  budget_exempt_repos: z
    .array(z.string())
    .optional()
    .describe('Repos (owner/repo) in the directives\' budget_exempt_repos: a running slot in one sits outside the total cap, the effective cap and the host caps: it is not counted when any slot starts, and its own start skips those caps. A listed repo keeps one running slot (a second start in it is refused), and no_new_slots and gate_only still refuse its starts. tick_gate carries the last list forward when it is omitted; a status_tick that omits it records none.'),
  reserve_percent: z
    .number()
    .min(0)
    .lt(100)
    .optional()
    .describe('The share of the week held back, from the directives file; default 10. The loop plans as if the week ends at 100 - reserve % used.'),
  errors: z.array(z.string()).optional().describe('Errors this tick hit, one line each.'),
  window_used_percent: z
    .number()
    .min(0)
    .max(100)
    .optional()
    .describe('The 5-hour window used, 0-100. The pressure level is derived from it.'),
  pressure: z
    .enum(PRESSURE_LEVELS)
    .optional()
    .describe('The window ladder level, when no percentage is available. Must agree with window_used_percent if both are given.'),
  weekly_used_percent: z
    .number()
    .optional()
    .describe('The week used, 0-100 (the usage endpoint\'s seven_day). Give it with weekly_resets_at. The remaining-budget ladder is derived from it (burn per day against what the rest of the week allows; gate_only once 100 - reserve_percent is used): the effective pressure level is the stricter of this and the window ladder.'),
  weekly_resets_at: z
    .string()
    .optional()
    .describe('When the week resets, ISO 8601 UTC (the usage endpoint\'s seven_day.resets_at). The week started 7 days before it.'),
}

const pendingApprovals = z
  .record(z.string(), z.number().int().min(0))
  .optional()
  .describe(
    'Per running slot, the pendingRequestCount of its worker thread from t3_thread_read, keyed by issue (owner/repo#number). An issue left out keeps its last count; 0 clears it. Parking, closing or freeing a slot clears it too. Any running slot above 0 wakes the AFK thread through POST /wake/check.',
  )

/** One server per request: the transport is stateless, and the caller's role differs per request. */
export function createMcpServer(store: Store, role: Role, threadHeader?: string): McpServer {
  const server = new McpServer({ name: 'loop-state', version: '0.1.0' }, { instructions: INSTRUCTIONS })
  const offered = (tool: ToolName) => (TOOL_ROLES[tool] as readonly Role[]).includes(role)
  /**
   * argus#54: a registered owner thread (owner_thread_set) makes no loop-state write but owner_turn. Every
   * write tool but that one checks the session's own thread id, and any thread the call names, against it.
   */
  const registerTool = server.registerTool.bind(server) as unknown as (
    name: string,
    config: { annotations?: { readOnlyHint?: boolean } },
    handler: (...params: unknown[]) => unknown,
  ) => unknown
  server.registerTool = ((name: string, config: { annotations?: { readOnlyHint?: boolean } }, handler: (...params: unknown[]) => unknown) =>
    registerTool(
      name,
      config,
      config.annotations?.readOnlyHint === false && name !== 'owner_turn'
        ? async (...params: unknown[]) => {
            // A tool with an input schema gets (args, extra); one without gets (extra): `extra` has no thread fields.
            const args = (params[0] ?? {}) as Record<string, unknown>
            const named = (field: string) => (typeof args[field] === 'string' ? (args[field] as string) : undefined)
            try {
              store.refuseOwnerThread(role, name, [threadHeader, named('thread_id'), named('caller_thread_id')])
            } catch (error) {
              if (error instanceof Refused) return failure(error.message)
              throw error
            }
            return handler(...params)
          }
        : handler,
    )) as typeof server.registerTool
  /**
   * argus#51: the thread id a call acts as. A call naming a thread other than the session's own
   * (X-T3-Thread-Id) is refused; with the header and no named thread, the header is the caller.
   */
  const actingAs = (tool: ToolName, named: string | undefined) => store.checkCallerThread(role, tool, named, threadHeader)
  const withCaller = <A extends { caller_thread_id?: string | undefined }>(tool: ToolName, args: A): A => ({
    ...args,
    caller_thread_id: actingAs(tool, args.caller_thread_id),
  })

  if (offered('slot_start')) {
    server.registerTool(
      'slot_start',
      {
        title: 'Start a slot',
        description:
          'Put a worker thread on an issue. Refused if the issue already holds a running slot, or is parked; a ready (un-parked) issue resumes here with its new thread. Also refused when the last recorded AFK tick put the effective pressure at no_new_slots or gate_only, or the running slots already fill the effective slot cap (the directives total cap; 0 once the budget ladder reaches no_new_slots), or the starting host already runs its own cap. Running slots in a repo in budget_exempt_repos are not counted toward any of those caps, and a start in such a repo skips them; it is refused only if that repo already runs a slot. Pass budget_exempt: true for an issue labelled efficiency:orchestrator (argus#1171): the start is allowed at no_new_slots but still refused at gate_only, skips every cap, is not counted toward them while it runs, and only one budget-exempt slot runs at a time. Use Sonnet or Haiku for it. An issue in the directives\' budget_exempt_issues (argus#60) needs no flag: the server passes it at no_new_slots and gate_only, outside every cap, one such issue running at a time; slot_list shows budget_exempt on each slot. argus#73: a live lift_budget_rung override in the directives lifts a budget rung of no_opus or no_new_slots (never gate_only) while the week used is under its ceiling: the effective cap becomes the override\'s slots, bounded by the total cap, and only its models (Sonnet, Haiku) may start; status_read pressure shows budget_override_until and budget_override_active.',
        inputSchema: {
          issue,
          thread_id: threadId.describe('The worker thread taking the issue.'),
          host: hostField.optional().describe("The host whose T3 runs the worker: your own. Default wsl2; a homelab standby passes homelab."),
          caller_thread_id: callerThreadId,
          budget_exempt: z
            .boolean()
            .optional()
            .describe('True when the issue is labelled efficiency:orchestrator: passes no_new_slots, refused at gate_only, outside every cap, one running at a time.'),
          model: z
            .string()
            .optional()
            .describe('The model the worker runs on (e.g. claude-sonnet-5-5). While a lift_budget_rung override is what lifts the budget rung, a start naming a model outside the override\'s models is refused; leaving it out is accepted.'),
        },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
      },
      guarded((args) => store.slotStart(role, args.issue, args.thread_id, args.host, actingAs('slot_start', args.caller_thread_id), args.budget_exempt === true, args.model)),
    )
  }

  if (offered('slot_park')) {
    server.registerTool(
      'slot_park',
      {
        title: 'Park a slot',
        description:
          'Park a running slot whose question is now on its issue with needs:owner. The slot stops counting as used; it resumes only after Aquila un-parks it.',
        inputSchema: {
          issue,
          note: z.string().optional().describe('What it is waiting on, one line.'),
          caller_thread_id: callerThreadId,
          host: drainHost,
        },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
      },
      guarded((args) => store.slotPark(role, args.issue, args.note, withCaller('slot_park', args))),
    )
  }

  if (offered('slot_unpark')) {
    server.registerTool(
      'slot_unpark',
      {
        title: 'Un-park a slot',
        description:
          "After relaying the owner's answer and removing needs:owner, mark the parked slot ready. The AFK loop resumes ready slots ahead of new work. Aquila's other slot write is slot_resume_ci.",
        inputSchema: { issue, note: z.string().optional().describe('The answer relayed, one line.') },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
      },
      guarded((args) => ({ slot: store.slotUnpark(role, args.issue, args.note) })),
    )
  }

  if (offered('slot_report')) {
    server.registerTool(
      'slot_report',
      {
        title: 'Report on your slot',
        description:
          "Record your outcome on the slot you hold, then send the orchestrator a content-free nudge. The report is the record; the AFK loop verifies it and moves the slot on its next tick.",
        inputSchema: {
          issue,
          thread_id: threadId.describe('Your own thread id; it must be the thread holding the slot.'),
          outcome: z.enum(REPORT_OUTCOMES),
          note: z.string().optional().describe('One line: what happened, or the question you parked on.'),
          pr: z.string().optional().describe('The PR URL, if there is one.'),
        },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
      },
      guarded((args) => {
        actingAs('slot_report', args.thread_id)
        return { slot: store.slotReport(role, args) }
      }),
    )
  }

  if (offered('slot_await_ci')) {
    server.registerTool(
      'slot_await_ci',
      {
        title: 'Release your slot while CI runs',
        description:
          "Once your PR is open and its checks have started (or your trunk push is made), call this and end your turn instead of waiting. Your slot becomes awaiting_ci: it counts toward no cap, so the next issue can start, and Aquila watches the checks. When they finish Aquila wakes you in this thread: on green merge your own PR and report; on red fix it here. Refused when awaiting_ci_cap slots (default 3) already wait: keep your slot and wait for the checks as before. ref is the PR URL, the SHA you pushed to the issue's own trunk repo's main, or owner/repo@<40-hex sha> for a push to another repo (one ref per slot: name the last push).",
        inputSchema: {
          issue,
          thread_id: threadId.describe('Your own thread id; it must be the thread holding the slot.'),
          ref: z.string().describe('The PR URL (https://github.com/owner/repo/pull/N), the pushed commit SHA, or owner/repo@<40-hex sha> for a push in another repo.'),
          note: z.string().optional().describe('One line: what is waiting, e.g. "checks started on the PR".'),
        },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
      },
      guarded((args) => {
        actingAs('slot_await_ci', args.thread_id)
        return { slot: store.slotAwaitCi(role, args) }
      }),
    )
  }

  if (offered('slot_resume_ci')) {
    server.registerTool(
      'slot_resume_ci',
      {
        title: 'Resume an awaiting_ci slot',
        description:
          "When an awaiting_ci slot's checks have finished (green or red), move it back: running if the effective total cap and its host's cap have room, else ready, where it waits for a free slot like an un-parked one. Pressure does not stop it. Returns resumed false and the reason for ready. Pass report_only: true for a green trunk slot that has nothing left to build, only a Resolution to post: it skips the total, effective and host caps and always goes to running (refused unless note starts with \"checks green\"; a red resume stays capped). Then wake the worker in its own thread; run the memory gate first. Never merge the worker's PR.",
        inputSchema: {
          issue,
          note: z.string().optional().describe('The checks result, one line: "checks green" or "checks red: <job>".'),
          report_only: z
            .boolean()
            .optional()
            .describe('true: skip the slot caps for a green resume whose worker only reports. Needs note to start with "checks green".'),
        },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
      },
      guarded((args) => store.slotResumeCi(role, args.issue, args.note, args.report_only === true)),
    )
  }

  if (offered('slot_close')) {
    server.registerTool(
      'slot_close',
      {
        title: 'Close a verified slot',
        description:
          'Close a running or ready slot whose issue is done and verified, freeing it (a ready slot runs nothing, so no cap check applies). verified is the closeout Resolution\'s "Verified:" line with its evidence. Answers with the slot as state "closed" (previous_state, verified, closed_at).',
        inputSchema: { issue, verified: z.string().describe('The "Verified: …" line.'), caller_thread_id: callerThreadId, host: drainHost },
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
      },
      guarded((args) => store.slotClose(role, args.issue, args.verified, withCaller('slot_close', args))),
    )
  }

  if (offered('slot_free')) {
    server.registerTool(
      'slot_free',
      {
        title: 'Free a slot',
        description: 'Release a slot in any state without closing its issue: the worker is gone, the question was withdrawn, or the slot is stale. Answers with the slot as state "freed" (previous_state, reason, freed_at).',
        inputSchema: { issue, reason: z.string().describe('Why, one line.'), caller_thread_id: callerThreadId, host: drainHost },
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
      },
      guarded((args) => store.slotFree(role, args.issue, args.reason, withCaller('slot_free', args))),
    )
  }

  server.registerTool(
    'slot_list',
    {
      title: 'List slots',
      description: 'Every current slot, oldest first, with its thread, state and any worker report.',
      inputSchema: { state: z.enum(SLOT_STATES).optional() },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
    guarded((args) => ({ slots: store.slotList(role, args.state) })),
  )

  if (offered('slot_rebuild')) {
    server.registerTool(
      'slot_rebuild',
      {
        title: 'Rebuild slots from GitHub',
        description:
          "Set the slots against what GitHub and T3 show: pass every open issue assigned to the loop or labelled needs:owner (one gh search), and every thread from t3_thread_list. Assigned + needs:owner is parked; assigned with a live worker is running; an answered parked slot is ready. Returns the add/update/remove changes, orphaned issues (assigned, worker gone), unresolved ones (no worker tied to them) and idle workers to nudge. Compare-only unless apply is true: a compare writes nothing. agrees true means the db matches. Aquila can apply only while no AFK thread holds the afk lease (seeding at the cut).",
        inputSchema: {
          issues: z
            .array(
              z.object({
                issue,
                assigned: z.boolean().describe('Assigned to the loop: the public mirror of a slot.'),
                needs_owner: z.boolean().describe('Labelled needs:owner.'),
                claimed_by: threadId.optional().describe("The worker thread in the issue's claim line, if any."),
              }),
            )
            .describe('Every open issue assigned to the loop or labelled needs:owner. A slot whose issue is missing here is removed.'),
          threads: z
            .array(
              z.object({
                thread_id: threadId,
                state: z.enum(THREAD_STATES).describe('running (a turn is active), idle, settled or archived.'),
                issue: issue.optional().describe('The issue the thread works on, when its title or branch names one.'),
              }),
            )
            .describe('Every thread from t3_thread_list, archived ones included. A thread missing here counts as gone.'),
          apply: z.boolean().optional().describe('Write the changes. Default false: compare only. An apply by the afk role needs the afk lease; a compare does not.'),
          caller_thread_id: callerThreadId,
          host: hostField
            .optional()
            .describe("Your host. Pass it whenever two hosts run workers: the other host's slots and their issues are left out of the plan, because its threads are not in your T3 list."),
        },
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
      },
      guarded((args) => store.slotRebuild(role, { issues: args.issues, threads: args.threads }, args.apply ?? false, args.host, actingAs('slot_rebuild', args.caller_thread_id))),
    )
  }

  if (offered('status_tick')) {
    server.registerTool(
      'status_tick',
      {
        title: 'Record a tick',
        description:
          "The last step of a full tick: record what it saw. This is your role's loop status, and the baseline the next tick_gate compares against. Recorded only if your thread holds your role's lease: holds_lease false means you are not the live thread, so end the turn without re-arming.",
        inputSchema: { ...tickInput, pending_approvals: pendingApprovals },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
      },
      guarded((args) => {
        actingAs('status_tick', args.thread_id)
        const tick = store.statusTick(role, args)
        return tick.recorded ? { ...tick, ...store.statusRead(role, role === 'direction' ? 'direction' : 'afk') } : tick
      }),
    )
  }

  if (offered('tick_gate')) {
    server.registerTool(
      'tick_gate',
      {
        title: 'Quiet-tick gate',
        description:
          'The first call of every tick. Reports whether anything changed since your last recorded tick: the directives version, the needs:owner set, the effective pressure level (window and weekly ladders), or a slot event by anyone. If nothing changed it records this tick itself (omitted fields carry forward), so re-arm and end the turn. If something changed, run the full checklist and finish with status_tick. If holds_lease is false, your thread does not hold your role lease: nothing was recorded, so end the turn without re-arming.',
        inputSchema: tickInput,
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
      },
      guarded((args) => {
        actingAs('tick_gate', args.thread_id)
        return store.tickGate(role, args)
      }),
    )
  }

  server.registerTool(
    'status_read',
    {
      title: 'Read loop status',
      description:
        "A role's loop status from its last tick: thread, directives version, slots used and free, errors, pressure (the effective level, the weekly figures, burn and allowance per day, the weekly pace that sets the budget rung, the rung with whether hysteresis holds it, the burn ratio as information, and the effective slot cap), per-host slots used and cap, and liveness (last tick against the cadence; 2 missed ticks is stalled).",
      inputSchema: { role: z.enum(['afk', 'direction']).optional().describe('Whose status. Defaults to afk.') },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
    guarded((args) => store.statusRead(role, args.role)),
  )

  const leaseRole = z.enum(['afk', 'direction']).describe("Whose lease: the AFK loop's or Aquila's.")
  const fromThread = z.string().describe('The thread retiring from the lease (its current holder).')
  const scheduleDeleted = z
    .boolean()
    .optional()
    .describe("true once the retiring thread's schedule_task is deleted. Required whenever the lease is held: retire first.")

  if (offered('lease_read')) {
    server.registerTool(
      'lease_read',
      {
        title: 'Read the leases',
        description: "Which thread holds each orchestrator role's lease, and since when. Only the holder's ticks count.",
        inputSchema: {},
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
      },
      guarded(() => store.leaseRead(role)),
    )
  }

  if (offered('lease_move')) {
    server.registerTool(
      'lease_move',
      {
        title: 'Move a lease',
        description:
          "Give a role's lease to a thread. An unheld lease is taken directly. A held one moves only in the retire-first order: delete the old thread's schedule_task, move the lease here naming the old holder, settle the old thread, then boot the successor.",
        inputSchema: {
          role: leaseRole,
          to_thread_id: threadId.describe('The thread taking the lease.'),
          from_thread_id: fromThread.optional().describe('The current holder. Required when the lease is held.'),
          old_schedule_task_deleted: scheduleDeleted,
          host: hostField.optional().describe("The host the thread taking the lease runs on. Recorded as the lease's primary_host, so a later new thread on that host can lease_reclaim it."),
        },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
      },
      guarded((args) => store.leaseMove(role, args)),
    )
  }

  if (offered('lease_release')) {
    server.registerTool(
      'lease_release',
      {
        title: 'Release a lease',
        description:
          "Rollback: stop a role's thread. Delete its schedule_task, release its lease here, then settle it. No tick for that role counts until the next lease_move.",
        inputSchema: { role: leaseRole, from_thread_id: fromThread, old_schedule_task_deleted: scheduleDeleted },
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
      },
      guarded((args) => store.leaseRelease(role, args)),
    )
  }

  const handover = {
    role: leaseRole,
    to_thread_id: threadId.describe('The thread taking the lease.'),
    from_thread_id: z.string().describe('The current holder.'),
  }

  if (offered('lease_failover')) {
    server.registerTool(
      'lease_failover',
      {
        title: 'Fail a lease over to a standby',
        description:
          "A homelab standby takes a role's lease while its holder is stalled (2+ missed ticks: its host is offline and cannot retire first). Refused while the holder is alive or only late. The primary is kept, so the primary takes it back with lease_reclaim. The afk role may fail over only the afk lease.",
        inputSchema: handover,
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
      },
      guarded((args) => store.leaseFailover(role, args)),
    )
  }

  if (offered('lease_reclaim')) {
    server.registerTool(
      'lease_reclaim',
      {
        title: 'Reclaim a lease from a standby',
        description:
          "The primary takes its failed-over lease back from the standby, at any time once it is back. Refused for any thread but the lease's recorded primary, unless the caller passes host equal to the lease's primary_host (WSL2's primary changes thread id often): that new thread takes the lease and becomes the primary. The standby's next tick sees holds_lease false and drains.",
        inputSchema: {
          ...handover,
          host: hostField.optional().describe("The host the reclaiming thread runs on. A thread other than the recorded primary succeeds when this is the lease's primary_host, and becomes the primary."),
        },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
      },
      guarded((args) => store.leaseReclaim(role, args)),
    )
  }

  if (offered('child_start')) {
    server.registerTool(
      'child_start',
      {
        title: 'Record a child you started',
        description: 'Put a thread you launched or delegated in your ledger. Each tick re-verifies the open children and closes the done ones.',
        inputSchema: {
          thread_id: threadId.describe('The child thread.'),
          purpose: z.string().describe('What it is for, one line.'),
          issue: issue.optional(),
        },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
      },
      guarded((args) => store.childStart(role, args)),
    )
  }

  if (offered('child_close')) {
    server.registerTool(
      'child_close',
      {
        title: 'Close a child',
        description: 'Close a ledger child after verifying its outcome yourself.',
        inputSchema: {
          thread_id: threadId.describe('The child thread.'),
          outcome: z.enum(CHILD_OUTCOMES),
          note: z.string().optional().describe('The evidence or what happened, one line.'),
        },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
      },
      guarded((args) => store.childClose(role, args)),
    )
  }

  if (offered('owner_turn')) {
    server.registerTool(
      'owner_turn',
      {
        title: 'Record an owner turn',
        description:
          'Call at the start of every owner turn (never on a tick). Sets last_owner_turn, so the owner counts as present for 30 minutes, and returns the "since you left" record once, to lead with. Pass stepping_away when the owner says they are stepping away: away starts at once.',
        inputSchema: {
          stepping_away: z.boolean().optional(),
          caller_thread_id: z
            .string()
            .optional()
            .describe(
              'Your own T3 thread id. An owner turn counts only from the thread holding the direction lease: any other thread is refused, naming the holder. Always pass it; a call without it is accepted with a warning for now and will be refused in a later release.',
            ),
        },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
      },
      guarded((args) => store.ownerTurn(role, withCaller('owner_turn', args))),
    )
  }

  if (offered('owner_thread_set')) {
    server.registerTool(
      'owner_thread_set',
      {
        title: 'Register the owner chat',
        description:
          "Register the owner chat of a host (argus#54), for the split tick: the tick thread holds the direction lease and this thread is the owner's, so the owner chat can call owner_turn for presence while it holds nothing. Refused unless your thread holds the direction lease and the owner is present (owner_turn within the last 30 minutes, not stepped away). One thread per host: a new call replaces the host's. lease_move, lease_release, lease_failover and lease_reclaim leave it alone; lease_read shows it as owner_threads. A registered owner thread is refused on every other write, naming the lease holder.",
        inputSchema: {
          host: hostField.describe("The host whose owner chat this is: wsl2 or homelab."),
          thread_id: threadId.describe("The owner chat's T3 thread id."),
          caller_thread_id: z.string().describe('Your own T3 thread id. Required: the direction lease is checked against it.'),
        },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
      },
      guarded((args) => {
        actingAs('owner_thread_set', args.caller_thread_id)
        return store.ownerThreadSet(role, args)
      }),
    )
  }

  if (offered('away_note')) {
    server.registerTool(
      'away_note',
      {
        title: 'Add to "since you left"',
        description: 'Record something done or seen while the owner is away. The owner gets it once, on their next turn.',
        inputSchema: { text: z.string().describe('One line.'), issue: issue.optional() },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
      },
      guarded((args) => store.awayNote(role, args)),
    )
  }

  if (offered('notify_claim')) {
    server.registerTool(
      'notify_claim',
      {
        title: 'Claim a notification',
        description:
          'Before a brrr push: pass every item that qualifies for the class now. Returns the ones never notified (recorded as notified) and whether to push. Send one push batching them. A class gets one push per tick; later new items come back as deferred and wait for the next tick.',
        inputSchema: {
          class: z.enum(NOTIFY_CLASSES),
          items: z.array(z.string()).describe('Item ids: owner/repo#number for needs_owner, a stable id per window for window.'),
        },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
      },
      guarded((args) => store.notifyClaim(role, args)),
    )
  }

  if (offered('outage_observe')) {
    server.registerTool(
      'outage_observe',
      {
        title: 'Observe AFK loop stall state',
        description:
          'Each tick, say whether the AFK loop is stalled (2 missed ticks, db unreachable, lease conflict). notify is "outage" once per outage and "recovery" once when it ends; push only then.',
        inputSchema: {
          stalled: z.boolean(),
          reason: z.string().optional().describe('Why it is stalled, one line. Required when stalled.'),
        },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
      },
      guarded((args) => store.outageObserve(role, args)),
    )
  }

  if (offered('ledger_read')) {
    server.registerTool(
      'ledger_read',
      {
        title: 'Read your ledger',
        description: 'Owner presence and last_owner_turn, open children, the pending "since you left" record, and any open stall outage.',
        inputSchema: { include_closed: z.boolean().optional().describe('Include closed children too.') },
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
      },
      guarded((args) => store.ledgerRead(role, args)),
    )
  }

  if (offered('directives_read')) {
    server.registerTool(
      'directives_read',
      {
        title: 'Read the AFK directives',
        description:
          "The AFK loop's standing orders (caps, holds, ordering, overrides) as the owner last set them: the current version with who set it, when and why, and the record. Pass version for an older one, history for the summary of every version, newest first. directives is null until one is set.",
        inputSchema: {
          version: z.number().int().min(1).optional().describe('An older version. Defaults to the current one.'),
          history: z.boolean().optional().describe('Also list every version (version, when, by whom, source, reason), newest first.'),
        },
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
      },
      guarded((args) => store.directivesRead(role, args)),
    )
  }

  if (offered('directives_set')) {
    server.registerTool(
      'directives_set',
      {
        title: 'Set the AFK directives',
        description:
          "Record a new version of the AFK directives, as the owner told you in this turn. Refused unless your thread holds the direction lease, the owner is present (owner_turn within the last 30 minutes, not stepped away) and expected_version is the version you last read. The whole record is sent every time (the file's front matter without version); the server numbers it and keeps every earlier version. An invalid record is refused with every problem listed. host_gates.<wsl2|homelab> takes max_load, max_io_pressure, max_memory_pressure, max_disk_percent and quiet_window, a string HH:MM-HH:MM in Sydney time (start and end differ, start after end spans midnight); quiet_window is a host_gates key only, never top-level or an override, and the server stores it without applying it to slot_start.",
        inputSchema: {
          record: z.record(z.string(), z.unknown()).describe('The full directives record: cadence_minutes, max_slots, repo_holds, take_next and ordering, plus any optional keys. No version.'),
          reason: z.string().describe("Why, one line: the owner's order in their words, with the time."),
          expected_version: z.number().int().min(0).describe('The current version you read from directives_read; 0 when none has been set.'),
          caller_thread_id: z.string().describe('Your own T3 thread id. Required: the direction lease is checked against it.'),
        },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
      },
      guarded((args) => {
        actingAs('directives_set', args.caller_thread_id)
        return store.directivesSet(role, args)
      }),
    )
  }

  return server
}
