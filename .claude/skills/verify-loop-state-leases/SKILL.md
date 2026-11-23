---
name: verify-loop-state-leases
description: Check a change to loop-state's lease, liveness, wake or failover code against the bounded model of the direction lease. Use before landing any edit to apps/loop-state-mcp/src/store.ts that touches holderSeen, holderStalled, touchHolder, wakeCheck, leaseFailover or leaseReclaim, or when the lease model test fails.
---

# Verify loop-state leases

`apps/loop-state-mcp/test/lease-model.test.ts` plays the direction lease between a WSL2 primary and the homelab standby against the real store, on a real SQLite db. Each 10-minute step the primary does one of `tick`, `work` (an `owner_turn`), `busy` (only its poller runs) or `down` (nothing runs). Then its poller runs `wake_check` and reclaims on `reclaim`, and the standby's poller runs `wake_check` and calls `lease_failover` on `failover`. The search covers every sequence up to 4 steps from two starts: just after a model tick, and one step before the 4-hour heartbeat wake. Then it runs 120 seeded walks of 40 steps.

## Properties

1. **No failover of a live primary.** A failover happens only when the primary made no model tick and no owner work in the two cadences (60 min) before it. Harm if broken: the standby takes the lease from a thread the owner is talking to, and two threads act as Aquila.
2. **The lease always has a holder.** It is held by the primary or the standby, never by nobody.
3. **A dead primary loses the lease.** A primary down for two cadences plus the grace plus two polls (85 min) no longer holds it. Harm if broken: nothing ticks and the loop stalls with no failover.
4. **A returning primary reclaims.** A primary that is up and polling takes its lease back on its next poll.

## Run

```bash
cd apps/loop-state-mcp && npx vitest run test/lease-model.test.ts
```

It takes about 10 s. `LEASE_MODEL_DEPTH=6 LEASE_MODEL_WALKS=1000` searches deeper, about 2.5 min (measured 146 s). Use that after a large change. CI runs the default bound through `scripts/ci.sh` whenever loop-state changes, and in the daily full run.

## Reading a failure

A failure prints the broken property and the steps that led to it, in the code's words:

```
no failover while the primary ticked or worked within two cadences
  t+240m primary: work
  t+250m primary: busy
  t+250m standby fails over (primary's last tick or work 10m ago)
```

- **A real bug.** The trace is something the charter allows: an owner-busy primary, a host going offline, a thread coming back. Fix `store.ts`. Never loosen the property.
- **A modelling error.** The trace needs something real threads never do. One example: a primary that reclaims without polling first. Fix `step()` in the test so it matches how the threads behave, and say why in the commit.
- **An intended change.** For example, the owner changes the failover window. Change the matching constant (`FAILOVER_SILENCE_MS`, `DEAD_HOLDER_MS`) in the same commit as the code, and update this file.

## Proven able to fail

Each mutant below put back a past bug in `src/store.ts`, and the model test failed on it, both in its replay and in the bounded search:

| Mutant | Past fix | Caught by |
| --- | --- | --- |
| `holderStalled` also true on `wakeUnanswered`, and `leaseFailover` accepts `missed < 2 && unanswered` | `b2366f4` (argus#1041) | the argus#1041 replay, the argus#50 replay, the search |
| `touchHolder` writes nothing | `80120a3f` (argus#50) | the argus#50 replay, the search |
| `wakeCheck` never answers `reclaim` | none: liveness of property 4 | the down-and-back replay, the search |
| the standby branch never answers `failover` | none: liveness of property 3 | the down-and-back replay, the search |

## Not covered

- The AFK lease, slots, and the `free_slot` and `drain` wakes.
- A homelab primary (`700b5ed`), and `lease_move` or `lease_release` mid-run.
- Two stores, or concurrent connections: each call is one transaction on one connection.
- A pass covers these four primary behaviours, 10-minute steps, depth 4 and the walks. It does not prove every timing.

## Coverage record

- Covered: `apps/loop-state-mcp/src/store.ts` `touchHolder`, `holderActivityAt`, `holderSeen`, `holderMissed`, `holderStalled`, `wakeUnanswered`, `wakeCheck` (the homelab standby branch and the `reclaim` answer), `leaseFailover`, `leaseReclaim`, `statusTick` (its wake acknowledgement), `ownerTurn` (through `requireDirectionLease`).
- Last confirmed against: `dea7634d`.

After changing covered code, run the test. Move the commit above forward only once you have confirmed that the test still describes the code at the new commit. Check with `git log dea7634d.. -- apps/loop-state-mcp/src/store.ts` whether it has fallen behind.
