import { afterAll, beforeAll, describe, test, vi } from 'vitest'
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { ScannerDetail } from '@argus/watchtower-contract'
import { createScannerAdapter } from './scanner.js'
import { runCheck } from '../poller.js'

// Failures are thrown by the adapter and mapped to a status by the poller, so
// every check goes through runCheck; recording the result is not under test.
vi.mock('../record-check.js', () => ({ recordCheck: vi.fn() }))

const NOW = new Date('2026-10-15T00:00:00.000Z')

// GET /eSCL/ScannerStatus as the homelab WF-3825 answered it on 2026-10-15.
const LIVE_STATUS =
  '<?xml version="1.0" encoding="UTF-8"?><scan:ScannerStatus xmlns:scan="http://schemas.hp.com/imaging/escl/2011/05/03" xmlns:pwg="http://www.pwg.org/schemas/2010/12/sm"><pwg:Version>2.63</pwg:Version><pwg:State>Idle</pwg:State><scan:AdfState>ScannerAdfEmpty</scan:AdfState><scan:Jobs><scan:JobInfo><pwg:JobUuid>00000000-0000-4000-a000-000000000013</pwg:JobUuid><pwg:JobUri>/eSCL/ScanJobs/00000000-0000-4000-a000-000000000013</pwg:JobUri><scan:Age>479931</scan:Age><pwg:ImagesCompleted>1</pwg:ImagesCompleted><pwg:JobState>Completed</pwg:JobState></scan:JobInfo><scan:JobInfo><pwg:JobUuid>00000000-0000-4000-b000-000000000014</pwg:JobUuid><pwg:JobUri>/eSCL/ScanJobs/00000000-0000-4000-b000-000000000014</pwg:JobUri><scan:Age>480903</scan:Age><pwg:ImagesCompleted>3</pwg:ImagesCompleted><pwg:JobState>Completed</pwg:JobState></scan:JobInfo></scan:Jobs></scan:ScannerStatus>'

interface JobFixture {
  uuid: string
  age?: number
  images?: number
  state: string
}

function statusXml({ state = 'Idle', adf, jobs = [] }: { state?: string; adf?: string; jobs?: JobFixture[] } = {}) {
  const jobXml = jobs
    .map(
      (job) =>
        `<scan:JobInfo><pwg:JobUuid>${job.uuid}</pwg:JobUuid>` +
        (job.age === undefined ? '' : `<scan:Age>${job.age}</scan:Age>`) +
        (job.images === undefined ? '' : `<pwg:ImagesCompleted>${job.images}</pwg:ImagesCompleted>`) +
        `<pwg:JobState>${job.state}</pwg:JobState></scan:JobInfo>`,
    )
    .join('')
  return (
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<scan:ScannerStatus xmlns:scan="http://schemas.hp.com/imaging/escl/2011/05/03" xmlns:pwg="http://www.pwg.org/schemas/2010/12/sm">' +
    `<pwg:Version>2.63</pwg:Version><pwg:State>${state}</pwg:State>` +
    (adf === undefined ? '' : `<scan:AdfState>${adf}</scan:AdfState>`) +
    (jobs.length > 0 ? `<scan:Jobs>${jobXml}</scan:Jobs>` : '') +
    '</scan:ScannerStatus>'
  )
}

// A stand-in for ipp-usb's eSCL endpoint: GET /eSCL/ScannerStatus answers with
// whatever the test last set, and anything else is a 404.
let server: Server
let baseUrl: string
let reply: { status: number; body: string } = { status: 200, body: LIVE_STATUS }
const requests: Array<{ method: string; url: string }> = []

