import { expect, test, vi } from 'vitest'

import { resolveTargets } from './check-targets.js'

const d1 = { WATCHTOWER_WORKER_URL: 'https://api.myargus.cc', WATCHTOWER_COLLECTOR_TOKEN: 'd1-token' }
const hub = { WATCHTOWER_HUB_URL: 'http://127.0.0.1:3790', WATCHTOWER_HUB_TOKEN: 'hub-token' }
const names = (env: Record<string, string | undefined>) => resolveTargets(env).map((target) => target.name)

test('D1 alone is the default, as before the hub existed', () => {
  expect(names(d1)).toEqual(['d1'])
})

test('a hub URL and token turn the hub on beside D1: the dual write', () => {
  expect(names({ ...d1, ...hub })).toEqual(['d1', 'hub'])
})

test('a hub URL without its token leaves the hub off, and says so', () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  expect(names({ ...d1, WATCHTOWER_HUB_URL: hub.WATCHTOWER_HUB_URL })).toEqual(['d1'])
  expect(warn).toHaveBeenCalledWith(expect.stringContaining('WATCHTOWER_HUB_TOKEN'))
  warn.mockRestore()
})

test('WATCHTOWER_HUB=off turns the hub off though it is configured', () => {
  expect(names({ ...d1, ...hub, WATCHTOWER_HUB: 'off' })).toEqual(['d1'])
})

test('WATCHTOWER_D1=off turns D1 off, and needs no Worker URL: the cutover', () => {
  expect(names({ ...hub, WATCHTOWER_D1: 'off' })).toEqual(['hub'])
})

test('WATCHTOWER_HUB=on without its URL or token is a startup error, not a silent skip', () => {
  expect(() => resolveTargets({ ...d1, WATCHTOWER_HUB: 'on' })).toThrow(/WATCHTOWER_HUB_URL/)
  expect(() => resolveTargets({ ...d1, WATCHTOWER_HUB: 'on', WATCHTOWER_HUB_URL: hub.WATCHTOWER_HUB_URL })).toThrow(/WATCHTOWER_HUB_TOKEN/)
})

test('D1 on without a Worker URL is a startup error, as it always was', () => {
  expect(() => resolveTargets({})).toThrow(/WATCHTOWER_WORKER_URL/)
})

test('every target off is a startup error: nothing would record', () => {
  expect(() => resolveTargets({ WATCHTOWER_D1: 'off' })).toThrow(/no target/i)
  expect(() => resolveTargets({ ...d1, WATCHTOWER_D1: 'off', WATCHTOWER_HUB: 'off' })).toThrow(/no target/i)
})

test('a flag that is neither on nor off is refused', () => {
  expect(() => resolveTargets({ ...d1, WATCHTOWER_D1: 'false' })).toThrow(/WATCHTOWER_D1.*on or off/)
  expect(() => resolveTargets({ ...d1, WATCHTOWER_HUB: 'yes' })).toThrow(/WATCHTOWER_HUB.*on or off/)
})
