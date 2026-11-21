import { AFK_THREAD, MINUTE, world } from './helpers.js'

export const HOUR = 60 * MINUTE
export const DAY = 24 * HOUR
export const WEEK = 7 * DAY

export const base = { thread_id: AFK_THREAD, directives_version: 'v1', needs_owner: [] as string[], window_used_percent: 20 }

/** Used % at the baseline reading, a day before the reading under test. */
const BASELINE_USED = 30

/** The reserve the world plans with: low enough that no pace under test spends the allowance. */
export const LADDER_RESERVE = 5

/**
 * A world 3.5 days from the reset (half the week elapsed), with one reading a day old. A later
 * tick sends `pace` × 50 % used, so the weekly pace (used ÷ elapsed share) is exactly `pace` and
 * every edge of the ladder (argus#62) is written as a plain number.
 */
export async function ladderWorld(options: Parameters<typeof world>[0] = {}) {
  const w = world(options)
  const afk = await w.as('afk')
  const resets = new Date(w.clock.now() + DAY + 3.5 * DAY).toISOString()
  await afk.ok('status_tick', { ...base, weekly_used_percent: BASELINE_USED, weekly_resets_at: resets, reserve_percent: LADDER_RESERVE })
  // A tick with no weekly figure leaves the baseline reading as the only weekly history.
  await afk.ok('status_tick', base)
  w.clock.advance(DAY)
  const tick = (pace: number, extra: Record<string, unknown> = {}) => ({
    ...base,
    weekly_used_percent: Number((pace * 50).toFixed(6)),
    weekly_resets_at: resets,
    reserve_percent: LADDER_RESERVE,
    ...extra,
  })
  const paceTo = async (pace: number) => {
    await afk.ok('status_tick', tick(pace))
    return (await afk.ok('status_read')).pressure
  }
  return { ...w, afk, tick, paceTo, resets }
}
