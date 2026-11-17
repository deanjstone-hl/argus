import { describe, expect, it, vi } from 'vitest'
import {
  BUDGET_API_CRON_SERVICE,
  BUDGET_API_CRON_TIMER,
  CLOUDFLARED_SERVICE,
  NOTICE_BOARD_SERVICE,
} from '../__fixtures__/systemd.js'
import { runCheck } from '../poller.js'
import { createSystemdAdapter, parseUnitList, type RunSystemctl } from './systemd.js'

vi.mock('../record-check.js', () => ({ recordCheck: vi.fn() }))

function fakeSystemctl(outputs: Record<string, string>): { run: RunSystemctl; calls: string[][] } {
  const calls: string[][] = []
  const run: RunSystemctl = async (args) => {
    calls.push(args)
    const unit = args.find((arg) => outputs[arg] !== undefined)
    if (unit === undefined) throw new Error(`unexpected systemctl ${args.join(' ')}`)
    return outputs[unit] as string
  }
  return { run, calls }
}

describe('parseUnitList', () => {
  it('reads user units bare and system units behind a system: prefix', () => {
    expect(parseUnitList('agent-engine.service, system:cloudflared.service,budget-api-cron.timer')).toEqual([
      { unit: 'agent-engine.service', scope: 'user' },
      { unit: 'cloudflared.service', scope: 'system' },
      { unit: 'budget-api-cron.timer', scope: 'user' },
    ])
  })

  it('is empty for an unset list', () => {
    expect(parseUnitList(undefined)).toEqual([])
  })
})

describe('createSystemdAdapter', () => {
  it('keeps the systemd:<unit> key on homelab', () => {
    const adapter = createSystemdAdapter({ unit: 'notice-board.service', scope: 'user' })
    expect(adapter.key).toBe('systemd:notice-board.service')
    expect(adapter.host).toBe('homelab')
  })

  it('reads a user service with --user, a system one without', async () => {
    const { run, calls } = fakeSystemctl({ 'notice-board.service': NOTICE_BOARD_SERVICE, 'cloudflared.service': CLOUDFLARED_SERVICE })
    await runCheck(createSystemdAdapter({ unit: 'notice-board.service', scope: 'user' }, { run }))
    await runCheck(createSystemdAdapter({ unit: 'cloudflared.service', scope: 'system' }, { run }))
    expect(calls[0]?.[0]).toBe('--user')
    expect(calls[1]).not.toContain('--user')
    expect(calls[1]?.[0]).toBe('show')
  })

  it('reports a running service as healthy', async () => {
    const { run } = fakeSystemctl({ 'notice-board.service': NOTICE_BOARD_SERVICE })
    const result = await runCheck(createSystemdAdapter({ unit: 'notice-board.service', scope: 'user' }, { run }))
    expect(result.status).toBe('healthy')
    expect(result.detail).toMatchObject({ activeState: 'active', subState: 'running', restarts: 2 })
  })

  it('follows a timer to the service it triggers and reports its last run', async () => {
    const { run, calls } = fakeSystemctl({
      'budget-api-cron.timer': BUDGET_API_CRON_TIMER,
      'budget-api-cron.service': BUDGET_API_CRON_SERVICE,
    })
    const result = await runCheck(createSystemdAdapter({ unit: 'budget-api-cron.timer', scope: 'user' }, { run }))
    expect(calls.map((args) => args.find((arg) => arg.includes('budget-api-cron')))).toEqual([
      'budget-api-cron.timer',
      'budget-api-cron.service',
    ])
    expect(result.status).toBe('healthy')
    expect(result.detail).toMatchObject({ timer: { lastTrigger: '2026-10-16T09:00:11.000Z', lastRun: { result: 'success' } } })
  })

  it('records a systemctl failure as down', async () => {
    const run: RunSystemctl = async () => {
      throw new Error('Failed to connect to bus')
    }
    const result = await runCheck(createSystemdAdapter({ unit: 'notice-board.service', scope: 'user' }, { run }))
    expect(result).toEqual({ status: 'down', detail: { error: 'Failed to connect to bus' } })
  })
})
