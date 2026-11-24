import { describe, expect, it } from 'vitest'

import { openStore, type Store } from '../src/store.js'

import { AQUILA_THREAD, MINUTE, testClock } from './helpers.js'

/**
 * An exhaustive check of which thread the `afk` wake goes to, run against the real store on a real SQLite db. Five
 * fixes changed this one decision (f1bed5b9, 700b5ed0, argus#57, 87513abb, argus#58), each for one arrangement of
 * holder, host and slots that the examples had missed. Here every arrangement in a small world is built, both
 * pollers ask `wake_check` once, and the answers must match the rule as the README states it.
 * `verify-loop-state-slots` in `.claude/skills/` says how to read a failure.
 */

const WSL2 = 'thread-afk-wsl2'
const HOMELAB = 'thread-afk-homelab'
const TOTAL_CAP = 2
const HOST_CAPS = { wsl2: 1, homelab: 1 } as const
const WSL2_ISSUE = 'o/work#1'
const HOMELAB_ISSUE = 'o/work#9'

/** Who holds the afk lease: the WSL2 primary with a homelab standby beside it, or a homelab thread that is the primary. */
const HOLDERS = ['wsl2-primary', 'homelab-primary'] as const
/** The one homelab slot: none, running, parked on a question, parked on an approval prompt, or un-parked. */
const HOMELAB_SLOTS = ['none', 'running', 'parked', 'parked-on-prompt', 'ready'] as const
/** What the holder's last tick wrote in `errors`. */
const ERRORS = {
  none: [],
  'drain-left names the homelab slot': [`drain-left: ${HOMELAB_ISSUE} homelab not reachable`],
  'drain-left names another issue': ['drain-left: o/work#90 homelab not reachable'],
  'a line that only mentions homelab': [`t3 link to homelab slow, ${HOMELAB_ISSUE} read late`],
} as const
type ErrorKind = keyof typeof ERRORS

interface World {
  holder: (typeof HOLDERS)[number]
  /** The holder has ticked just now, or has been silent past two cadences and the grace. */
  holderAlive: boolean
  wsl2Running: boolean
  homelabSlot: (typeof HOMELAB_SLOTS)[number]
  errors: ErrorKind
  takeable: number
}

const describeWorld = (world: World) =>
  [
    `holder: ${world.holder}, ${world.holderAlive ? 'alive' : 'silent for 70 min'}`,
    `wsl2 slot: ${world.wsl2Running ? 'running' : 'none'} (cap ${HOST_CAPS.wsl2})`,
    `homelab slot: ${world.homelabSlot} (cap ${HOST_CAPS.homelab})`,
    `holder's last tick errors: ${world.errors}`,
    `takeable: ${world.takeable}`,
  ].join('\n  ')

function* worlds(): Generator<World> {
  for (const holder of HOLDERS)
    for (const holderAlive of [true, false])
      for (const wsl2Running of [false, true])
        for (const homelabSlot of HOMELAB_SLOTS)
          for (const errors of Object.keys(ERRORS) as ErrorKind[])
            for (const takeable of [0, 1]) yield { holder, holderAlive, wsl2Running, homelabSlot, errors, takeable }
}

function build(world: World): { store: Store; holderThread: string } {
  const clock = testClock()
  const store = openStore({ path: ':memory:', now: clock.now, warn: () => {} })
  const holderThread = world.holder === 'wsl2-primary' ? WSL2 : HOMELAB
  const holderHost = world.holder === 'wsl2-primary' ? 'wsl2' : 'homelab'
  store.leaseMove('direction', { role: 'afk', to_thread_id: holderThread, host: holderHost })
  store.leaseMove('direction', { role: 'direction', to_thread_id: AQUILA_THREAD })
  const tick = (extra: Record<string, unknown> = {}) =>
    store.statusTick('afk', {
      thread_id: holderThread,
      directives_version: 'v1',
      needs_owner: [],
      total_cap: TOTAL_CAP,
      host_caps: { ...HOST_CAPS },
      window_used_percent: 20,
      ...extra,
    })
  tick()
  const caller = { caller_thread_id: holderThread }
  if (world.wsl2Running) store.slotStart('afk', WSL2_ISSUE, 'worker-1', 'wsl2', holderThread)
  if (world.homelabSlot !== 'none') {
    store.slotStart('afk', HOMELAB_ISSUE, 'worker-9', 'homelab', holderThread)
    if (world.homelabSlot === 'parked-on-prompt') tick({ pending_approvals: { [HOMELAB_ISSUE]: 1 } })
    if (world.homelabSlot !== 'running') store.slotPark('afk', HOMELAB_ISSUE, 'model', caller)
    if (world.homelabSlot === 'ready') store.slotUnpark('direction', HOMELAB_ISSUE, 'answered')
  }
  // The holder's last model tick: it has seen every slot change above, and carries the errors under test.
  tick({ errors: [...ERRORS[world.errors]] })
  if (!world.holderAlive) clock.advance(70 * MINUTE)
  return { store, holderThread }
}

