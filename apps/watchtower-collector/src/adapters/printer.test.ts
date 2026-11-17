import { afterAll, beforeAll, describe, test, vi } from 'vitest'
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { PrinterDetail, PrinterMarkerDetail } from '@argus/watchtower-contract'
import { createPrinterAdapter, printerStatus, type IppPost } from './printer.js'
import { decodeResponse } from '../ipp.js'
import { runCheck } from '../poller.js'
import {
  FULL_INK,
  jobsResponse,
  NOT_POSSIBLE,
  printerAttributes,
  type JobFixture,
  type PrinterFixture,
} from './printer.fixtures.js'

// Failures are thrown by the adapter and mapped to a status by the poller, so
// every check goes through runCheck; recording the result is not under test.
vi.mock('../record-check.js', () => ({ recordCheck: vi.fn() }))

const URL = 'http://localhost:60000/ipp/print'
const NOW = new Date('2026-10-12T04:00:00.000Z')
const MINUTE = 60_000
const GET_JOBS = 0x000a
const GET_PRINTER_ATTRIBUTES = 0x000b

interface Scenario {
  printer?: PrinterFixture
  queue?: JobFixture[]
  completed?: JobFixture[]
  completedStatus?: number
}

interface Request {
  operation: number
  attributes: Record<string, unknown[]>
}

// Answers each request the way the printer would, by operation and, for
// Get-Jobs, by which-jobs.
function printerAt({ printer, queue = [], completed = [], completedStatus }: Scenario) {
  const requests: Request[] = []
  const post: IppPost = async (url, body) => {
    assert.equal(url, URL)
    // A request has the same layout as a response, with the operation-id
    // where the status-code would be.
    const decoded = decodeResponse(body)
    const request = { operation: decoded.statusCode, attributes: decoded.groups[0]?.attributes ?? {} }
    requests.push(request)
    if (request.operation === GET_PRINTER_ATTRIBUTES) return printerAttributes(printer)
    if (request.operation === GET_JOBS) {
      return request.attributes['which-jobs']?.[0] === 'completed'
        ? jobsResponse(completed, completedStatus)
        : jobsResponse(queue)
    }
    throw new Error(`unexpected operation ${request.operation}`)
  }
  const adapter = createPrinterAdapter({ url: URL }, { post, now: () => NOW })
  return { adapter, requests }
}

async function check(scenario: Scenario = {}) {
  const result = await runCheck(printerAt(scenario).adapter)
  return { status: result.status, detail: result.detail as PrinterDetail }
}

function marker(overrides: Partial<PrinterMarkerDetail> = {}): PrinterMarkerDetail {
  return { name: 'Black ink', color: '#000000', level: 70, lowLevel: 15, low: false, ...overrides }
}

describe('printer states', () => {
  test('idle, no reasons, full ink: healthy', async () => {
    const { status, detail } = await check()

    assert.equal(status, 'healthy')
    assert.equal(detail.state, 'idle')
    assert.deepEqual(detail.reasons, [])
    assert.equal(detail.model, 'EPSON WF-3820 Series')
    assert.deepEqual(
      detail.markers.map((m) => [m.name, m.color, m.level, m.lowLevel, m.low]),
      FULL_INK.map((ink) => [ink.name, ink.color, ink.level, 15, false]),
    )
  })

  test('processing a job: healthy', async () => {
    const { status, detail } = await check({
      printer: { state: 4, reasons: ['none'] },
      queue: [{ id: 41, name: 'tax-return.pdf', user: 'deanj', state: 5, pages: 2 }],
    })

    assert.equal(status, 'healthy')
    assert.equal(detail.state, 'processing')
  })

  test('stopped: down', async () => {
    const { status, detail } = await check({ printer: { state: 5, reasons: ['paused'] } })

    assert.equal(status, 'down')
    assert.equal(detail.state, 'stopped')
    assert.deepEqual(detail.reasons, ['paused'])
  })

  test('paper jam: down, with the reason and message passed through', async () => {
    const { status, detail } = await check({
      printer: { state: 5, reasons: ['media-jam-error'], message: 'Paper jam' },
    })

    assert.equal(status, 'down')
    assert.deepEqual(detail.reasons, ['media-jam-error'])
    assert.equal(detail.message, 'Paper jam')
  })

  test('an error reason is down even while the printer still says idle', async () => {
    const { status } = await check({ printer: { state: 3, reasons: ['media-empty-error'] } })

    assert.equal(status, 'down')
  })

  test('low ink: degraded, with the low cartridge flagged', async () => {
    const ink = FULL_INK.map((cartridge) =>
      cartridge.name === 'Cyan ink' ? { ...cartridge, level: 9, low: 10 } : cartridge,
    )
    const { status, detail } = await check({
      printer: { state: 3, reasons: ['marker-supply-low-warning'], ink },
    })

    assert.equal(status, 'degraded')
    assert.deepEqual(
      detail.markers.filter((m) => m.low).map((m) => m.name),
      ['Cyan ink'],
    )
  })

  test('low ink by level alone, with no reason reported: degraded', async () => {
    const ink = FULL_INK.map((cartridge) =>
      cartridge.name === 'Yellow ink' ? { ...cartridge, level: 15 } : cartridge,
    )
    const { status } = await check({ printer: { ink } })

    assert.equal(status, 'degraded')
  })

  test('a printer that cannot tell an ink level reports it as null, not low', async () => {
    const ink = FULL_INK.map((cartridge) =>
      cartridge.name === 'Black ink' ? { ...cartridge, level: -2 } : cartridge,
    )
    const { status, detail } = await check({ printer: { ink } })

    assert.equal(status, 'healthy')
    assert.deepEqual(detail.markers[0], marker({ level: null }))
  })
})

