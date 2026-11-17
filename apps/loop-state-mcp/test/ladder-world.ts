import { AFK_THREAD, MINUTE, world } from './helpers.js'

export const HOUR = 60 * MINUTE
export const DAY = 24 * HOUR
export const WEEK = 7 * DAY

export const base = { thread_id: AFK_THREAD, directives_version: 'v1', needs_owner: [] as string[], window_used_percent: 20 }

/** Used % at the baseline reading, a day before the reading under test. */
const BASELINE_USED = 30

/**
 * A world 3.5 days from the reset (half the week), with one reading a day old. A later tick
 * sends `burn` more than the baseline and a reserve chosen so the allowance is exactly 10 a
 * day, so the ratio is burn / 10 and every edge is written as a plain number.
 */
export async function ladderWorld(options: Parameters<typeof world>[0] = {}) {
  const w = world(options)
  const afk = await w.as('afk')
  const resets = new Date(w.clock.now() + DAY + 3.5 * DAY).toISOString()
  await afk.ok('status_tick', { ...base, weekly_used_percent: BASELINE_USED, weekly_resets_at: resets, reserve_percent: 100 - BASELINE_USED - 35 })
  // A tick with no weekly figure leaves the baseline reading as the only weekly history.
  await afk.ok('status_tick', base)
  w.clock.advance(DAY)
  const tick = (burn: number, extra: Record<string, unknown> = {}) => {
    const used = BASELINE_USED + burn
    return { ...base, weekly_used_percent: used, weekly_resets_at: resets, reserve_percent: 100 - used - 35, ...extra }
  }
  const ratioTo = async (burn: number) => {
    await afk.ok('status_tick', tick(burn))
    return (await afk.ok('status_read')).pressure
  }
  return { ...w, afk, tick, ratioTo, resets }
}

