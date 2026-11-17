import { describe, expect, it } from 'vitest'
import { checkBearer, timingSafeEqual } from './index.js'

describe('checkBearer', () => {
  it('accepts the exact bearer header', async () => {
    expect(await checkBearer('Bearer s3cret', 's3cret')).toBe(true)
  })

  it('rejects a wrong token', async () => {
    expect(await checkBearer('Bearer nope', 's3cret')).toBe(false)
  })

  it('rejects a missing header', async () => {
    expect(await checkBearer(undefined, 's3cret')).toBe(false)
    expect(await checkBearer(null, 's3cret')).toBe(false)
    expect(await checkBearer('', 's3cret')).toBe(false)
  })

  it('rejects the bare token without the Bearer scheme', async () => {
    expect(await checkBearer('s3cret', 's3cret')).toBe(false)
  })

  it('rejects a prefix or extension of the token', async () => {
    expect(await checkBearer('Bearer s3cre', 's3cret')).toBe(false)
    expect(await checkBearer('Bearer s3cret2', 's3cret')).toBe(false)
  })

  it('fails closed when the secret is unset or empty', async () => {
    expect(await checkBearer('Bearer s3cret', undefined)).toBe(false)
    expect(await checkBearer('Bearer s3cret', null)).toBe(false)
    expect(await checkBearer('Bearer s3cret', '')).toBe(false)
  })

  it('does not let a header of "Bearer " match an empty secret', async () => {
    expect(await checkBearer('Bearer ', '')).toBe(false)
    expect(await checkBearer('Bearer undefined', undefined)).toBe(false)
  })
})

describe('timingSafeEqual', () => {
  it('compares equal and unequal strings, whatever their lengths', async () => {
    expect(await timingSafeEqual('abc', 'abc')).toBe(true)
    expect(await timingSafeEqual('abc', 'abd')).toBe(false)
    expect(await timingSafeEqual('abc', 'abcd')).toBe(false)
    expect(await timingSafeEqual('', '')).toBe(true)
  })

  it('handles multi-byte characters', async () => {
    expect(await timingSafeEqual('tökén', 'tökén')).toBe(true)
    expect(await timingSafeEqual('tökén', 'token')).toBe(false)
  })
})