describe('printerStatus', () => {
  const base: PrinterDetail = {
    state: 'idle',
    reasons: [],
    message: null,
    model: null,
    markers: [marker()],
    queue: [],
    recentJobs: [],
    clockSkewSeconds: null,
  }

  test.each([
    ['idle', [], 'healthy'],
    ['processing', [], 'healthy'],
    ['stopped', [], 'down'],
    ['idle', ['media-jam-error'], 'down'],
    ['idle', ['cover-open-error'], 'down'],
    ['processing', ['media-empty-error'], 'down'],
    // RFC 8011 §5.4.12: a reason with no severity suffix is an error.
    ['idle', ['media-empty'], 'down'],
    ['idle', ['marker-supply-low-warning'], 'degraded'],
    ['idle', ['media-low-warning'], 'degraded'],
    // ...except the supply-low reasons, which printers often send bare.
    ['idle', ['marker-supply-low'], 'degraded'],
    ['idle', ['toner-low'], 'degraded'],
    // Reports are informational.
    ['idle', ['other-report'], 'healthy'],
    ['processing', ['marker-supply-low-warning', 'media-jam-error'], 'down'],
  ] as const)('%s with %j is %s', (state, reasons, expected) => {
    assert.equal(printerStatus({ ...base, state, reasons: [...reasons] }), expected)
  })

  test('a low cartridge degrades an otherwise healthy printer', () => {
    assert.equal(printerStatus({ ...base, markers: [marker({ level: 5, low: true })] }), 'degraded')
  })

  test('a low cartridge does not soften a stopped printer', () => {
    assert.equal(printerStatus({ ...base, state: 'stopped', markers: [marker({ level: 5, low: true })] }), 'down')
  })
})

describe('job queue', () => {
  test('an empty queue and no history', async () => {
    const { status, detail } = await check()

    assert.equal(status, 'healthy')
    assert.deepEqual(detail.queue, [])
    assert.deepEqual(detail.recentJobs, [])
  })

  test('pending jobs in print order and the newest five completed jobs first', async () => {
    const { detail } = await check({
      printer: { state: 4 },
      queue: [
        { id: 43, name: 'flyer.pdf', user: 'deanj', state: 3, pages: 0 },
        { id: 42, name: 'tax-return.pdf', user: 'deanj', state: 5, pages: 3 },
        { id: 44, name: 'photo.jpg', user: 'mobile', state: 4 },
      ],
      completed: [
        { id: 35, name: 'old.pdf', state: 9, pages: 1 },
        { id: 40, name: 'ticket.pdf', state: 9, pages: 1 },
        { id: 36, name: 'a.pdf', state: 9, pages: 1 },
        { id: 39, name: 'cancelled.pdf', state: 7, pages: 0 },
        { id: 37, name: 'b.pdf', state: 9, pages: 1 },
        { id: 38, name: 'jammed.pdf', state: 8, pages: 1 },
      ],
    })

    assert.deepEqual(
      detail.queue.map((job) => [job.id, job.name, job.user, job.state, job.pages]),
      [
        [42, 'tax-return.pdf', 'deanj', 'processing', 3],
        [43, 'flyer.pdf', 'deanj', 'pending', 0],
        [44, 'photo.jpg', 'mobile', 'pending-held', 0],
      ],
    )
    assert.deepEqual(
      detail.recentJobs.map((job) => [job.id, job.state]),
      [
        [40, 'completed'],
        [39, 'canceled'],
        [38, 'aborted'],
        [37, 'completed'],
        [36, 'completed'],
      ],
    )
  })

  test('asks for not-completed and completed jobs, plus the printer attributes it maps', async () => {
    const { adapter, requests } = printerAt({})

    await runCheck(adapter)

    const printer = requests.find((r) => r.operation === GET_PRINTER_ATTRIBUTES)
    assert.equal(printer?.attributes['printer-uri']?.[0], 'ipp://localhost:60000/ipp/print')
    for (const name of ['printer-state', 'printer-state-reasons', 'marker-levels', 'printer-current-time']) {
      assert.ok(printer?.attributes['requested-attributes']?.includes(name), name)
    }
    assert.deepEqual(
      requests.filter((r) => r.operation === GET_JOBS).map((r) => r.attributes['which-jobs']?.[0]).sort(),
      ['completed', 'not-completed'],
    )
  })

  test('a printer that keeps no job history still reports its queue', async () => {
    const { status, detail } = await check({
      queue: [{ id: 50, name: 'doc.pdf', state: 3 }],
      completedStatus: NOT_POSSIBLE,
    })

    assert.equal(status, 'healthy')
    assert.equal(detail.queue.length, 1)
    assert.deepEqual(detail.recentJobs, [])
  })
})

