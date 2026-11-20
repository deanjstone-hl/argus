import { describe, expect, it } from 'vitest'

import { WAKE_REQUEST_COOLDOWN_MS, WAKE_REQUEST_HOURLY_CAP } from '../src/store.js'
import { AQUILA_THREAD, AFK_THREAD, MINUTE, PROMOTION_TOKEN, TOKENS, world } from './helpers.js'

/**
 * argus#1189: ops-hub asks for an Aquila wake for a named issue through POST /wake/request. The request is a
 * `wake_requested` event on the direction gate; POST /wake/check answers it on the next poll, and the model tick
 * that follows acknowledges it. The hub can ask for nothing else, and the wake never decides what starts.
 */
const ISSUE = 'deanjstone/argus#1189'
const OTHER = 'deanjstone/homelab#42'
const HOUR = 60 * MINUTE

const request = (extra: Record<string, unknown> = {}) => ({ issue: ISSUE, ...extra })

const modelTick = (thread_id: string) => ({ thread_id, directives_version: 'v1', needs_owner: [] as string[], window_used_percent: 20 })

const wakeBody = (role: 'afk' | 'direction', thread_id: string) => ({
  role,
  host: 'wsl2',
  thread_id,
  directives_version: 'v1',
  needs_owner: [] as string[],
  window_used_percent: 20,
  ...(role === 'afk' ? { takeable: 0 } : {}),
})

async function ticked(options: Parameters<typeof world>[0] = {}) {
  const w = world(options)
  const afk = await w.as('afk')
  const aquila = await w.as('direction')
  await afk.ok('status_tick', { ...modelTick(AFK_THREAD), slot_cap: 1 })
  await aquila.ok('status_tick', modelTick(AQUILA_THREAD))
  w.clock.advance(MINUTE)
  return { ...w, afk, aquila }
}

const checkDirection = (post: Awaited<ReturnType<typeof ticked>>['post']) =>
  post('/wake/check', wakeBody('direction', AQUILA_THREAD), TOKENS.direction)

describe('POST /wake/request: auth and body', () => {
  it('refuses a missing, wrong or role token; only the hub bearer asks', async () => {
    const { post } = await ticked()
    expect((await post('/wake/request', request(), null)).status).toBe(401)
    expect((await post('/wake/request', request(), 'not-the-token-0123456789abcdef')).status).toBe(401)
    for (const role of ['afk', 'direction', 'worker'] as const) {
      expect((await post('/wake/request', request(), TOKENS[role])).status).toBe(401)
    }
    expect(await post('/wake/request', request(), PROMOTION_TOKEN)).toMatchObject({ status: 200, body: { recorded: true } })
  })

  it('fails closed while no hub token is configured', async () => {
    const { post } = await ticked({ promotionToken: null })
    expect((await post('/wake/request', request(), PROMOTION_TOKEN)).status).toBe(401)
    expect((await post('/wake/request', request(), '')).status).toBe(401)
  })

  it('refuses a body that is not JSON, has an unknown field, or names no valid issue', async () => {
    const { post } = await ticked()
    expect((await post('/wake/request', 'not json', PROMOTION_TOKEN)).status).toBe(400)
    expect((await post('/wake/request', request({ extra: 1 }), PROMOTION_TOKEN)).status).toBe(400)
    expect((await post('/wake/request', {}, PROMOTION_TOKEN)).status).toBe(400)
    for (const issue of ['argus#1', 'deanjstone/argus', 'deanjstone/argus#0', 'deanjstone/argus#x', 7]) {
      expect((await post('/wake/request', { issue }, PROMOTION_TOKEN)).status).toBe(400)
    }
  })

  it('does not move the promotion route: the hub bearer still reports promotions, and role tokens still cannot', async () => {
    const { post } = await ticked()
    const promoted = { repo: 'deanjstone/argus', from_sha: null, to_sha: 'b'.repeat(40), at: '2026-10-18T00:05:00.000Z', source: 'approve' }
    expect((await post('/events/promoted', promoted, PROMOTION_TOKEN)).status).toBe(200)
    expect((await post('/events/promoted', promoted, TOKENS.direction)).status).toBe(401)
  })
})

