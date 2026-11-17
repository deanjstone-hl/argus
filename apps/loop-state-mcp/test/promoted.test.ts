import { describe, expect, it } from 'vitest'

import { AQUILA_THREAD, AFK_THREAD, MINUTE, PROMOTION_TOKEN, TOKENS, world } from './helpers.js'

/**
 * argus#1118: ops-hub records a promotion through POST /events/promoted; the `promoted` event arrives in
 * tick_gate's changes. It wakes nothing through POST /wake/check (argus-config#1351): tick-prep wakes Aquila
 * only when the flagged issue has an owner step waiting.
 */
const REPO = 'deanjstone/argus'
const FROM = 'a'.repeat(40)
const TO = 'b'.repeat(40)

const promoted = (extra: Record<string, unknown> = {}) => ({
  repo: REPO,
  from_sha: FROM,
  to_sha: TO,
  at: '2026-10-18T00:05:00.000Z',
  source: 'approve',
  ...extra,
})

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

describe('POST /events/promoted: auth and body', () => {
  it('refuses a missing, wrong or role token; only the promotion token writes', async () => {
    const { post } = await ticked()
    expect((await post('/events/promoted', promoted(), null)).status).toBe(401)
    expect((await post('/events/promoted', promoted(), 'not-the-token-0123456789abcdef')).status).toBe(401)
    for (const role of ['afk', 'direction', 'worker'] as const) {
      expect((await post('/events/promoted', promoted(), TOKENS[role])).status).toBe(401)
    }
    expect(await post('/events/promoted', promoted(), PROMOTION_TOKEN)).toEqual({ status: 200, body: { recorded: true } })
  })

  it('fails closed while no promotion token is configured', async () => {
    const { post } = await ticked({ promotionToken: null })
    expect((await post('/events/promoted', promoted(), PROMOTION_TOKEN)).status).toBe(401)
    expect((await post('/events/promoted', promoted(), '')).status).toBe(401)
  })

  it('refuses a body that is not JSON, has an unknown field, a bad SHA, a bad repo or an unknown source', async () => {
    const { post } = await ticked()
    expect((await post('/events/promoted', 'not json', PROMOTION_TOKEN)).status).toBe(400)
    expect((await post('/events/promoted', promoted({ extra: 1 }), PROMOTION_TOKEN)).status).toBe(400)
    expect((await post('/events/promoted', promoted({ to_sha: 'abc' }), PROMOTION_TOKEN)).status).toBe(400)
    expect((await post('/events/promoted', promoted({ repo: 'argus' }), PROMOTION_TOKEN)).status).toBe(400)
    expect((await post('/events/promoted', promoted({ source: 'curl' }), PROMOTION_TOKEN)).status).toBe(400)
    expect((await post('/events/promoted', promoted({ at: 'yesterday' }), PROMOTION_TOKEN)).status).toBe(400)
  })

  it('takes a null from_sha, for a repo whose deploy branch had no earlier tip', async () => {
    const { post } = await ticked()
    expect((await post('/events/promoted', promoted({ from_sha: null }), PROMOTION_TOKEN)).body).toEqual({ recorded: true })
  })
})

describe('POST /events/promoted: idempotent on repo + to_sha', () => {
  it('a repeat is acknowledged and records no second event', async () => {
    const { post, aquila } = await ticked()
    await post('/events/promoted', promoted(), PROMOTION_TOKEN)
    expect(await post('/events/promoted', promoted({ source: 'webhook' }), PROMOTION_TOKEN)).toEqual({
      status: 200,
      body: { recorded: false },
    })
    const gate = await aquila.ok('tick_gate', modelTick(AQUILA_THREAD))
    expect(gate.changes.filter((change: { kind: string }) => change.kind === 'promoted')).toHaveLength(1)
  })

  it('the same SHA on another repo, and another SHA on the same repo, are separate promotions', async () => {
    const { post, aquila } = await ticked()
    await post('/events/promoted', promoted(), PROMOTION_TOKEN)
    await post('/events/promoted', promoted({ repo: 'deanjstone/homelab' }), PROMOTION_TOKEN)
    await post('/events/promoted', promoted({ from_sha: TO, to_sha: 'c'.repeat(40) }), PROMOTION_TOKEN)
    const gate = await aquila.ok('tick_gate', modelTick(AQUILA_THREAD))
    expect(gate.changes.filter((change: { kind: string }) => change.kind === 'promoted')).toHaveLength(3)
  })

  it('survives a restart: the same promotion is still a repeat', async () => {
    const { post, restart } = await ticked()
    await post('/events/promoted', promoted(), PROMOTION_TOKEN)
    restart()
    expect((await post('/events/promoted', promoted(), PROMOTION_TOKEN)).body).toEqual({ recorded: false })
  })
})

describe('the promoted event is recorded and wakes nothing (argus-config#1351)', () => {
  it('stays quiet after a promotion, on every check until the next model tick', async () => {
    const { post, clock } = await ticked()
    expect((await post('/wake/check', wakeBody('direction', AQUILA_THREAD), TOKENS.direction)).body).toMatchObject({ wake: false })
    await post('/events/promoted', promoted(), PROMOTION_TOKEN)
    for (let check = 0; check < 3; check += 1) {
      const answer = await post('/wake/check', wakeBody('direction', AQUILA_THREAD), TOKENS.direction)
      expect(answer.body.wake).toBe(false)
      expect(answer.body.reason).not.toMatch(/promoted/)
      clock.advance(MINUTE)
    }
  })

  it('does not wake the afk lease holder or a thread that does not hold the direction lease', async () => {
    const { post } = await ticked()
    await post('/events/promoted', promoted(), PROMOTION_TOKEN)
    expect((await post('/wake/check', wakeBody('afk', AFK_THREAD), TOKENS.afk)).body).toMatchObject({ wake: false })
    expect((await post('/wake/check', wakeBody('direction', 'thread-someone-else'), TOKENS.direction)).body).toMatchObject({
      wake: false,
      reason: 'not_holder',
    })
  })

  it('tick_gate lists it in changes with the repo and SHAs, and the status_tick that follows acknowledges it', async () => {
    const { post, aquila, clock } = await ticked()
    await post('/events/promoted', promoted({ source: 'webhook' }), PROMOTION_TOKEN)

    const gate = await aquila.ok('tick_gate', modelTick(AQUILA_THREAD))
    expect(gate.changed).toBe(true)
    expect(gate.reasons).toContain('promoted')
    expect(gate.changes).toEqual([
      expect.objectContaining({ kind: 'promoted', repo: REPO, from_sha: FROM, to_sha: TO, source: 'webhook', at: clock.iso() }),
    ])

    await aquila.ok('status_tick', modelTick(AQUILA_THREAD))
    clock.advance(MINUTE)
    expect((await post('/wake/check', wakeBody('direction', AQUILA_THREAD), TOKENS.direction)).body).toMatchObject({ wake: false })
    const after = await aquila.ok('tick_gate', modelTick(AQUILA_THREAD))
    expect(after.changed).toBe(false)
  })

  it('the afk loop\'s tick_gate never sees it', async () => {
    const { post, afk } = await ticked()
    await post('/events/promoted', promoted(), PROMOTION_TOKEN)
    const gate = await afk.ok('tick_gate', { ...modelTick(AFK_THREAD), slot_cap: 1 })
    expect(gate.changes.map((change: { kind: string }) => change.kind)).not.toContain('promoted')
  })
})
