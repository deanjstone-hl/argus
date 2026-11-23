import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import { directiveKeyPlaces, directivesProblems, KEY_PLACES, type DirectiveKey, type KeyPlace } from '../src/directives.js'

const MINIMAL = { cadence_minutes: 30, max_slots: 2, repo_holds: [], take_next: [], ordering: [] }
const UNTIL = '2026-11-06T00:00:00+11:00'

const SAMPLES: Record<DirectiveKey, Partial<Record<KeyPlace, unknown>>> = {
  cadence_minutes: { record: 30 },
  max_slots: { record: 2, override: 1 },
  repo_holds: { record: [{ repo: 'o/r', reason: 'x' }], override: ['o/r'] },
  take_next: { record: ['o/r#1'] },
  ordering: { record: ['bugs first'] },
  max_load: { record: 4, host_gate: 4, override: 4 },
  max_io_pressure: { record: 50, host_gate: 50, override: 50 },
  max_memory_pressure: { record: 50, host_gate: 50, override: 50 },
  max_disk_percent: { record: 90, host_gate: 90, override: 90 },
  quiet_window: { host_gate: '04:00-05:00' },
  reserve_percent: { record: 10 },
  awaiting_ci_cap: { record: 3 },
  host_caps: { record: { wsl2: 1 }, override: { wsl2: 1 } },
  host_gates: { record: { wsl2: { max_load: 4 } } },
  trunk_repos: { record: ['o/r'] },
  pr_flow_repos: { record: ['o/r'] },
  budget_exempt_repos: { record: ['o/r'] },
  budget_exempt_issues: { record: ['o/r#1'] },
  order_groups: { record: ['bug', 'rest'] },
  map_order: { record: ['o/r#1'] },
  overrides: { record: [] },
  pace_slot_bonus: { record: { below_pace: 0.8, total_cap: 3 } },
  ignore_weekly_budget: { override: true },
  lift_budget_rung: { override: { slots: 1, weekly_ceiling_percent: 90 } },
}

function placed(key: string, place: KeyPlace, value: unknown): Record<string, unknown> {
  switch (place) {
    case 'record':
      return { ...MINIMAL, [key]: value }
    case 'host_gate':
      return { ...MINIMAL, host_gates: { wsl2: { [key]: value } } }
    case 'override':
      return { ...MINIMAL, overrides: [{ key, value, until: UNTIL, reason: 'x' }] }
  }
}

const places = directiveKeyPlaces()
const cases = (Object.keys(places) as DirectiveKey[]).flatMap((key) => KEY_PLACES.map((place) => ({ key, place, allowed: places[key].includes(place) })))

describe('every directive key is accepted exactly where the registry places it', () => {
  it.each(cases.filter((c) => c.allowed))('accepts $key at $place', ({ key, place }) => {
    const sample = SAMPLES[key][place]
    expect(sample, `add a ${place} sample for ${key} to SAMPLES`).not.toBeUndefined()
    expect(directivesProblems(placed(key, place, sample))).toEqual([])
  })

  it.each(cases.filter((c) => !c.allowed))('refuses $key at $place', ({ key, place }) => {
    const sample = Object.values(SAMPLES[key])[0]
    expect(directivesProblems(placed(key, place, sample))).not.toEqual([])
  })

  it('has no sample for a place the registry does not give the key', () => {
    const stray = (Object.entries(SAMPLES) as [DirectiveKey, Partial<Record<KeyPlace, unknown>>][]).flatMap(([key, byPlace]) =>
      (Object.keys(byPlace) as KeyPlace[]).filter((place) => !places[key].includes(place)).map((place) => `${key}@${place}`),
    )
    expect(stray).toEqual([])
  })
})

describe('directive-keys.json', () => {
  it('matches the registry, so argus-config validates the same keys the server accepts', () => {
    const committed = JSON.parse(readFileSync(new URL('../directive-keys.json', import.meta.url), 'utf8')) as unknown
    expect(committed, 'directive-keys.json is stale: run `pnpm --filter @argus/loop-state-mcp directive-keys`').toEqual(places)
  })
})