describe('POST /wake/request: the wake reason', () => {
  it('wakes the direction lease holder on the next poll, naming the issue', async () => {
    const { post } = await ticked()
    expect((await checkDirection(post)).body).toMatchObject({ wake: false })
    await post('/wake/request', request(), PROMOTION_TOKEN)
    expect((await checkDirection(post)).body).toEqual({ wake: true, reason: `wake_requested:${ISSUE}`, recorded: false })
  })

  it('keeps answering until a model tick passes it, then goes quiet', async () => {
    const { post, aquila, clock } = await ticked()
    await post('/wake/request', request(), PROMOTION_TOKEN)
    for (let check = 0; check < 3; check += 1) {
      expect((await checkDirection(post)).body.wake).toBe(true)
      clock.advance(MINUTE)
    }
    await aquila.ok('status_tick', modelTick(AQUILA_THREAD))
    clock.advance(MINUTE)
    expect((await checkDirection(post)).body).toMatchObject({ wake: false })
  })

  it('names every pending issue, once each', async () => {
    const { post } = await ticked()
    await post('/wake/request', request(), PROMOTION_TOKEN)
    await post('/wake/request', { issue: OTHER }, PROMOTION_TOKEN)
    expect((await checkDirection(post)).body.reason).toBe(`wake_requested:${ISSUE},${OTHER}`)
  })

  it('tick_gate lists it in changes with the issue', async () => {
    const { post, aquila, clock } = await ticked()
    await post('/wake/request', request(), PROMOTION_TOKEN)
    const gate = await aquila.ok('tick_gate', modelTick(AQUILA_THREAD))
    expect(gate.changed).toBe(true)
    expect(gate.reasons).toContain('wake_requested')
    expect(gate.changes).toEqual([expect.objectContaining({ kind: 'wake_requested', issue: ISSUE, at: clock.iso() })])
  })

  it('survives a restart: the request still wakes the holder', async () => {
    const { post, restart } = await ticked()
    await post('/wake/request', request(), PROMOTION_TOKEN)
    restart()
    expect((await checkDirection(post)).body.reason).toBe(`wake_requested:${ISSUE}`)
  })

  it('never wakes the afk lease holder, and never reaches the afk tick_gate', async () => {
    const { post, afk } = await ticked()
    await post('/wake/request', request(), PROMOTION_TOKEN)
    expect((await post('/wake/check', wakeBody('afk', AFK_THREAD), TOKENS.afk)).body).toMatchObject({ wake: false })
    const gate = await afk.ok('tick_gate', { ...modelTick(AFK_THREAD), slot_cap: 1 })
    expect(gate.changes.map((change: { kind: string }) => change.kind)).not.toContain('wake_requested')
  })

  it('wakes only the lease holder: another direction thread stays not_holder', async () => {
    const { post } = await ticked()
    await post('/wake/request', request(), PROMOTION_TOKEN)
    expect((await post('/wake/check', wakeBody('direction', 'thread-someone-else'), TOKENS.direction)).body).toMatchObject({
      wake: false,
      reason: 'not_holder',
    })
  })
})

describe('POST /wake/request: a wake never bypasses the gates', () => {
  it('writes no slot, lease or loop status; the afk loop and its slot cap are untouched', async () => {
    const { post, aquila } = await ticked()
    const before = {
      slots: await aquila.ok('slot_list', {}),
      leases: await aquila.ok('lease_read', {}),
      status: await aquila.ok('status_read', {}),
    }
    await post('/wake/request', request(), PROMOTION_TOKEN)
    expect(await aquila.ok('slot_list', {})).toEqual(before.slots)
    expect(await aquila.ok('lease_read', {})).toEqual(before.leases)
    const status = await aquila.ok('status_read', {})
    expect(status.afk).toEqual(before.status.afk)
  })

  it('wakes a thread and starts nothing: with the afk slot cap full a request leaves that role quiet', async () => {
    const { post, afk, clock } = await ticked()
    await afk.ok('slot_start', { issue: 'deanjstone/argus#1', thread_id: 'worker-1' })
    await afk.ok('status_tick', { ...modelTick(AFK_THREAD), slot_cap: 1 })
    clock.advance(MINUTE)
    await post('/wake/request', request(), PROMOTION_TOKEN)
    expect((await post('/wake/check', { ...wakeBody('afk', AFK_THREAD), takeable: 4 }, TOKENS.afk)).body).toMatchObject({ wake: false })
  })
})