describe("the printer's clock", () => {
  // The WF-3825's clock runs about two hours ahead (argus#591).
  const SKEW = 2 * 60 * MINUTE
  const ahead = (date: Date) => new Date(date.getTime() + SKEW)

  test('corrects date-time-at-* by the skew between printer-current-time and ours', async () => {
    const completedAt = new Date(NOW.getTime() - 10 * MINUTE)
    const createdAt = new Date(NOW.getTime() - MINUTE)
    const { detail } = await check({
      printer: { currentTime: ahead(NOW) },
      queue: [{ id: 2, name: 'b.pdf', state: 3, createdAt: ahead(createdAt) }],
      completed: [{ id: 1, name: 'a.pdf', state: 9, completedAt: ahead(completedAt) }],
    })

    assert.equal(detail.clockSkewSeconds, SKEW / 1000)
    assert.equal(detail.recentJobs[0]?.at, completedAt.toISOString())
    assert.equal(detail.queue[0]?.at, createdAt.toISOString())
  })

  test('without printer-current-time, dates the job from time-at-* against printer-up-time', async () => {
    const { detail } = await check({
      printer: { upTime: 5_000 },
      completed: [{ id: 1, name: 'a.pdf', state: 9, completedAt: ahead(NOW), timeAtCompleted: 4_400 }],
    })

    assert.equal(detail.clockSkewSeconds, null)
    assert.equal(detail.recentJobs[0]?.at, new Date(NOW.getTime() - 600_000).toISOString())
  })

  test('with neither, leaves the time out rather than trusting the printer clock', async () => {
    const { detail } = await check({
      completed: [{ id: 1, name: 'a.pdf', state: 9, completedAt: ahead(NOW) }],
    })

    assert.equal(detail.recentJobs[0]?.at, null)
  })
})

describe('failures', () => {
  let server: Server
  let baseUrl: string

  beforeAll(async () => {
    server = createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', (chunk: Buffer) => chunks.push(chunk))
      req.on('end', () => {
        if (req.url === '/bad-request') {
          res.writeHead(400).end('Bad Request')
          return
        }
        if (req.url === '/garbage') {
          res.writeHead(200, { 'content-type': 'application/ipp' }).end('not ipp')
          return
        }
        if (req.headers['content-type'] !== 'application/ipp') {
          res.writeHead(415).end()
          return
        }
        const operation = decodeResponse(new Uint8Array(Buffer.concat(chunks))).statusCode
        res.writeHead(200, { 'content-type': 'application/ipp' })
        res.end(Buffer.from(operation === GET_PRINTER_ATTRIBUTES ? printerAttributes() : jobsResponse([])))
      })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })

  afterAll(() => {
    server.close()
  })

  test('the default transport POSTs application/ipp and reads the reply', async () => {
    const result = await runCheck(createPrinterAdapter({ url: `${baseUrl}/ipp/print` }))

    assert.equal(result.status, 'healthy', JSON.stringify(result.detail))
  })

  test('nothing listening (ipp-usb not running, printer off or unplugged): unreachable with a reason', async () => {
    const closed = createServer()
    await new Promise<void>((resolve) => closed.listen(0, '127.0.0.1', resolve))
    const { port } = closed.address() as AddressInfo
    await new Promise<void>((resolve) => closed.close(() => resolve()))
    const adapter = createPrinterAdapter({ url: `http://127.0.0.1:${port}/ipp/print` })

    const result = await runCheck(adapter)

    assert.equal(result.status, 'unreachable')
    assert.match(String(result.detail?.error), /not answering/)
    assert.match(String(result.detail?.error), /ECONN(REFUSED|RESET)/)
  })

  test('an HTTP error from the printer is down, not unreachable: it answered', async () => {
    const result = await runCheck(createPrinterAdapter({ url: `${baseUrl}/bad-request` }))

    assert.equal(result.status, 'down')
    assert.match(String(result.detail?.error), /400/)
  })

  test('a reply that is not IPP is down', async () => {
    const result = await runCheck(createPrinterAdapter({ url: `${baseUrl}/garbage` }))

    assert.equal(result.status, 'down')
    assert.match(String(result.detail?.error), /IPP/)
  })

  test('an IPP error status for the printer attributes is down', async () => {
    const post: IppPost = async () => jobsResponse([], 0x0400)
    const result = await runCheck(createPrinterAdapter({ url: URL }, { post }))

    assert.equal(result.status, 'down')
    assert.match(String(result.detail?.error), /0x0400/)
  })
})
