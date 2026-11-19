import { describe, expect, it } from 'vitest'

import { AFK_THREAD, MINUTE, TOKENS } from './helpers.js'
import { ladderWorld } from './ladder-world.js'

/**
 * Trunk-trial repos skip the budget ladder's cut of the slot cap to 1 (argus#1012), and a running
 * slot in one sits outside the total, effective and host caps (argus#1033). It keeps one running
 * slot per repo and still obeys no_new_slots and gate_only.
 * Burn 10.5 puts the ladder at no_opus (cap cut to 1), 13 at no_new_slots.
 */
const trial = 'deanjstone/frontend'
const issue = (repo: string, n: number) => `${repo}#${n}`
const other = 'deanjstone/argus'

describe('budget_exempt_repos', () => {
  it('lets an exempt repo start past the cut cap of 1 at no_opus', async () => {
    const { afk, tick } = await ladderWorld()
    await afk.ok('status_tick', tick(10.5, { total_cap: 3, budget_exempt_repos: [trial] }))
    await afk.ok('slot_start', { issue: issue(other, 1), thread_id: 'w1' })
    expect((await afk.call('slot_start', { issue: issue(trial, 2), thread_id: 'w2' })).isError).toBeFalsy()
  })

  it('lets an exempt repo start even when the non-exempt slots fill the directives total', async () => {
    const { afk, tick } = await ladderWorld()
    await afk.ok('status_tick', tick(0, { total_cap: 2, budget_exempt_repos: [trial] }))
    await afk.ok('slot_start', { issue: issue(other, 1), thread_id: 'w1' })
    await afk.ok('slot_start', { issue: issue(other, 2), thread_id: 'w2' })
    expect((await afk.call('slot_start', { issue: issue(trial, 3), thread_id: 'w3' })).isError).toBeFalsy()
  })

  it('does not count a running exempt slot against a non-exempt start at no_opus with cap 1', async () => {
    const { afk, tick } = await ladderWorld()
    await afk.ok('status_tick', tick(10.5, { total_cap: 1, budget_exempt_repos: [trial] }))
    await afk.ok('slot_start', { issue: issue(trial, 164), thread_id: 'w1' })
    expect((await afk.call('slot_start', { issue: issue(other, 335), thread_id: 'w2' })).isError).toBeFalsy()
  })

  it('does not count a running exempt slot against the directives total either', async () => {
    const { afk, tick } = await ladderWorld()
    await afk.ok('status_tick', tick(0, { total_cap: 2, budget_exempt_repos: [trial] }))
    await afk.ok('slot_start', { issue: issue(trial, 1), thread_id: 'w1' })
    await afk.ok('slot_start', { issue: issue(other, 2), thread_id: 'w2' })
    await afk.ok('slot_start', { issue: issue(other, 3), thread_id: 'w3' })
    const refused = await afk.call('slot_start', { issue: issue(other, 4), thread_id: 'w4' })
    expect(refused.isError).toBe(true)
    expect(refused.content[0]?.text).toMatch(/effective slot cap 2 is reached \(2 running\)/)
  })

  it('refuses a second running slot in the same exempt repo', async () => {
    const { afk, tick } = await ladderWorld()
    await afk.ok('status_tick', tick(0, { total_cap: 3, budget_exempt_repos: [trial] }))
    await afk.ok('slot_start', { issue: issue(trial, 1), thread_id: 'w1' })
    const refused = await afk.call('slot_start', { issue: issue(trial, 2), thread_id: 'w2' })
    expect(refused.isError).toBe(true)
    expect(refused.content[0]?.text).toMatch(/deanjstone\/frontend already runs a slot/)
  })

  it('lets an exempt repo start again once its slot is closed', async () => {
    const { afk, tick } = await ladderWorld()
    await afk.ok('status_tick', tick(0, { total_cap: 3, budget_exempt_repos: [trial] }))
    await afk.ok('slot_start', { issue: issue(trial, 1), thread_id: 'w1' })
    await afk.ok('slot_close', { issue: issue(trial, 1), verified: 'Verified: verify-claim merged #1 ok; CI run 123 green' })
    expect((await afk.call('slot_start', { issue: issue(trial, 2), thread_id: 'w2' })).isError).toBeFalsy()
  })

  it('still refuses an exempt repo at no_new_slots', async () => {
    const { afk, tick } = await ladderWorld()
    await afk.ok('status_tick', tick(13, { total_cap: 3, budget_exempt_repos: [trial] }))
    const refused = await afk.call('slot_start', { issue: issue(trial, 1), thread_id: 'w1' })
    expect(refused.isError).toBe(true)
    expect(refused.content[0]?.text).toMatch(/no_new_slots/)
  })

  it('still refuses an exempt repo at gate_only', async () => {
    const { afk, tick } = await ladderWorld()
    await afk.ok('status_tick', tick(16, { total_cap: 3, budget_exempt_repos: [trial] }))
    const refused = await afk.call('slot_start', { issue: issue(trial, 1), thread_id: 'w1' })
    expect(refused.isError).toBe(true)
    expect(refused.content[0]?.text).toMatch(/gate_only/)
  })

  it('ignores exempt slots when a host cap is checked', async () => {
    const { afk, tick } = await ladderWorld()
    await afk.ok('status_tick', tick(0, { total_cap: 3, host_caps: { wsl2: 1, homelab: 2 }, budget_exempt_repos: [trial] }))
    await afk.ok('slot_start', { issue: issue(trial, 1), thread_id: 'w1', host: 'wsl2' })
    expect((await afk.call('slot_start', { issue: issue(other, 2), thread_id: 'w2', host: 'wsl2' })).isError).toBeFalsy()
    const refused = await afk.call('slot_start', { issue: issue(other, 3), thread_id: 'w3', host: 'wsl2' })
    expect(refused.isError).toBe(true)
    expect(refused.content[0]?.text).toMatch(/wsl2 slot cap 1 is reached \(1 running there\)/)
  })

  it('does not hold an exempt start to a host cap', async () => {
    const { afk, tick } = await ladderWorld()
    await afk.ok('status_tick', tick(0, { total_cap: 3, host_caps: { wsl2: 1, homelab: 2 }, budget_exempt_repos: [trial] }))
    await afk.ok('slot_start', { issue: issue(other, 1), thread_id: 'w1', host: 'wsl2' })
    expect((await afk.call('slot_start', { issue: issue(trial, 2), thread_id: 'w2', host: 'wsl2' })).isError).toBeFalsy()
  })

  it('refuses a repo that is not listed at the cut cap when a non-exempt slot is running', async () => {
    const { afk, tick } = await ladderWorld()
    await afk.ok('status_tick', tick(10.5, { total_cap: 3, budget_exempt_repos: [trial] }))
    await afk.ok('slot_start', { issue: issue(other, 1), thread_id: 'w1' })
    const refused = await afk.call('slot_start', { issue: issue(other, 2), thread_id: 'w2' })
    expect(refused.isError).toBe(true)
    expect(refused.content[0]?.text).toMatch(/effective slot cap 1 is reached \(1 running\)/)
  })

  it('refuses everything at the cut cap when no repo is listed', async () => {
    const { afk, tick } = await ladderWorld()
    await afk.ok('status_tick', tick(10.5, { total_cap: 3 }))
    await afk.ok('slot_start', { issue: issue(other, 1), thread_id: 'w1' })
    expect((await afk.call('slot_start', { issue: issue(trial, 2), thread_id: 'w2' })).isError).toBe(true)
  })

  it('does not change the effective cap status_read reports', async () => {
    const { afk, tick } = await ladderWorld()
    await afk.ok('status_tick', tick(10.5, { total_cap: 3, budget_exempt_repos: [trial] }))
    const read = await afk.ok('status_read')
    expect(read.pressure.effective_slot_cap).toBe(1)
    expect(read.pressure.budget_exempt_repos).toEqual([trial])
  })

  it('reports none when nothing is listed, and before any tick', async () => {
    const { afk, tick } = await ladderWorld()
    expect((await afk.ok('status_read')).pressure.budget_exempt_repos).toEqual([])
    await afk.ok('status_tick', tick(0))
    expect((await afk.ok('status_read')).pressure.budget_exempt_repos).toEqual([])
  })

  it('tick_gate carries the list forward when a call omits it; status_tick records none', async () => {
    const { afk, tick, clock } = await ladderWorld()
    await afk.ok('status_tick', tick(10.5, { total_cap: 3, budget_exempt_repos: [trial] }))
    clock.advance(5 * MINUTE)
    const gate = await afk.ok('tick_gate', tick(10.5))
    expect(gate.recorded).toBe(true)
    expect((await afk.ok('status_read')).pressure.budget_exempt_repos).toEqual([trial])
    await afk.ok('status_tick', tick(10.5, { total_cap: 3 }))
    expect((await afk.ok('status_read')).pressure.budget_exempt_repos).toEqual([])
  })

  it('tick_gate records a list it is given', async () => {
    const { afk, tick, clock } = await ladderWorld()
    await afk.ok('status_tick', tick(10.5, { total_cap: 3 }))
    clock.advance(5 * MINUTE)
    await afk.ok('tick_gate', tick(10.5, { budget_exempt_repos: [trial] }))
    expect((await afk.ok('status_read')).pressure.budget_exempt_repos).toEqual([trial])
    await afk.ok('slot_start', { issue: issue(other, 1), thread_id: 'w1' })
    expect((await afk.call('slot_start', { issue: issue(trial, 2), thread_id: 'w2' })).isError).toBeFalsy()
  })

  it.each([['trial'], ['deanjstone/frontend#1'], [''], ['a/b/c']])('refuses %j as a repo', async (bad) => {
    const { afk, tick } = await ladderWorld()
    const result = await afk.call('status_tick', tick(0, { budget_exempt_repos: [bad] }))
    expect(result.isError).toBe(true)
    expect(result.content[0]?.text).toMatch(/budget_exempt_repos/)
  })

  it('normalises duplicates and order', async () => {
    const { afk, tick } = await ladderWorld()
    await afk.ok('status_tick', tick(0, { budget_exempt_repos: [trial, other, trial] }))
    expect((await afk.ok('status_read')).pressure.budget_exempt_repos).toEqual([other, trial].sort())
  })
})