describe('POST /wake/request: rate limit', () => {
  it('coalesces a press while the same issue is still pending: acknowledged, no second event', async () => {
    const { post, aquila } = await ticked()
    await post('/wake/request', request(), PROMOTION_TOKEN)
    expect(await post('/wake/request', request(), PROMOTION_TOKEN)).toMatchObject({
      status: 200,
      body: { recorded: false, reason: 'pending' },
    })
    const gate = await aquila.ok('tick_gate', modelTick(AQUILA_THREAD))
    expect(gate.changes.filter((change: { kind: string }) => change.kind === 'wake_requested')).toHaveLength(1)
  })

  it('refuses the same issue again inside the cooldown, with how long to wait, even after Aquila handled it', async () => {
    const { post, aquila, clock } = await ticked()
    await post('/wake/request', request(), PROMOTION_TOKEN)
    await aquila.ok('status_tick', modelTick(AQUILA_THREAD))
    clock.advance(MINUTE)
    const refused = await post('/wake/request', request(), PROMOTION_TOKEN)
    expect(refused.status).toBe(429)
    expect(refused.body).toMatchObject({ error: 'rate_limited' })
    expect(refused.body.retry_after_seconds).toBe((WAKE_REQUEST_COOLDOWN_MS - MINUTE) / 1000)
    clock.advance(WAKE_REQUEST_COOLDOWN_MS - MINUTE)
    expect((await post('/wake/request', request(), PROMOTION_TOKEN)).body).toMatchObject({ recorded: true })
  })

  it('a refused press records nothing and wakes nothing', async () => {
    const { post, aquila, clock } = await ticked()
    await post('/wake/request', request(), PROMOTION_TOKEN)
    await aquila.ok('status_tick', modelTick(AQUILA_THREAD))
    clock.advance(MINUTE)
    await post('/wake/request', request(), PROMOTION_TOKEN)
    expect((await checkDirection(post)).body).toMatchObject({ wake: false })
  })

  it('caps all issues together per hour, whichever issue the presses name', async () => {
    const { post, aquila, clock } = await ticked()
    for (let n = 1; n <= WAKE_REQUEST_HOURLY_CAP; n += 1) {
      expect((await post('/wake/request', { issue: `deanjstone/argus#${n}` }, PROMOTION_TOKEN)).body).toMatchObject({ recorded: true })
      await aquila.ok('status_tick', modelTick(AQUILA_THREAD))
      clock.advance(WAKE_REQUEST_COOLDOWN_MS)
    }
    const refused = await post('/wake/request', { issue: 'deanjstone/argus#999' }, PROMOTION_TOKEN)
    expect(refused.status).toBe(429)
    expect(refused.body.retry_after_seconds).toBeGreaterThan(0)
    expect(refused.body.retry_after_seconds).toBeLessThanOrEqual(HOUR / 1000)
    clock.advance(HOUR)
    expect((await post('/wake/request', { issue: 'deanjstone/argus#999' }, PROMOTION_TOKEN)).body).toMatchObject({ recorded: true })
  })

  it('keeps the limit across a restart', async () => {
    const { post, restart, aquila } = await ticked()
    await post('/wake/request', request(), PROMOTION_TOKEN)
    await aquila.ok('status_tick', modelTick(AQUILA_THREAD))
    restart()
    expect((await post('/wake/request', request(), PROMOTION_TOKEN)).status).toBe(429)
  })
})