const poll = (store: Store, host: 'wsl2' | 'homelab', thread_id: string, takeable: number) =>
  store.wakeCheck('afk', { role: 'afk', host, thread_id, directives_version: 'v1', needs_owner: [], window_used_percent: 20, takeable }).reason

/** The slots holding a place per host: a running slot, and one parked on an approval prompt. */
function placed(world: World): { wsl2: number; homelab: number } {
  return { wsl2: world.wsl2Running ? 1 : 0, homelab: world.homelabSlot === 'running' || world.homelabSlot === 'parked-on-prompt' ? 1 : 0 }
}

/** Whether the holder could start a takeable issue: room under the total cap, and on a host it may start on. */
function holderHasRoom(world: World): boolean {
  const used = placed(world)
  if (world.takeable === 0 || used.wsl2 + used.homelab >= TOTAL_CAP) return false
  // The WSL2 holder also fills homelab slots through the linked environment (argus#58); a homelab holder starts
  // slots only on its own host (argus-config#1366).
  const startsOn = world.holder === 'wsl2-primary' ? (['wsl2', 'homelab'] as const) : (['homelab'] as const)
  return startsOn.some((host) => used[host] < HOST_CAPS[host])
}

/** What the homelab standby must be told. It exists only beside a WSL2 primary. */
function standbyAnswer(world: World): string {
  if (!world.holderAlive) return 'failover'
  // Only a running worker has a report to settle, and only when the holder says it could not reach it (argus#57).
  return world.homelabSlot === 'running' && world.errors === 'drain-left names the homelab slot' ? 'drain' : 'primary_alive'
}

/** Checks one world. Returns the broken rule, or null. */
function check(world: World): string | null {
  if (world.holder === 'wsl2-primary') {
    const { store } = build(world)
    try {
      const told = poll(store, 'homelab', HOMELAB, world.takeable)
      const want = standbyAnswer(world)
      if (told !== want) return `the homelab standby is told ${told}, but the rule says ${want}`
    } finally {
      store.close()
    }
  }
  // A silent holder is not polling; its wake is the standby's failover above.
  if (!world.holderAlive) return null
  const { store, holderThread } = build(world)
  try {
    const told = poll(store, world.holder === 'wsl2-primary' ? 'wsl2' : 'homelab', holderThread, world.takeable)
    const wantsSlot = holderHasRoom(world)
    if (wantsSlot && told !== 'free_slot') return `the holder has room to start a takeable issue but is told ${told}, not free_slot`
    if (!wantsSlot && told !== 'quiet') return `the holder cannot start anything and nothing changed, but is told ${told}, not quiet`
    return null
  } finally {
    store.close()
  }
}

const explain = (world: World) => {
  const broken = check(world)
  return broken === null ? 'none' : `${broken}\n  ${describeWorld(world)}`
}

const base: World = { holder: 'wsl2-primary', holderAlive: true, wsl2Running: false, homelabSlot: 'none', errors: 'none', takeable: 0 }

describe('afk wake targeting', () => {
  it('replays argus#57: a live WSL2 holder drains a running homelab slot itself, so the standby is not woken', () => {
    expect(explain({ ...base, homelabSlot: 'running' })).toBe('none')
  })

  it('replays 87513abb: a tick error that only mentions homelab is no drain hand-off', () => {
    expect(explain({ ...base, homelabSlot: 'running', errors: 'a line that only mentions homelab' })).toBe('none')
  })

  it('replays argus#58: the WSL2 holder is woken for a free homelab slot while WSL2 is full', () => {
    expect(explain({ ...base, wsl2Running: true, takeable: 1 })).toBe('none')
  })

  it('replays f1bed5b9: a homelab holder is not woken for room that only WSL2 has', () => {
    expect(explain({ ...base, holder: 'homelab-primary', homelabSlot: 'running', takeable: 1 })).toBe('none')
  })

  it('replays argus-config#1357: a homelab slot parked on an approval prompt leaves no free homelab slot to wake for', () => {
    expect(explain({ ...base, wsl2Running: true, homelabSlot: 'parked-on-prompt', takeable: 1 })).toBe('none')
  })

  it('answers every arrangement of holder, liveness, slots, tick errors and takeable by the rule', () => {
    const broken = [...worlds()].map(explain).filter((answer) => answer !== 'none')
    expect(broken.slice(0, 3).join('\n\n') || 'none').toBe('none')
    expect([...worlds()].length).toBe(320)
  })
})
