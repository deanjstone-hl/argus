import { describe, expect, it } from 'vitest'
import { createLimiter } from './limit.js'

const tick = () => new Promise((resolve) => setTimeout(resolve, 1))

describe('createLimiter', () => {
  it('never runs more than the limit at once, and runs every task', async () => {
    const limit = createLimiter(3)
    let active = 0
    let peak = 0
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        limit(async () => {
          active += 1
          peak = Math.max(peak, active)
          await tick()
          active -= 1
          return index
        }),
      ),
    )
    expect(peak).toBe(3)
    expect(results).toEqual(Array.from({ length: 20 }, (_, index) => index))
  })

  it('runs a task that arrives while others are queued after them, not ahead of them', async () => {
    const limit = createLimiter(1)
    const order: string[] = []
    const first = limit(async () => (await tick(), order.push('a')))
    const second = limit(async () => order.push('b'))
    await tick()
    const third = limit(async () => order.push('c'))
    await Promise.all([first, second, third])
    expect(order).toEqual(['a', 'b', 'c'])
  })

  it('frees its slot when a task throws', async () => {
    const limit = createLimiter(1)
    await expect(limit(async () => Promise.reject(new Error('boom')))).rejects.toThrow('boom')
    await expect(limit(async () => 'ok')).resolves.toBe('ok')
  })
})
