// A minimal IPP/2.0 codec (RFC 8010): enough to encode a request whose
// attributes are all simple values, and to decode any response, collections
// included. It does no I/O, so the printer adapter can be tested on bytes.

export const IppTag = {
  operationAttributes: 0x01,
  jobAttributes: 0x02,
  endOfAttributes: 0x03,
  printerAttributes: 0x04,
  integer: 0x21,
  boolean: 0x22,
  enum: 0x23,
  dateTime: 0x31,
  resolution: 0x32,
  rangeOfInteger: 0x33,
  begCollection: 0x34,
  textWithLanguage: 0x35,
  nameWithLanguage: 0x36,
  endCollection: 0x37,
  textWithoutLanguage: 0x41,
  nameWithoutLanguage: 0x42,
  keyword: 0x44,
  uri: 0x45,
  charset: 0x47,
  naturalLanguage: 0x48,
  mimeMediaType: 0x49,
  memberAttrName: 0x4a,
} as const

export interface IppCollection {
  [member: string]: IppValue[]
}

export type IppValue = string | number | boolean | Date | null | IppCollection

export interface IppAttributeGroup {
  tag: number
  attributes: Record<string, IppValue[]>
}

export interface IppResponse {
  statusCode: number
  requestId: number
  groups: IppAttributeGroup[]
}

export interface IppRequestAttribute {
  tag: number
  name: string
  values: Array<string | number | boolean>
}

export class IppDecodeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'IppDecodeError'
  }
}

// Requests go into the operation-attributes group, which is all Get-Jobs and
// Get-Printer-Attributes need.
export function encodeRequest(operationId: number, requestId: number, attributes: IppRequestAttribute[]): Uint8Array {
  const parts: Buffer[] = []
  const header = Buffer.alloc(8)
  header.writeUInt8(2, 0)
  header.writeUInt8(0, 1)
  header.writeUInt16BE(operationId, 2)
  header.writeUInt32BE(requestId, 4)
  parts.push(header, Buffer.from([IppTag.operationAttributes]))

  for (const attribute of attributes) {
    attribute.values.forEach((value, index) => {
      const name = Buffer.from(index === 0 ? attribute.name : '', 'utf8')
      const encoded = encodeValue(attribute.tag, value)
      const prefix = Buffer.alloc(3)
      prefix.writeUInt8(attribute.tag, 0)
      prefix.writeUInt16BE(name.length, 1)
      const length = Buffer.alloc(2)
      length.writeUInt16BE(encoded.length, 0)
      parts.push(prefix, name, length, encoded)
    })
  }

  parts.push(Buffer.from([IppTag.endOfAttributes]))
  return new Uint8Array(Buffer.concat(parts))
}

function encodeValue(tag: number, value: string | number | boolean): Buffer {
  if (tag === IppTag.integer || tag === IppTag.enum) {
    const buffer = Buffer.alloc(4)
    buffer.writeInt32BE(Number(value), 0)
    return buffer
  }
  if (tag === IppTag.boolean) return Buffer.from([value ? 1 : 0])
  return Buffer.from(String(value), 'utf8')
}

class Reader {
  private offset = 0
  private readonly view: DataView

  constructor(private readonly bytes: Uint8Array) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  }

  get done(): boolean {
    return this.offset >= this.bytes.length
  }

  private need(count: number): void {
    if (this.offset + count > this.bytes.length) {
      throw new IppDecodeError(`truncated IPP message at byte ${this.offset} (needed ${count} more)`)
    }
  }

  uint8(): number {
    this.need(1)
    return this.view.getUint8(this.offset++)
  }

  uint16(): number {
    this.need(2)
    const value = this.view.getUint16(this.offset)
    this.offset += 2
    return value
  }

  int32(): number {
    this.need(4)
    const value = this.view.getInt32(this.offset)
    this.offset += 4
    return value
  }

  slice(count: number): Uint8Array {
    this.need(count)
    const value = this.bytes.subarray(this.offset, this.offset + count)
    this.offset += count
    return value
  }

  string(count: number): string {
    return Buffer.from(this.slice(count)).toString('utf8')
  }
}

