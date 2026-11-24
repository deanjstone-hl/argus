import { describe, expect, it } from 'vitest'

import { applyDirectivesPatch, diffDirectives } from '../src/directive-patch.js'

// argus#75: the pure half of directives_set's patch mode.

const CURRENT = { max_slots: 2, trunk_repos: ['a/one', 'a/two'], host_gates: { wsl2: { max_load: 4 } }, overrides: [{ key: 'max_slots', value: 1 }] }

const problemsOf = (patch: unknown) => {
  const result = applyDirectivesPatch(CURRENT, patch)
  if (!('problems' in result)) throw new Error('expected problems')
  return result.problems
}
const recordOf = (patch: unknown) => {
  const result = applyDirectivesPatch(CURRENT, patch)
  if (!('record' in result)) throw new Error(`expected a record, got ${result.problems.join('; ')}`)
  return result.record
}

describe('applyDirectivesPatch', () => {
  it('never changes the record it was given', () => {
    const before = structuredClone(CURRENT)
    recordOf({ remove: { trunk_repos: ['a/one'] }, set: { max_slots: 3 } })
    expect(CURRENT).toEqual(before)
  })

  it('replaces a whole mapping with set', () => {
    expect(recordOf({ set: { host_gates: { homelab: { max_load: 2 } } } }).host_gates).toEqual({ homelab: { max_load: 2 } })
  })

  it('appends added entries in the order given and skips one already listed', () => {
    expect(recordOf({ add: { trunk_repos: ['a/three', 'a/one', 'a/four'] } }).trunk_repos).toEqual(['a/one', 'a/two', 'a/three', 'a/four'])
  })

  it('creates a list key that is absent', () => {
    expect(recordOf({ add: { map_order: ['a/b#1'] } }).map_order).toEqual(['a/b#1'])
  })

  it('compares object entries by value, whatever the order of their keys', () => {
    expect(recordOf({ remove: { overrides: [{ value: 1, key: 'max_slots' }] } }).overrides).toEqual([])
  })

  it('removes then adds when one list is named in both', () => {
    expect(recordOf({ remove: { trunk_repos: ['a/one'] }, add: { trunk_repos: ['a/one', 'a/new'] } }).trunk_repos).toEqual(['a/two', 'a/one', 'a/new'])
  })

  it('refuses a patch that is not an object, an unknown operation and an empty patch', () => {
    expect(problemsOf('x')).toEqual([expect.stringMatching(/must be an object/)])
    expect(problemsOf({ replace: {} })).toEqual([expect.stringMatching(/patch\.replace is not an operation/)])
    expect(problemsOf({})).toEqual(['the patch names no change'])
  })

  it('refuses a key named in two exclusive operations', () => {
    expect(problemsOf({ set: { max_slots: 1 }, unset: ['max_slots'] })).toEqual([expect.stringMatching(/max_slots is named in set and unset/)])
    expect(problemsOf({ set: { trunk_repos: [] }, add: { trunk_repos: ['a/x'] } })).toEqual([expect.stringMatching(/trunk_repos is named in set and add/)])
  })

  it('refuses to set version', () => {
    expect(problemsOf({ set: { version: 5 } })).toEqual([expect.stringMatching(/version is numbered by the server/)])
  })

  it('refuses unset of a key that is not there, and list edits of a missing or non-list key', () => {
    expect(problemsOf({ unset: ['nope'] })).toEqual([expect.stringMatching(/unset nope: the record has no such key/)])
    expect(problemsOf({ remove: { nope: ['x'] } })).toEqual([expect.stringMatching(/remove from nope: the record has no such key/)])
    expect(problemsOf({ remove: { max_slots: [1] } })).toEqual([expect.stringMatching(/remove from max_slots: it is not a list/)])
    expect(problemsOf({ add: { max_slots: [1] } })).toEqual([expect.stringMatching(/add to max_slots: it is not a list/)])
  })

  it('lists every problem at once', () => {
    expect(problemsOf({ unset: ['nope'], remove: { trunk_repos: ['a/zzz'] } })).toHaveLength(2)
  })

  it('refuses a patch whose result equals the record', () => {
    expect(problemsOf({ set: { max_slots: 2 } })).toEqual([expect.stringMatching(/changes nothing/)])
  })
})

describe('diffDirectives', () => {
  it('is empty for equal records, whatever the key order', () => {
    expect(diffDirectives({ a: 1, b: { x: 1, y: 2 } }, { b: { y: 2, x: 1 }, a: 1 })).toEqual([])
  })

  it('reports added, removed and changed keys, sorted', () => {
    expect(diffDirectives({ b: 1, c: 2 }, { a: 0, b: 5 })).toEqual([
      { key: 'a', change: 'added', after: 0 },
      { key: 'b', change: 'changed', before: 1, after: 5 },
      { key: 'c', change: 'removed', before: 2 },
    ])
  })

  it('shows the entries a list gained and lost', () => {
    expect(diffDirectives({ l: ['x', 'y'] }, { l: ['y', 'z'] })).toEqual([
      { key: 'l', change: 'changed', before: ['x', 'y'], after: ['y', 'z'], list_added: ['z'], list_removed: ['x'] },
    ])
  })

  it('marks a list that only changed order', () => {
    expect(diffDirectives({ l: ['x', 'y'] }, { l: ['y', 'x'] })).toEqual([{ key: 'l', change: 'changed', before: ['x', 'y'], after: ['y', 'x'], reordered: true }])
  })
})
