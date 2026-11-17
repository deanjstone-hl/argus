import { homedir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { loadConfig } from '../src/config.js'

const TOKENS = 'afk=aaaaaaaaaaaaaaaaaaaaaaaaaa,direction=bbbbbbbbbbbbbbbbbbbbbbbbbb,worker=cccccccccccccccccccccccccc'

describe('loadConfig', () => {
  it('defaults to loopback, port 3791, the homelab db path and a 30-minute cadence', () => {
    const config = loadConfig({ LOOP_STATE_TOKENS: TOKENS })
    expect(config).toMatchObject({
      host: '127.0.0.1',
      port: 3791,
      dbPath: join(homedir(), '.argus', 'backlog-loop', 'loop.db'),
      cadenceMs: 30 * 60_000,
    })
    expect(config.tokens.map((token) => token.role)).toEqual(['afk', 'direction', 'worker'])
  })

  it('accepts a slot write with no caller_thread_id unless LOOP_STATE_REQUIRE_CALLER_THREAD=1', () => {
    expect(loadConfig({ LOOP_STATE_TOKENS: TOKENS }).requireCallerThread).toBe(false)
    expect(loadConfig({ LOOP_STATE_TOKENS: TOKENS, LOOP_STATE_REQUIRE_CALLER_THREAD: '1' }).requireCallerThread).toBe(true)
  })

  it('leaves the promotion route unconfigured unless LOOP_STATE_PROMOTION_TOKEN is set, and refuses a short one', () => {
    expect(loadConfig({ LOOP_STATE_TOKENS: TOKENS }).promotionToken).toBeUndefined()
    expect(loadConfig({ LOOP_STATE_TOKENS: TOKENS, LOOP_STATE_PROMOTION_TOKEN: '' }).promotionToken).toBeUndefined()
    expect(loadConfig({ LOOP_STATE_TOKENS: TOKENS, LOOP_STATE_PROMOTION_TOKEN: 'p'.repeat(24) }).promotionToken).toBe('p'.repeat(24))
    expect(() => loadConfig({ LOOP_STATE_TOKENS: TOKENS, LOOP_STATE_PROMOTION_TOKEN: 'short' })).toThrow(/LOOP_STATE_PROMOTION_TOKEN/)
    expect(() => loadConfig({ LOOP_STATE_TOKENS: TOKENS, LOOP_STATE_PROMOTION_TOKEN: 'a'.repeat(26) })).toThrow(/reuses a role token/)
  })

  it('takes every setting from the environment', () => {
    const config = loadConfig({
      LOOP_STATE_TOKENS: TOKENS,
      LOOP_STATE_HOST: '100.64.0.7',
      LOOP_STATE_PORT: '4000',
      LOOP_STATE_DB: '/tmp/loop.db',
      LOOP_STATE_CADENCE_MINUTES: '15',
    })
    expect(config).toMatchObject({ host: '100.64.0.7', port: 4000, dbPath: '/tmp/loop.db', cadenceMs: 15 * 60_000 })
  })

  it('refuses to start without tokens, or with a bad port or cadence', () => {
    expect(() => loadConfig({})).toThrow(/LOOP_STATE_TOKENS/)
    expect(() => loadConfig({ LOOP_STATE_TOKENS: TOKENS, LOOP_STATE_PORT: 'http' })).toThrow(/LOOP_STATE_PORT/)
    expect(() => loadConfig({ LOOP_STATE_TOKENS: TOKENS, LOOP_STATE_CADENCE_MINUTES: '0' })).toThrow(/LOOP_STATE_CADENCE_MINUTES/)
  })
})
