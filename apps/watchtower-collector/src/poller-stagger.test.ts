import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Adapter } from './adapter.js'
import { firstPollDelayMs, FIRST_POLL_WINDOW_MS, startPolling } from './poller.js'
import { createSystemdAdapter, parseUnitList } from './adapters/systemd.js'
import { createTimersAdapter, listUserTimers } from './timer-freshness.js'

vi.mock('./record-check.js', () => ({ recordCheck: vi.fn(async () => {}) }))

beforeEach(() => {
  vi.useFakeTimers()
  vi.spyOn(console, 'log').mockImplementation(() => {})
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

function recordingAdapter(key: string, intervalMs: number, polledAt: number[]): Adapter {
  return { key, host: 'homelab', intervalMs, check: async () => (polledAt.push(Date.now()), { status: 'healthy' as const }) }
}

describe('firstPollDelayMs', () => {
  it('starts the first adapter at once and spreads the rest evenly across the window', () => {
    expect(firstPollDelayMs(0, 4)).toBe(0)
    expect(firstPollDelayMs(1, 4)).toBe(FIRST_POLL_WINDOW_MS / 4)
    expect(firstPollDelayMs(3, 4)).toBe((FIRST_POLL_WINDOW_MS * 3) / 4)
  })

  it('never delays a lone adapter', () => {
    expect(firstPollDelayMs(0, 1)).toBe(0)
  })
})

describe('startPolling', () => {
  it('does not poll every adapter in the same tick', async () => {
    const polledAt = Array.from({ length: 6 }, () => [] as number[])
    const start = Date.now()
    startPolling(polledAt.map((times, index) => recordingAdapter(`a${index}`, 60_000, times)))

    await vi.advanceTimersByTimeAsync(0)
    expect(polledAt.filter((times) => times.length > 0)).toHaveLength(1)

    await vi.advanceTimersByTimeAsync(FIRST_POLL_WINDOW_MS)
    expect(polledAt.every((times) => times.length === 1)).toBe(true)
    expect(polledAt.map((times) => (times[0] as number) - start)).toEqual(
      polledAt.map((_, index) => firstPollDelayMs(index, polledAt.length)),
    )
  })

  it('keeps each adapter on its own phase afterwards, so intervals never realign', async () => {
    const polledAt = Array.from({ length: 3 }, () => [] as number[])
    const start = Date.now()
    startPolling(polledAt.map((times, index) => recordingAdapter(`a${index}`, 60_000, times)))

    await vi.advanceTimersByTimeAsync(3 * 60_000 - 1)

    const offsets = polledAt.map((times) => times.map((at) => (at - start) % 60_000))
    for (const [index, times] of offsets.entries()) {
      expect(times).toHaveLength(3)
      expect(new Set(times).size).toBe(1)
      expect(times[0]).toBe(firstPollDelayMs(index, polledAt.length))
    }
  })

  it('stops a poll that has not yet started when the stop function is called', async () => {
    const polledAt = Array.from({ length: 4 }, () => [] as number[])
    const stop = startPolling(polledAt.map((times, index) => recordingAdapter(`a${index}`, 60_000, times)))

    await vi.advanceTimersByTimeAsync(0)
    stop()
    await vi.advanceTimersByTimeAsync(5 * 60_000)

    expect(polledAt.flat()).toHaveLength(1)
  })

  // The homelab's real shape: 24 systemd cards at 30s plus the timers card,
  // each poll shelling out to systemctl. Counts the systemctl processes that
  // are alive at once, which is what the cgroup's memory is made of.
  it('keeps the systemctl processes alive at once to a handful, where an unstaggered start ran every unit together', async () => {
    const units = 'agent-engine.service,ops-hub.service,watchtower-collector.service,budget-api.service,t3code.service,taskview-web.service,taskview-api.service,taskview-migrate.service,budget-api-cron.timer,argus-context-fetch-install.timer,session-tasks.timer,inbox-ingest.timer,repo-git-sync.timer,vault-git-sync.timer,runner-watchdog.timer,system:cloudflared.service,system:tailscaled.service,system:postgresql@16-main.service,system:borgmatic.timer,paperless-webserver.service,paperless-consumer.service,paperless-task-queue.service,paperless-scheduler.service,system:valkey-server.service'
    const timerNames = Array.from({ length: 20 }, (_, index) => `t${index}.timer`)
    const SYSTEMCTL_MS = 40

    async function peakInFlight(stagger: boolean): Promise<number> {
      let inFlight = 0
      let peak = 0
      const run = async (args: string[]) => {
        inFlight += 1
        peak = Math.max(peak, inFlight)
        await new Promise((resolve) => setTimeout(resolve, SYSTEMCTL_MS))
        inFlight -= 1
        if (args[1] === 'list-unit-files') return timerNames.map((name) => `${name} enabled enabled`).join('\n')
        if (args[1] === 'list-units') return ''
        const unit = (args[args.indexOf('show') + 1] ?? '') as string
        return `Id=${unit}\nUnit=${unit.replace('.timer', '.service')}\nLoadState=loaded\nActiveState=active\n`
      }
      const adapters: Adapter[] = [
        ...parseUnitList(units).map((unit) => createSystemdAdapter(unit, { run })),
        createTimersAdapter('homelab', () => listUserTimers(run)),
      ]
      const stop = startPolling(adapters, stagger ? undefined : { windowMs: 0 })
      await vi.advanceTimersByTimeAsync(5 * 60_000)
      stop()
      return peak
    }

    const staggered = await peakInFlight(true)
    const together = await peakInFlight(false)
    console.info(`[stagger] peak concurrent systemctl: ${together} unstaggered, ${staggered} staggered`)
    expect(together).toBeGreaterThanOrEqual(24)
    expect(staggered).toBeLessThanOrEqual(5)
  })
})
