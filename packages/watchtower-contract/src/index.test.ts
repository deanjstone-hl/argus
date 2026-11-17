import { describe, expect, expectTypeOf, it } from 'vitest'
import {
  HEALTH_STATUSES,
  parseCheckInput,
  type CheckDetail,
  type GithubQueueDetail,
  type PrinterDetail,
  type ScannerDetail,
} from './index'

describe('parseCheckInput', () => {
  it.each(HEALTH_STATUSES)('accepts status %s', (status) => {
    expect(parseCheckInput({ service_key: 'x', host: 'homelab', status })).toEqual({
      service_key: 'x',
      host: 'homelab',
      status,
      detail: null,
    })
  })

  it('drops fields outside the contract', () => {
    const parsed = parseCheckInput({
      service_key: 'x',
      host: 'homelab',
      status: 'healthy',
      detail: { note: 'ok' },
      id: 'client-supplied-id',
      checked_at: '1970-01-01T00:00:00.000Z',
    })
    expect(parsed).toEqual({ service_key: 'x', host: 'homelab', status: 'healthy', detail: { note: 'ok' } })
  })

  it.each([
    ['null', null],
    ['a string', 'healthy'],
    ['a missing service_key', { host: 'homelab', status: 'healthy' }],
    ['an empty host', { service_key: 'x', host: '', status: 'healthy' }],
    ['an unknown status', { service_key: 'x', host: 'homelab', status: 'unknown' }],
    ['a string detail', { service_key: 'x', host: 'homelab', status: 'healthy', detail: 'ok' }],
  ])('rejects %s', (_label, value) => {
    expect(parseCheckInput(value)).toBeNull()
  })
})

describe('PrinterDetail', () => {
  it('is a CheckDetail, so the collector can record it as is', () => {
    const detail: PrinterDetail = {
      state: 'idle',
      reasons: [],
      message: null,
      model: 'EPSON WF-3820 Series',
      markers: [{ name: 'Black ink', color: '#000000', level: 80, lowLevel: 15, low: false }],
      queue: [],
      recentJobs: [{ id: 12, name: 'boarding-pass.pdf', user: 'mobile', state: 'completed', pages: 1, at: null }],
      clockSkewSeconds: null,
    }
    expectTypeOf(detail).toExtend<CheckDetail>()
    expect(parseCheckInput({ service_key: 'printer', host: 'homelab', status: 'healthy', detail })?.detail).toEqual(detail)
  })
})

describe('ScannerDetail', () => {
  it('is a CheckDetail, so the collector can record it as is', () => {
    const detail: ScannerDetail = {
      state: 'idle',
      adfState: 'empty',
      recentScans: [{ id: '00000000-0000-4000-a000-000000000013', state: 'completed', images: 1, at: null }],
    }
    expectTypeOf(detail).toExtend<CheckDetail>()
    expect(parseCheckInput({ service_key: 'scanner', host: 'homelab', status: 'healthy', detail })?.detail).toEqual(detail)
  })
})

describe('GithubQueueDetail', () => {
  const waitingJob = {
    repo: 'deanjstone/argus',
    workflow: 'CI',
    runId: 9,
    job: 'Build',
    runnerName: null,
    queuedAt: '2026-10-16T12:00:00Z',
    startedAt: null,
    selfHosted: true,
    url: 'https://github.com/deanjstone/argus/actions/runs/9/job/1',
  }
  const runningJob = { ...waitingJob, job: 'Test', runnerName: 'jit-argus-ab12', startedAt: '2026-10-16T12:05:00Z', selfHosted: false, url: null }

  it('carries the full waiting and in-progress job lists and is a CheckDetail', () => {
    const detail: GithubQueueDetail = {
      windowHours: 24,
      waiting: 1,
      oldestWaiting: { repo: waitingJob.repo, workflow: 'CI', job: 'Build', since: waitingJob.queuedAt, url: waitingJob.url },
      repos: [],
      waitingJobs: [waitingJob],
      inProgressJobs: [runningJob],
    }
    expectTypeOf(detail).toExtend<CheckDetail>()
    expect(parseCheckInput({ service_key: 'github-runners:queue', host: 'github-runners', status: 'healthy', detail })?.detail).toEqual(detail)
  })

  it('types a waiting job with no runner or start and a running job with both', () => {
    expectTypeOf<GithubQueueDetail['waitingJobs'][number]['runnerName']>().toEqualTypeOf<string | null>()
    expectTypeOf<GithubQueueDetail['inProgressJobs'][number]['startedAt']>().toEqualTypeOf<string | null>()
    expectTypeOf<GithubQueueDetail['waitingJobs'][number]['runId']>().toEqualTypeOf<number>()
  })
})
