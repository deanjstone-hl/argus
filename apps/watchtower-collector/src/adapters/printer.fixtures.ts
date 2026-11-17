// Builds IPP response bodies for the printer adapter's tests. It writes bytes
// itself rather than reusing the codec, so a codec bug cannot cancel itself
// out in a round trip.
//
// Attribute values follow what the WF-3825 behind ipp-usb reported when
// checked live on 2026-10-09; see argus#591.

const TAG = {
  operation: 0x01,
  job: 0x02,
  end: 0x03,
  printer: 0x04,
  noValue: 0x13,
  integer: 0x21,
  boolean: 0x22,
  enum: 0x23,
  dateTime: 0x31,
  text: 0x41,
  name: 0x42,
  keyword: 0x44,
  uri: 0x45,
  charset: 0x47,
  language: 0x48,
} as const

type Value = string | number | boolean | Date | null
type Attribute = [name: string, tag: number, values: Value[]]

function dateTimeBytes(date: Date): Buffer {
  const bytes = Buffer.alloc(11)
  bytes.writeUInt16BE(date.getUTCFullYear(), 0)
  bytes.writeUInt8(date.getUTCMonth() + 1, 2)
  bytes.writeUInt8(date.getUTCDate(), 3)
  bytes.writeUInt8(date.getUTCHours(), 4)
  bytes.writeUInt8(date.getUTCMinutes(), 5)
  bytes.writeUInt8(date.getUTCSeconds(), 6)
  bytes.writeUInt8(Math.floor(date.getUTCMilliseconds() / 100), 7)
  bytes.write('+', 8, 'latin1')
  return bytes
}

function valueBytes(tag: number, value: Value): Buffer {
  if (value === null) return Buffer.alloc(0)
  if (value instanceof Date) return dateTimeBytes(value)
  if (tag === TAG.integer || tag === TAG.enum) {
    const bytes = Buffer.alloc(4)
    bytes.writeInt32BE(Number(value), 0)
    return bytes
  }
  if (tag === TAG.boolean) return Buffer.from([value ? 1 : 0])
  return Buffer.from(String(value), 'utf8')
}

function attributeBytes([name, tag, values]: Attribute): Buffer[] {
  return values.map((value, index) => {
    const valueTag = value === null ? TAG.noValue : tag
    const nameBytes = Buffer.from(index === 0 ? name : '', 'utf8')
    const encoded = valueBytes(valueTag, value)
    const head = Buffer.alloc(3)
    head.writeUInt8(valueTag, 0)
    head.writeUInt16BE(nameBytes.length, 1)
    const length = Buffer.alloc(2)
    length.writeUInt16BE(encoded.length, 0)
    return Buffer.concat([head, nameBytes, length, encoded])
  })
}

export function ippResponse(statusCode: number, groups: Array<[tag: number, attributes: Attribute[]]>): Uint8Array {
  const header = Buffer.alloc(8)
  header.writeUInt8(2, 0)
  header.writeUInt16BE(statusCode, 2)
  header.writeUInt32BE(1, 4)
  const operation: Attribute[] = [
    ['attributes-charset', TAG.charset, ['utf-8']],
    ['attributes-natural-language', TAG.language, ['en']],
  ]
  const parts = [header]
  for (const [tag, attributes] of [[TAG.operation, operation] as const, ...groups]) {
    parts.push(Buffer.from([tag]), ...attributes.flatMap(attributeBytes))
  }
  parts.push(Buffer.from([TAG.end]))
  return new Uint8Array(Buffer.concat(parts))
}

export interface InkFixture {
  name: string
  color: string
  level: number
  low?: number
}

export const FULL_INK: InkFixture[] = [
  { name: 'Black ink', color: '#000000', level: 70 },
  { name: 'Cyan ink', color: '#00FFFF', level: 55 },
  { name: 'Magenta ink', color: '#FF00FF', level: 60 },
  { name: 'Yellow ink', color: '#FFFF00', level: 45 },
]

export interface PrinterFixture {
  state?: 3 | 4 | 5
  reasons?: string[]
  message?: string | null
  ink?: InkFixture[]
  currentTime?: Date
  upTime?: number
}

export function printerAttributes({
  state = 3,
  reasons = ['none'],
  message = null,
  ink = FULL_INK,
  currentTime,
  upTime = 86_400,
}: PrinterFixture = {}): Uint8Array {
  const attributes: Attribute[] = [
    ['printer-state', TAG.enum, [state]],
    ['printer-state-reasons', TAG.keyword, reasons],
    ['printer-state-message', TAG.text, [message]],
    ['printer-make-and-model', TAG.text, ['EPSON WF-3820 Series']],
    ['printer-is-accepting-jobs', TAG.boolean, [true]],
    ['printer-up-time', TAG.integer, [upTime]],
  ]
  if (currentTime) attributes.push(['printer-current-time', TAG.dateTime, [currentTime]])
  if (ink.length > 0) {
    attributes.push(
      ['marker-names', TAG.name, ink.map((cartridge) => cartridge.name)],
      ['marker-colors', TAG.name, ink.map((cartridge) => cartridge.color)],
      ['marker-types', TAG.keyword, ink.map(() => 'ink-cartridge')],
      ['marker-levels', TAG.integer, ink.map((cartridge) => cartridge.level)],
      ['marker-low-levels', TAG.integer, ink.map((cartridge) => cartridge.low ?? 15)],
      ['marker-high-levels', TAG.integer, ink.map(() => 100)],
    )
  }
  return ippResponse(0x0000, [[TAG.printer, attributes]])
}

export interface JobFixture {
  id: number
  name: string
  user?: string
  state: 3 | 4 | 5 | 6 | 7 | 8 | 9
  pages?: number
  createdAt?: Date
  completedAt?: Date
  timeAtCreation?: number
  timeAtCompleted?: number
}

export function jobsResponse(jobs: JobFixture[], statusCode = 0x0000): Uint8Array {
  return ippResponse(
    statusCode,
    jobs.map((job): [number, Attribute[]] => {
      const attributes: Attribute[] = [
        ['job-id', TAG.integer, [job.id]],
        ['job-name', TAG.name, [job.name]],
        ['job-originating-user-name', TAG.name, [job.user ?? 'mobile']],
        ['job-state', TAG.enum, [job.state]],
        ['job-impressions-completed', TAG.integer, [job.pages ?? 0]],
      ]
      if (job.createdAt) attributes.push(['date-time-at-creation', TAG.dateTime, [job.createdAt]])
      if (job.completedAt) attributes.push(['date-time-at-completed', TAG.dateTime, [job.completedAt]])
      if (job.timeAtCreation !== undefined) attributes.push(['time-at-creation', TAG.integer, [job.timeAtCreation]])
      if (job.timeAtCompleted !== undefined) attributes.push(['time-at-completed', TAG.integer, [job.timeAtCompleted]])
      return [TAG.job, attributes]
    }),
  )
}

// client-error-not-possible, which a printer that keeps no job history may
// answer to which-jobs=completed.
export const NOT_POSSIBLE = 0x0404
