import { existsSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { resolveCcusageBin } from './ccusage.js'

describe('resolveCcusageBin', () => {
  it('resolves the installed ccusage entry point rather than shelling out to npx', () => {
    const bin = resolveCcusageBin()
    expect(bin).toMatch(/node_modules\/(\.pnpm\/.*\/node_modules\/)?ccusage\//)
    expect(existsSync(bin)).toBe(true)
  })
})