function decodeDateTime(bytes: Uint8Array): Date {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const utc = Date.UTC(
    view.getUint16(0),
    view.getUint8(2) - 1,
    view.getUint8(3),
    view.getUint8(4),
    view.getUint8(5),
    view.getUint8(6),
    view.getUint8(7) * 100,
  )
  const sign = String.fromCharCode(view.getUint8(8)) === '-' ? -1 : 1
  const offsetMinutes = view.getUint8(9) * 60 + view.getUint8(10)
  return new Date(utc - sign * offsetMinutes * 60_000)
}

function decodeValue(tag: number, bytes: Uint8Array): IppValue {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  // 0x10-0x1f are out-of-band values (unsupported, unknown, no-value).
  if (tag >= 0x10 && tag <= 0x1f) return null
  switch (tag) {
    case IppTag.integer:
    case IppTag.enum:
      if (bytes.length !== 4) throw new IppDecodeError(`integer value of ${bytes.length} bytes`)
      return view.getInt32(0)
    case IppTag.boolean:
      return bytes[0] === 1
    case IppTag.dateTime:
      if (bytes.length !== 11) throw new IppDecodeError(`dateTime value of ${bytes.length} bytes`)
      return decodeDateTime(bytes)
    case IppTag.rangeOfInteger:
      return `${view.getInt32(0)}-${view.getInt32(4)}`
    case IppTag.resolution:
      return `${view.getInt32(0)}x${view.getInt32(4)}${view.getInt8(8) === 3 ? 'dpi' : 'dpcm'}`
    case IppTag.textWithLanguage:
    case IppTag.nameWithLanguage: {
      // language-length, language, text-length, text
      const languageLength = view.getUint16(0)
      const textLength = view.getUint16(2 + languageLength)
      return Buffer.from(bytes.subarray(4 + languageLength, 4 + languageLength + textLength)).toString('utf8')
    }
    default:
      return Buffer.from(bytes).toString('utf8')
  }
}

// A collection's members arrive as memberAttrName/value pairs, a member with
// several values repeats its value with no name, and a nested collection opens
// with its own begCollection.
function readCollection(reader: Reader): IppCollection {
  const collection: IppCollection = {}
  let member: string | null = null
  for (;;) {
    const tag = reader.uint8()
    reader.slice(reader.uint16())
    if (tag === IppTag.endCollection) {
      reader.slice(reader.uint16())
      return collection
    }
    if (tag === IppTag.memberAttrName) {
      member = reader.string(reader.uint16())
      collection[member] = []
      continue
    }
    if (member === null) throw new IppDecodeError('collection value before any member name')
    collection[member]?.push(readValue(tag, reader))
  }
}

function readValue(tag: number, reader: Reader): IppValue {
  const length = reader.uint16()
  if (tag === IppTag.begCollection) {
    reader.slice(length)
    return readCollection(reader)
  }
  return decodeValue(tag, reader.slice(length))
}

export function decodeResponse(bytes: Uint8Array): IppResponse {
  const reader = new Reader(bytes)
  reader.uint16()
  const statusCode = reader.uint16()
  const requestId = reader.int32()
  const groups: IppAttributeGroup[] = []
  let group: IppAttributeGroup | null = null
  let current: IppValue[] | null = null

  while (!reader.done) {
    const tag = reader.uint8()
    if (tag === IppTag.endOfAttributes) return { statusCode, requestId, groups }
    // 0x00-0x0f delimit attribute groups.
    if (tag < 0x10) {
      group = { tag, attributes: {} }
      groups.push(group)
      current = null
      continue
    }
    const name = reader.string(reader.uint16())
    if (group === null) throw new IppDecodeError('attribute before any attribute group')
    if (name !== '') {
      current = []
      group.attributes[name] = current
    }
    if (current === null) throw new IppDecodeError('additional value with no attribute to belong to')
    current.push(readValue(tag, reader))
  }
  throw new IppDecodeError('IPP message ended without an end-of-attributes tag')
}
