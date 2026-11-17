import { describe, expect, it } from 'vitest'
import { describeError } from './describe-error.js'

describe('describeError', () => {
  it('names the cause code of a fetch failure, which carries the real reason', () => {
    const cause = Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' })
    expect(describeError(new TypeError('fetch failed', { cause }))).toBe('fetch failed (cause ECONNRESET: read ECONNRESET)')
  })

  it('names a cause that has a message but no code', () => {
    expect(describeError(new Error('fetch failed', { cause: new Error('socket hang up') }))).toBe('fetch failed (cause: socket hang up)')
  })

  it('names a cause that is only a code', () => {
    expect(describeError(new Error('fetch failed', { cause: { code: 'UND_ERR_CONNECT_TIMEOUT' } }))).toBe(
      'fetch failed (cause UND_ERR_CONNECT_TIMEOUT)',
    )
  })

  it('is just the message when there is no cause', () => {
    expect(describeError(new Error('worker-client: POST /watchtower/checks failed with 502: Bad Gateway'))).toBe(
      'worker-client: POST /watchtower/checks failed with 502: Bad Gateway',
    )
  })

  it('stringifies a thrown value that is not an Error', () => {
    expect(describeError('boom')).toBe('boom')
  })
})