describe('budget_exempt_repos: POST /wake/check', () => {
  const body = { role: 'afk', host: 'wsl2', thread_id: AFK_THREAD, directives_version: 'v1', needs_owner: [] as string[], window_used_percent: 20, takeable: 3 }

  it('wakes for a free slot at the cut cap only while a repo is exempt', async () => {
    const { afk, tick, post, clock } = await ladderWorld()
    await afk.ok('status_tick', tick(10.5, { total_cap: 3, budget_exempt_repos: [trial] }))
    await afk.ok('slot_start', { issue: issue(trial, 1), thread_id: 'w1' })
    await afk.ok('status_tick', tick(10.5, { total_cap: 3, budget_exempt_repos: [trial] }))
    clock.advance(5 * MINUTE)
    expect((await post('/wake/check', body, TOKENS.afk)).body).toMatchObject({ wake: true, reason: 'free_slot' })

    await afk.ok('status_tick', tick(10.5, { total_cap: 3 }))
    clock.advance(5 * MINUTE)
    expect((await post('/wake/check', body, TOKENS.afk)).body).toMatchObject({ wake: false })
  })

  it('does not wake once the non-exempt slots fill the directives total', async () => {
    const { afk, tick, post, clock } = await ladderWorld()
    await afk.ok('status_tick', tick(10.5, { total_cap: 1, budget_exempt_repos: [trial] }))
    await afk.ok('slot_start', { issue: issue(other, 1), thread_id: 'w1' })
    await afk.ok('status_tick', tick(10.5, { total_cap: 1, budget_exempt_repos: [trial] }))
    clock.advance(5 * MINUTE)
    expect((await post('/wake/check', body, TOKENS.afk)).body).toMatchObject({ wake: false })
  })

  it('still wakes while only an exempt slot is running and the total is full of it', async () => {
    const { afk, tick, post, clock } = await ladderWorld()
    await afk.ok('status_tick', tick(10.5, { total_cap: 1, budget_exempt_repos: [trial] }))
    await afk.ok('slot_start', { issue: issue(trial, 1), thread_id: 'w1' })
    await afk.ok('status_tick', tick(10.5, { total_cap: 1, budget_exempt_repos: [trial] }))
    clock.advance(5 * MINUTE)
    expect((await post('/wake/check', body, TOKENS.afk)).body).toMatchObject({ wake: true, reason: 'free_slot' })
  })

  it('ignores exempt slots when it checks the host caps', async () => {
    const { afk, tick, post, clock } = await ladderWorld()
    const extra = { total_cap: 3, host_caps: { wsl2: 1, homelab: 0 }, budget_exempt_repos: [trial] }
    await afk.ok('status_tick', tick(0, extra))
    await afk.ok('slot_start', { issue: issue(trial, 1), thread_id: 'w1', host: 'wsl2' })
    await afk.ok('status_tick', tick(0, extra))
    clock.advance(5 * MINUTE)
    expect((await post('/wake/check', body, TOKENS.afk)).body).toMatchObject({ wake: true, reason: 'free_slot' })
  })
})
