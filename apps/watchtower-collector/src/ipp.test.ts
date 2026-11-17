import { describe, test } from 'vitest'
import assert from 'node:assert/strict'
import { decodeResponse, encodeRequest, IppDecodeError, IppTag } from './ipp.js'

function hex(text: string): Uint8Array {
  return Uint8Array.from(Buffer.from(text.replace(/\s+/g, ''), 'hex'))
}

describe('encodeRequest', () => {
  // RFC 8010 §3.1.1: version, operation-id, request-id, then each attribute
  // as value-tag, name-length, name, value-length, value. Extra values of
  // the same attribute repeat with an empty name.
  test('lays out the header, operation attributes and end tag byte for byte', () => {
    const bytes = encodeRequest(0x000b, 7, [
      { tag: IppTag.charset, name: 'attributes-charset', values: ['utf-8'] },
      { tag: IppTag.keyword, name: 'requested-attributes', values: ['printer-state', 'marker-levels'] },
      { tag: IppTag.integer, name: 'limit', values: [3] },
      { tag: IppTag.boolean, name: 'my-jobs', values: [false] },
    ])

    const expected = hex(`
      0200 000b 00000007
      01
      47 0012 ${Buffer.from('attributes-charset').toString('hex')} 0005 ${Buffer.from('utf-8').toString('hex')}
      44 0014 ${Buffer.from('requested-attributes').toString('hex')} 000d ${Buffer.from('printer-state').toString('hex')}
      44 0000 000d ${Buffer.from('marker-levels').toString('hex')}
      21 0005 ${Buffer.from('limit').toString('hex')} 0004 00000003
      22 0007 ${Buffer.from('my-jobs').toString('hex')} 0001 00
      03
    `)
    assert.deepEqual(bytes, expected)
  })
})

describe('decodeResponse', () => {
  test('reads a hand-encoded response: status, groups, multi-valued and typed attributes', () => {
    const name = (text: string) => `${text.length.toString(16).padStart(4, '0')}${Buffer.from(text).toString('hex')}`
    const bytes = hex(`
      0200 0000 0000002a
      01
      47 ${name('attributes-charset')} ${name('utf-8')}
      04
      23 ${name('printer-state')} 0004 00000003
      44 ${name('printer-state-reasons')} ${name('media-empty-error')}
      44 0000 ${name('marker-supply-low-warning')}
      21 ${name('marker-levels')} 0004 ffffffff
      21 0000 0004 00000050
      22 ${name('printer-is-accepting-jobs')} 0001 01
      31 ${name('printer-current-time')} 000b 07ea0a0c 0e1e00 00 2b0a00
      13 ${name('printer-state-message')} 0000
      03
    `)

    const response = decodeResponse(bytes)

    assert.equal(response.statusCode, 0)
    assert.equal(response.requestId, 42)
    assert.equal(response.groups.length, 2)
    assert.equal(response.groups[0]?.tag, IppTag.operationAttributes)
    const printer = response.groups[1]
    assert.equal(printer?.tag, IppTag.printerAttributes)
    assert.deepEqual(printer?.attributes['printer-state'], [3])
    assert.deepEqual(printer?.attributes['printer-state-reasons'], ['media-empty-error', 'marker-supply-low-warning'])
    assert.deepEqual(printer?.attributes['marker-levels'], [-1, 80])
    assert.deepEqual(printer?.attributes['printer-is-accepting-jobs'], [true])
    // 2026-10-12 14:30:00.0 +10:00 is 04:30 UTC.
    assert.deepEqual(printer?.attributes['printer-current-time'], [new Date('2026-10-12T04:30:00.000Z')])
    // An out-of-band value (no-value) carries no bytes and decodes to null.
    assert.deepEqual(printer?.attributes['printer-state-message'], [null])
  })

  test('decodes a collection into an object of its member attributes', () => {
    const name = (text: string) => `${text.length.toString(16).padStart(4, '0')}${Buffer.from(text).toString('hex')}`
    const bytes = hex(`
      0200 0000 00000001
      04
      34 ${name('media-col-default')} 0000
      4a 0000 ${name('media-type')}
      44 0000 ${name('stationery')}
      4a 0000 ${name('media-source')}
      44 0000 ${name('main')}
      37 0000 0000
      23 ${name('printer-state')} 0004 00000004
      03
    `)

    const attributes = decodeResponse(bytes).groups[0]?.attributes

    assert.deepEqual(attributes?.['media-col-default'], [{ 'media-type': ['stationery'], 'media-source': ['main'] }])
    assert.deepEqual(attributes?.['printer-state'], [4])
  })

  test('throws IppDecodeError for a truncated body rather than reading past the end', () => {
    assert.throws(() => decodeResponse(hex('0200 0000 0000')), IppDecodeError)
    assert.throws(() => decodeResponse(hex('0200 0000 00000001 04 23 000d 7072')), IppDecodeError)
  })

  test('throws IppDecodeError when the end-of-attributes tag never arrives', () => {
    assert.throws(() => decodeResponse(hex('0200 0000 00000001 04')), IppDecodeError)
  })
})