beforeAll(async () => {
  server = createServer((req, res) => {
    requests.push({ method: req.method ?? '', url: req.url ?? '' })
    if (req.method !== 'GET' || req.url !== '/eSCL/ScannerStatus') {
      res.writeHead(404).end()
      return
    }
    res.writeHead(reply.status, { 'content-type': 'text/xml' }).end(reply.body)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/eSCL`
})

afterAll(() => {
  server.close()
})

async function check(body: string, status = 200) {
  reply = { status, body }
  const result = await runCheck(createScannerAdapter({ url: baseUrl }, { now: () => NOW }))
  return { status: result.status, detail: result.detail as ScannerDetail }
}

describe('scanner adapter', () => {
  test('is the homelab scanner check, and only ever reads ScannerStatus', async () => {
    requests.length = 0
    const adapter = createScannerAdapter({ url: baseUrl })
    await runCheck(adapter)

    assert.equal(adapter.key, 'scanner')
    assert.equal(adapter.host, 'homelab')
    assert.deepEqual(requests, [{ method: 'GET', url: '/eSCL/ScannerStatus' }])
  })

  test('the live reply: idle, feeder empty, both recent scans dated from their age', async () => {
    const { status, detail } = await check(LIVE_STATUS)

    assert.equal(status, 'healthy')
    assert.deepEqual(detail, {
      state: 'idle',
      adfState: 'empty',
      recentScans: [
        {
          id: '00000000-0000-4000-a000-000000000013',
          state: 'completed',
          images: 1,
          at: new Date(NOW.getTime() - 479_931_000).toISOString(),
        },
        {
          id: '00000000-0000-4000-b000-000000000014',
          state: 'completed',
          images: 3,
          at: new Date(NOW.getTime() - 480_903_000).toISOString(),
        },
      ],
    })
  })

  test('a scan in progress with paper in the feeder is healthy', async () => {
    const { status, detail } = await check(
      statusXml({ state: 'Processing', adf: 'ScannerAdfProcessing', jobs: [{ uuid: 'a', age: 5, state: 'Processing' }] }),
    )

    assert.equal(status, 'healthy')
    assert.equal(detail.state, 'processing')
    assert.equal(detail.adfState, 'processing')
    assert.equal(detail.recentScans[0]?.state, 'processing')
  })

  test.each([
    ['ScannerAdfJam', 'jam'],
    ['ScannerAdfDoorOpen', 'door-open'],
    ['ScannerAdfMultipickDetected', 'multipick-detected'],
  ])('a feeder fault (%s) is degraded', async (adf, adfState) => {
    const { status, detail } = await check(statusXml({ adf }))

    assert.equal(status, 'degraded')
    assert.equal(detail.adfState, adfState)
  })

  test('a loaded feeder is fine', async () => {
    assert.equal((await check(statusXml({ adf: 'ScannerAdfLoaded' }))).status, 'healthy')
  })

  test('no AdfState (a flatbed-only reply) leaves the feeder unknown, not faulty', async () => {
    const { status, detail } = await check(statusXml())

    assert.equal(status, 'healthy')
    assert.equal(detail.adfState, null)
    assert.deepEqual(detail.recentScans, [])
  })

  test.each([['Stopped'], ['Down']])('a %s scanner is down', async (state) => {
    const { status, detail } = await check(statusXml({ state }))

    assert.equal(status, 'down')
    assert.equal(detail.state, state.toLowerCase())
  })

  test('keeps the five newest scans, newest first, and tolerates missing age and counts', async () => {
    const jobs: JobFixture[] = [
      { uuid: 'old', age: 900, images: 1, state: 'Completed' },
      { uuid: 'newest', age: 10, images: 2, state: 'Aborted' },
      { uuid: 'mid', age: 300, images: 1, state: 'Canceled' },
      { uuid: 'older', age: 600, images: 1, state: 'Completed' },
      { uuid: 'new', age: 60, images: 1, state: 'Pending' },
      { uuid: 'oldest', age: 1200, images: 1, state: 'Completed' },
      { uuid: 'undated', state: 'Completed' },
    ]
    const { detail } = await check(statusXml({ jobs }))

    assert.deepEqual(
      detail.recentScans.map((scan) => [scan.id, scan.state]),
      [
        ['newest', 'aborted'],
        ['new', 'pending'],
        ['mid', 'canceled'],
        ['older', 'completed'],
        ['old', 'completed'],
      ],
    )
    const undated = (await check(statusXml({ jobs: [{ uuid: 'undated', state: 'Weird' }] }))).detail.recentScans[0]
    assert.deepEqual(undated, { id: 'undated', state: 'unknown', images: null, at: null })
  })

  test('an HTTP error is down', async () => {
    const { status, detail } = await check('busy', 503)

    assert.equal(status, 'down')
    assert.match(JSON.stringify(detail), /HTTP 503/)
  })

  test('a reply that is not a ScannerStatus is down', async () => {
    const result = await check('<html>not escl</html>')

    assert.equal(result.status, 'down')
    assert.match(JSON.stringify(result.detail), /ScannerStatus/)
  })

  test('nothing listening (ipp-usb not running, printer off or unplugged): unreachable with a reason', async () => {
    const closed = createServer()
    await new Promise<void>((resolve) => closed.listen(0, '127.0.0.1', resolve))
    const { port } = closed.address() as AddressInfo
    await new Promise<void>((resolve) => closed.close(() => resolve()))

    const result = await runCheck(createScannerAdapter({ url: `http://127.0.0.1:${port}/eSCL` }))

    assert.equal(result.status, 'unreachable')
    assert.match(String(result.detail?.error), /not answering/)
    assert.match(String(result.detail?.error), /ECONN(REFUSED|RESET)/)
  })
})
