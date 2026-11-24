---
name: verify-loop-state-slots
description: Check a change to loop-state's slot lifecycle or cap counting against the bounded model of the slots. Use before landing any edit to apps/loop-state-mcp/src/store.ts that touches standingOf, placedSlots, placedByHost, capRefusal, requireRoomForSlot, any slot* method, status_read's slot counts, or wakeCheck's free_slot and drain answers (slotRoom, holderLeftHomelabSlots), or when the slot model or wake model test fails.
---

# Verify loop-state slots

`apps/loop-state-mcp/test/slot-model.test.ts` plays the slot lifecycle against the real store, on a real SQLite db. The model keeps its own copy of each slot's state. From the README's slot diagram and cap rules it says what each operation must do: `start`, `prompt` (a tick reports that the worker waits on a tool-approval prompt), `park`, `unpark`, `await_ci`, `resume_ci`, `resume_report_only`, `close`, `free`. It uses eight issues: two capped per host, two in `budget_exempt_issues` ("listed"), two started with `budget_exempt` ("flagged"). The caps are total 2, wsl2 1, homelab 2, awaiting CI 3. The search visits every slot state within 4 operations of an empty db and tries every operation from each, refused ones included. Then one seeded walk of 20,000 operations reaches the deep states.

## Properties

1. **The store follows the slot diagram.** Each operation is accepted or refused exactly as the diagram and the caps say, and `slot_list` shows the state the diagram gives. Harm if broken: a slot is stuck (a finished worker cannot close), or a refused start blocks work the caps allow.
2. **Workers resident on a host never exceed a cap.** A worker is resident while its slot runs work, and while its slot is parked or ready after it was parked on an approval prompt: that worker resumes the moment the owner answers. Capped residents stay within the total cap and each host cap. At most one listed and one flagged resident. A green `report_only` resume is the one slot allowed past a cap (argus/37). Harm if broken: more workers than the host has memory for, and the kernel kills one (argus-config#1688, 25 Nov 2026).
3. **Every report agrees on what is exempt and what holds a place.** `slot_list`'s `budget_exempt`, `status_read`'s `budget_exempt_running`, `used`, `holding`, `parked`, `ready` and `awaiting_ci` match the diagram. Harm if broken: the tick launches a worker that `slot_start` then refuses (argus#77).

## Run

```bash
cd apps/loop-state-mcp && npx vitest run test/slot-model.test.ts
```

It takes about 35 s. `SLOT_MODEL_DEPTH=5 SLOT_MODEL_WALK_STEPS=200000` searches deeper; use that after a large change. CI runs the default bound through `scripts/ci.sh` whenever loop-state changes, and in the daily full run.

## Reading a failure

A failure prints the broken property and the operations that led to it from an empty db:

```
start wsl2-b is refused by the slot diagram and the caps, but the store accepted it
  start wsl2-a
  start wsl2-b
```

A walk failure prints its seed and only the last operations that changed a slot. Rerun the search at a higher `SLOT_MODEL_DEPTH` to get the shortest path.

- **A real bug.** The trace is something a tick or a worker can do. Fix `store.ts`. Never loosen the property.
- **A modelling error.** The store is right and the model's `expected()` or `hasRoom()` says otherwise. Fix the model so it matches the README, and say why in the commit.
- **An intended change.** For example, a new slot state or cap rule. Change `expected()` and `hasRoom()` in the same commit as the code and the README, and update this file.

## Proven able to fail

Each mutant below was applied to `src/store.ts`, and the model test failed on it:

| Mutant | Past fix it undoes | Caught by |
| --- | --- | --- |
| `standingOf` gives `budgetExempt: flagged` only | `1f8727b2` (argus#77) | the argus#77 replay, the search, the walk |
| `slot_close` refuses a `ready` slot | `ca60c4a4` (argus#1197) | the argus#1197 replay, the walk |
| `report_only` resume still checks the caps | argus/37 | the argus/37 replay, the walk |
| `standingOf` counts a listed issue as capped | argus#60 | the search, the walk |
| `slot_park` never sets `holds_place` (the behaviour before the fix) | argus-config#1688 | the argus-config#1688 replay, the search, the walk, and 5 tests in `approvals.test.ts` |
| the cap count reads running slots only | argus-config#1688 | the argus-config#1688 replay, the search, the walk |
| a held ready slot is cap-checked on restart | none: the hold must not strand its worker | the argus-config#1688 replay, the walk |
| host cap compares with `>` | none: an off-by-one | the argus#1197 replay, the search, the walk |
| awaiting cap compares with `>` | none: an off-by-one | the walk |

## Wake targeting

`apps/loop-state-mcp/test/wake-model.test.ts` checks which thread the `afk` wake goes to. It builds all 320 arrangements of: the holder (a WSL2 primary with a homelab standby, or a homelab primary), alive or silent for 70 minutes, a WSL2 slot running or not, the homelab slot (none, running, parked, parked on a prompt, ready), the `errors` of the holder's last tick (none, `drain-left:` naming the slot, `drain-left:` naming another issue, a line that only mentions homelab), and `takeable` 0 or 1. Each poller asks `wake_check` once on a fresh db. It takes about 2 s.

1. **The standby is woken only when it has work.** `failover` when the holder is silent, `drain` when the holder's last tick has a `drain-left:` entry naming a running homelab slot, else `primary_alive`. Harm if broken: an empty model turn on a 400k-token thread every cadence (argus#57), or homelab slots nobody settles.
2. **The holder is woken for a free slot exactly when it can start one.** Room under the total cap and on a host it may start on: any host for the WSL2 holder (argus#58), only homelab for a homelab holder (`f1bed5b9`). A slot parked on a prompt holds its place (argus-config#1357, #1688). Harm if broken: a free slot sits unfilled until the heartbeat, or the holder is woken every poll to start nothing.

```bash
cd apps/loop-state-mcp && npx vitest run test/wake-model.test.ts
```

A failure prints the broken rule and the arrangement. Read it as for the slot model: a real bug when the arrangement can happen, a modelling error when `standbyAnswer()` or `holderHasRoom()` disagrees with the README's wake table.

Each mutant below was applied to `src/store.ts` and failed this test:

| Mutant | Past fix it undoes | Caught by |
| --- | --- | --- |
| `drain` whenever a homelab slot runs | `48555d84` (argus#57) | the argus#57 replay, the sweep |
| any tick error mentioning homelab hands off | `87513abb` | the 87513abb replay, the sweep |
| room counted only on the waking host | `a05e2b18` (argus#58) | the argus#58 replay, the sweep |
| room on any host wakes any holder | `f1bed5b9` (argus-config#1366) | the f1bed5b9 replay, the sweep |
| the cap count reads running slots only | argus-config#1357, #1688 | the argus-config#1357 replay, the sweep |

Not covered by the wake check: sequences (the 30-minute spacing of `drain` wakes, the `free_slot` back-off, `heartbeat`, `unanswered`), pressure levels, `host_gates_ok`, `takeable_exempt`, a standby that holds the lease, and the direction role. `test/wake.test.ts` and `test/free-slot-backoff.test.ts` hold examples of those.

## Not covered

- Pressure levels (`no_new_slots`, `gate_only`), the budget ladder, `lift_budget_rung` and `pace_slot_bonus`: the model runs at normal pressure with fixed caps.
- `budget_exempt_repos`, `slot_rebuild`, `slot_report`, and the afk lease check on slot writes.
- Whether a tick reports the prompt at all. The hold starts from `pending_approvals`; a tick that parks a prompted worker without ever reporting or passing the count is outside the server's sight.
- Concurrent connections: each call is one transaction on one connection.
- A pass covers these eight issues, depth 4 and the walk. It does not prove every state.

## Coverage record

- Covered: `apps/loop-state-mcp/src/store.ts` `standingOf`, `standingOfRow`, `placedSlots`, `placedByHost`, `budgetExemptRunning`, `toShownSlot`, `capRefusal`, `requireRoomForSlot` (its cap half), `slotStart`, `slotPark`, `slotUnpark`, `slotAwaitCi`, `slotResumeCi`, `slotClose`, `slotFree`, `slotList`, the `slots` block of `statusRead`, and in `wakeCheck` the homelab standby branch, `holderLeftHomelabSlots`, `slotRoom` and the `free_slot` answer.
- Last confirmed against: the commit that added `holds_place` (`fix: keep a slot parked on an approval prompt under the caps`).

After changing covered code, run the test. Move the commit above forward only once you have confirmed that the test still describes the code at the new commit. Check with `git log -3 --format='%h %s' -- apps/loop-state-mcp/src/store.ts` whether a later commit touched the store.
