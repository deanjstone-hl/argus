import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

/**
 * A slot's standing against the caps (capped, exempt repo, flagged, listed) is decided by `standingOf` in
 * `src/store.ts` and nowhere else. argus#1033, #1171, argus#60 and argus#77 were each a reader with its own copy of
 * the rule. Each raw read below is allowed only on the line that feeds `standingOf` or shows the stored column.
 */
const RAW_READS: { read: RegExp; allowed: RegExp[] }[] = [
  { read: /budget_exempt\) === 1/, allowed: [/^\s*budget_exempt: Number\(row\.budget_exempt\) === 1,$/, /^\s*const standingOfRow = /] },
  { read: /listedExemptIssues\(\)/, allowed: [/^\s*issues: listedExemptIssues\(\),$/] },
  { read: /budgetExemptIssues\(/, allowed: [/^\s*return row === undefined \? \[\] : budgetExemptIssues\(/] },
]

describe('only standingOf decides how a slot counts toward the caps', () => {
  it('has no second copy of the exempt rule in store.ts', () => {
    const lines = readFileSync(new URL('../src/store.ts', import.meta.url), 'utf8').split('\n')
    const strays = lines.flatMap((line, index) =>
      RAW_READS.some(({ read, allowed }) => read.test(line) && !allowed.some((owner) => owner.test(line)))
        ? [`src/store.ts:${index + 1}: ${line.trim()}`]
        : [],
    )
    expect(
      strays,
      'These lines decide budget exemption themselves. Read the slot\'s Standing instead: standingOf(issue, flagged, exemptionsNow()) for a start, placedSlots(exemptionsNow()) for the slots holding a place, and use its capped, listed, flagged, exemptRepo or budgetExempt field.',
    ).toEqual([])
  })
})
