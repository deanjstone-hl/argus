import { describe, expect, it } from 'vitest'

import { SELF_THREAD_ARG, type McpToolName } from '../src/mcp.js'
import type { Role } from '../src/roles.js'
import { TOOL_ROLES } from '../src/store.js'

import { TOKENS, text, world, type ToolResult } from './helpers.js'

/**
 * argus#51: a thread id passed as an argument is self-asserted, and a T3 fork inherits its parent's. Every tool that
 * lets the caller name its own thread must check that name against X-T3-Thread-Id. The check runs in the
 * registration wrapper from SELF_THREAD_ARG, and these tests walk every registered tool, so a new tool cannot ship
 * without it.
 */
const HOLDER = 'thread-holder-0001'
const FORK = 'thread-fork-0002'
const ISSUE = 'deanjstone/argus#701'
const ROLES: readonly Role[] = ['afk', 'direction', 'worker']

type SelfNamingTool = { [Tool in McpToolName]: (typeof SELF_THREAD_ARG)[Tool] extends null ? never : Tool }[McpToolName]

/** Valid arguments for each tool that names its caller, without the self-thread argument. A new such tool needs a row. */
const SAMPLES: Record<SelfNamingTool, Record<string, unknown>> = {
  slot_start: { issue: ISSUE, thread_id: 'worker-1' },
  slot_park: { issue: ISSUE },
  slot_close: { issue: ISSUE, verified: 'Verified: merged' },
  slot_free: { issue: ISSUE, reason: 'worker gone' },
  slot_report: { issue: ISSUE, outcome: 'complete' },
  slot_await_ci: { issue: ISSUE, ref: 'https://github.com/deanjstone/argus/pull/1' },
  slot_rebuild: { issues: [], threads: [] },
  status_tick: { directives_version: 'v1', needs_owner: [] },
  tick_gate: { directives_version: 'v1', needs_owner: [] },
  owner_turn: {},
  owner_thread_set: { host: 'wsl2', thread_id: 'thread-owner-chat' },
  directives_set: { record: { cadence_minutes: 30, max_slots: 2, repo_holds: [], take_next: [], ordering: [] }, reason: 'fork', expected_version: 0 },
}

/** Tools whose `thread_id` names another thread than the caller, so it is not checked against the header. */
const NAMES_ANOTHER_THREAD: Partial<Record<McpToolName, string>> = {
  child_start: 'the child thread being recorded',
  child_close: 'the child thread being closed',
}

async function registeredTools() {
  const w = world({ leases: { afk: HOLDER, direction: HOLDER } })
  const tools = new Map<string, { role: Role; properties: string[] }>()
  for (const role of ROLES) {
    const client = await w.connect(TOKENS[role], FORK)
    for (const tool of (await client.listTools()).tools) {
      tools.set(tool.name, { role, properties: Object.keys((tool.inputSchema.properties ?? {}) as Record<string, unknown>) })
    }
  }
  return { w, tools }
}

describe('every tool says which argument names the caller, and the server checks it', () => {
  it('has a SELF_THREAD_ARG entry that matches each registered tool\'s input schema', async () => {
    const { tools } = await registeredTools()
    expect([...tools.keys()].sort()).toEqual(Object.keys(SELF_THREAD_ARG).sort())
    const problems = [...tools].flatMap(([name, { properties }]) => {
      const entry = SELF_THREAD_ARG[name as McpToolName]
      if (entry !== null && !properties.includes(entry)) return [`${name}: SELF_THREAD_ARG says ${entry}, but the tool has no such argument`]
      if (properties.includes('caller_thread_id') && entry !== 'caller_thread_id') {
        return [`${name}: it takes caller_thread_id, so its SELF_THREAD_ARG entry must be 'caller_thread_id', or a fork passes its parent's id unchecked`]
      }
      if (entry === null && properties.includes('thread_id') && NAMES_ANOTHER_THREAD[name as McpToolName] === undefined) {
        return [`${name}: it takes thread_id. If that is the caller's own thread, set its SELF_THREAD_ARG entry to 'thread_id'; if it names another thread, add it to NAMES_ANOTHER_THREAD with the reason`]
      }
      return []
    })
    expect(problems).toEqual([])
  })

  it.each(Object.keys(SAMPLES) as SelfNamingTool[])('%s refuses a session that names another thread as itself', async (tool) => {
    const w = world({ leases: { afk: HOLDER, direction: HOLDER } })
    const role = (TOOL_ROLES[tool] as readonly Role[])[0] as Role
    const fork = await w.as(role, FORK)
    const result: ToolResult = await fork.call(tool, { ...SAMPLES[tool], [SELF_THREAD_ARG[tool]]: HOLDER })
    expect(result.isError, text(result)).toBe(true)
    expect(text(result)).toMatch(/X-T3-Thread-Id/)
    expect(text(result)).toContain(FORK)
  })

  it('covers every tool that names its caller', () => {
    const selfNaming = (Object.keys(SELF_THREAD_ARG) as McpToolName[]).filter((tool) => SELF_THREAD_ARG[tool] !== null)
    expect(Object.keys(SAMPLES).sort()).toEqual(selfNaming.sort())
  })
})
