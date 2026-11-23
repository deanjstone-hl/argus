# @argus/loop-state-mcp

The loop-state MCP: one SQLite db behind typed tools, shared by the two orchestrator threads
(the AFK backlog loop and Aquila) and the AFK loop's worker threads. It holds **slots**,
**loop status**, each orchestrator role's **lease**, **Aquila's ledger** and the AFK **directives**, answers the
**quiet-tick gate**, and rebuilds slots from GitHub. Nothing reaches the db except through
these tools, and the tool layer enforces who may write what.

Spec: [argus-config#662](https://github.com/deanjstone/argus-config/issues/662); build map
[argus-config#663](https://github.com/deanjstone/argus-config/issues/663). This package is the
core ([argus-config#666](https://github.com/deanjstone/argus-config/issues/666)) plus leases and
Aquila's ledger ([#667](https://github.com/deanjstone/argus-config/issues/667)) and
rebuild-from-GitHub ([#668](https://github.com/deanjstone/argus-config/issues/668)); the
homelab packaging and registration are [#669](https://github.com/deanjstone/argus-config/issues/669).

## Roles

The caller's role comes from its bearer token, never from a tool argument.
`LOOP_STATE_TOKENS` maps tokens to roles (`afk=…,direction=…,worker=…`; a role may hold more
than one token, for rotation). Each workspace's MCP config carries its role's token: the AFK
workspace the `afk` token, `~/aquila` the `direction` token, every other session the `worker`
token. A caller sees only the tools its role may call, and the store refuses the rest too.

| Tool | afk | direction (Aquila) | worker |
|---|---|---|---|
| `slot_start`, `slot_park`, `slot_close`, `slot_free` | ✓ | | |
| `slot_unpark`, `slot_resume_ci` | | ✓ | |
| `slot_report`, `slot_await_ci` | | | ✓ (its own slot only) |
| `status_tick`, `tick_gate` | ✓ | ✓ | |
| `slot_list`, `status_read` | ✓ | ✓ | ✓ |
| `slot_rebuild` | ✓ | ✓ (applies only while no `afk` lease is held) | |
| `lease_read` | ✓ | ✓ | |
| `directives_read` | ✓ | ✓ | |
| `directives_set` | | ✓ | |
| `lease_move`, `lease_release` | | ✓ | |
| `owner_thread_set` | | ✓ (the `direction` lease holder, owner present) | |
| `child_start`, `child_close`, `owner_turn`, `away_note`, `notify_claim`, `outage_observe`, `ledger_read` | | ✓ | |

## Slots

A slot is one issue (`owner/repo#number`) with a worker thread on it.

```
slot_start ─▶ running ──slot_park──▶ parked ──slot_unpark──▶ ready ──slot_start──▶ running
                 │
                 ├─ slot_report (worker): attaches complete | needs_owner | failed; the state stays running
                 ├─ slot_await_ci (worker) ─▶ awaiting_ci ──slot_resume_ci (Aquila)──▶ running, or ready when the caps are full
                 ├─ slot_close (running or ready; needs a "Verified: …" line) ─▶ gone
                 └─ slot_free (any state) ─▶ gone
```

`slot_close` and `slot_free` delete the row, so they answer with its last values relabelled, not the stored
`state` (which would read `running` and look like a refused close; argus#1191): `slot_close` returns
`state: "closed"`, `previous_state`, the `verified` line and `closed_at`; `slot_free` returns `state: "freed"`,
`previous_state`, the `reason` and `freed_at`. A refusal is still an error result, never one of these. `slot_list`
no longer lists the slot.

`slot_close` accepts a `ready` slot as well as a `running` one (argus#1197): a worker whose `awaiting_ci` slot
went `ready` because the caps were full may report and finish there, and Aquila closes it without a
`slot_start` first. It still needs the `Verified:` line and the `afk` lease, answers with
`previous_state: "ready"`, and skips the cap check `slot_start` would make, since nothing runs. A `parked` or
`awaiting_ci` slot stays refused.

Running slots count against the cap; parked, ready and awaiting_ci ones do not. The worker only reports:
the AFK loop reads the report on its next tick, verifies it, and closes or parks the slot.

**Awaiting CI** (argus-config#1169). A worker whose PR is open and whose checks have started calls
`slot_await_ci` (`issue`, `thread_id`, `ref`: the PR URL, the SHA pushed to the issue's own trunk repo's `main`, or
`owner/repo@<40-hex sha>` for a push to another repo; one ref per slot, stored and shown as given in
`ci_ref`, and nothing in loop-state parses it)
and ends its turn instead of holding a slot while it waits. The slot counts toward no cap (`slots.used`,
the effective total cap and the host caps all leave it out), so the next issue can start. Aquila reads
the checks; when they finish, green or red, it calls `slot_resume_ci`: the slot goes back to `running`
if the effective total cap and its host's cap have room (pressure does not stop it, the worker is
already mid-task), else to `ready` with `resumed: false` and the reason, where it waits for a free slot
like an un-parked one. Aquila then wakes the worker in its own thread, behind the memory gate, and the
worker merges its own PR on green or fixes it on red. A green trunk slot has nothing left to build, only a
Resolution to post, so Aquila resumes it with `report_only: true` (argus/37): it skips the total, effective
and host caps and always goes to `running`, so finished work never waits behind a fresh worker. The flag is
refused unless `note` starts with `checks green`; a red resume stays capped. Nothing else moves an awaiting slot: `slot_report`,
`slot_park`, `slot_close` and `slot_start` refuse it, `slot_free` clears it, and a `slot_rebuild` keeps it
awaiting while its worker thread lives (and does not list it in `idle_workers`).

At most `awaiting_ci_cap` slots wait at once. It is an optional key of the directives record (a
non-negative integer; **default 3**, `0` turns the state off) and is read from the current record, so
nothing about a tick changes. `slot_await_ci` past the cap is refused and the worker keeps its running
slot, waiting as it did before. `status_read` `slots` returns `awaiting_ci` (the count) and
`awaiting_ci_cap`; `slot_list` takes `state: "awaiting_ci"` and shows the `ci_ref` on each slot.
`slot_awaiting_ci`, `slot_resumed` and `slot_resume_deferred` are loop events. `/wake/check` does not
read GitHub, so it does not wake Aquila when a waiting slot's checks finish: Aquila's own tick does.

## Rebuild from GitHub

`slot_rebuild` sets the slots against the public mirror. The caller passes what it sees: every
open issue assigned to the loop or labelled `needs:owner` (one `gh search`, with any claim
line's worker thread), and every thread from `t3_thread_list`. `watch.txt` is never an input.

| GitHub and T3 show | Slot |
|---|---|
| assigned + `needs:owner` | parked, on the claim line's (or linked, or held) thread |
| assigned, no label, the db slot was parked or ready | ready (the question was answered) |
| assigned, worker thread running or idle | running; an idle worker is listed in `idle_workers` to nudge |
| assigned, the db slot was awaiting_ci, worker thread running or idle | awaiting_ci, kept; not listed in `idle_workers` |
| assigned, worker settled, archived or missing | none: listed in `orphaned` |
| assigned, no claim line, linked thread or slot | none: listed in `unresolved`, never guessed |
| closed, or no longer assigned | none |

It returns the `add` / `update` / `remove` changes against the db and `agrees` (no changes).
It is **compare-only** unless `apply: true`: a compare writes nothing, not even an event, so
the cut gate checks the seed against GitHub before the lease moves. An applied rebuild writes
in one transaction and logs a `slot_rebuilt` event per change, which both gates see.

- **Seed at the cut:** Aquila runs it compare-only, then with `apply: true` while no AFK
  thread holds the `afk` lease, then compare-only again, which must agree.
- **Reconcile after an outage:** the AFK thread runs it once the db is reachable again.
  With an `afk` lease held, Aquila's call is compare-only: the running loop writes its own
  slots.

It is an MCP tool, not a CLI: the server on homelab can reach neither T3 (each T3 server binds
to loopback on its own machine) nor GitHub without a token of its own, while the calling thread
already has `gh` and `t3_thread_list`; and nothing reaches the db except through the tools.

## Directives

The AFK loop's standing orders (caps, holds, ordering, overrides) are a record here, set by
the owner, so they follow neither `main` nor `deploy` ([argus#1067](https://github.com/deanjstone/argus/issues/1067),
map [argus-config#1048](https://github.com/deanjstone/argus-config/issues/1048)). The record is
the directives file's front matter without `version`: the server numbers it. Every version is
kept; nothing edits or deletes one.

- `directives_read` returns the current version with the record, who set it, when and why. Pass
  `version` for an older one, `history` for the summary of every version, newest first.
  `directives` is null until one is set or imported.
- `directives_set` (Aquila) records a new version. The whole record is sent each time and is
  checked by the rules `tests/check_directives.py` applies to the file (`src/directives.ts`); an
  invalid one is refused with every problem listed. It is refused unless:
  1. the caller names its own thread as `caller_thread_id` (required, no grace period) and holds
     the direction lease, as `owner_turn` requires; a refusal is a `lease_conflict` event;
  2. the owner is present: an `owner_turn` within the last 30 minutes, not stepped away. Aquila
     calls `owner_turn` at the start of each owner turn, so a write rides on an owner turn;
  3. `expected_version` is the version the caller last read (0 when none), so two writers cannot
     overwrite each other.

  A write is a `directives_set` loop event, so the AFK gate sees a change.

  `host_gates.<host>` (`wsl2` or `homelab`) takes `max_load`, `max_io_pressure`,
  `max_memory_pressure`, `max_disk_percent` and `quiet_window` (argus#69, argus-config#1427).
  `quiet_window` is a string `HH:MM-HH:MM` in Sydney time: both times are valid 24-hour times,
  start and end differ, and a start after the end spans midnight (`22:00-02:00`). It is a
  `host_gates` key only: never a top-level key and never an `overrides` key. The server only
  stores it; `hooks/loop-wake.sh` and the tick read it, and `slot_start` ignores it, so the
  server gates slot starts exactly as before. A malformed window is refused, as
  `tests/check_directives.py` refuses it.

The owner-only guard is the direction token, the lease and owner presence. Presence is a
30-minute window, not a per-write approval: Aquila decides what the owner asked for inside it,
as it does for every other write it makes.

**One-off import.** `node dist/import-directives.js [--db <path>] <front-matter.json>...` seeds
the record from the directives file, keeping its version and labelling the row `import`. It is
not a tool: it opens the db file on the host, with no role check, so running it is the owner's
live step. It validates every file before writing, skips a version already imported with the same
record, and refuses one at or below the current version with a different record. Make the JSON
with `hooks/directives_effective.py`'s `read_front_matter` in argus-config
(`python3 -c 'import json,sys; sys.path.insert(0,"hooks"); from directives_effective import read_front_matter as r; print(json.dumps(r(open(sys.argv[1]).read()), default=lambda d: d.isoformat()))' envs/wsl2/afk/directives.md`).

## Loop status and the quiet-tick gate

`status_tick` is the last call of a full tick. It records the caller's thread id, the
directives version it read, the `needs:owner` set, the slot cap, errors, and the window
pressure. `status_read` returns a role's status (default `afk`) with slot counts and
liveness: `missed_ticks = floor((now − last seen − 5 min grace) / 30 min)`, so 0 is `alive`,
1 `late`, 2 or more `stalled`. *Last seen* is the later of the last tick and the lease holder's
last work (argus#50): an `owner_turn` or `directives_set` it made, a `child_start` / `child_close`,
or a slot write (`slot_start`, `slot_park`, `slot_close`, `slot_free`, `slot_rebuild` for `afk`;
`slot_unpark`, `slot_resume_ci` for `direction`). A primary deep in a long owner conversation
queues its tick prompts behind it and may tick nothing for over an hour, but it is not dead, so
its work counts and `/wake/check` answers no `failover` while that holds. Only the current holder
counts: a write refused for a lease conflict, a drain by a standby, or the previous holder's old
work never keeps the lease alive. `status_read` reports it as `last_activity_at` (`null` when
the holder has done none), and `liveness.next_due_at` counts from it.

**Pressure** is the window ladder: `normal` (<70%), `no_opus` (≥70%), `no_new_slots` (≥85%),
`gate_only` (≥95%), or `unknown`. Pass `window_used_percent` and the level is derived; pass
`pressure` alone when no percentage is available. A level that contradicts the percentage is
refused.

**Weekly budget ladder** ([argus#62](https://github.com/deanjstone/argus/issues/62), owner
22 Nov 2026: weekly pace again, replacing the burn ÷ allowance ladder of argus#871, which let one
busy day gate the rest of the week). Pass `weekly_used_percent` and `weekly_resets_at` (ISO UTC,
given together) and the server adds a second ladder, from how far the week's use runs ahead of
the time gone:

- `weekly_pace = used ÷ elapsed share of the week` (1.0 is even pace: 100% used exactly at the
  reset). It is null in the first hour of the week, and it sets no rung until a day of the week
  has gone: a few early points swing it far past every edge. Only the spent allowance gates
  before then.
- `allowance_per_day = (100 − used − reserve) ÷ days left`, `reserve` being `reserve_percent`
  from the directives (default 10). Once it is 0 (`100 − reserve` or more used) the rung is
  `gate_only` whatever the pace.
- `burn_per_day` (the rise over the trailing 24h, from `weekly_readings`; null until a reading
  is at least 24h old, [#1091](https://github.com/deanjstone/argus/issues/1091)) and
  `budget_ratio = burn ÷ allowance` are reported beside the rung as information. They no longer
  set it.

| Condition | Rung | Total cap |
|---|---|---|
| pace ≤ 1.1 | `normal` (the window ladder alone) | the directives cap |
| pace > 1.1 | `no_opus` (Sonnet or Haiku workers only) | the directives cap |
| pace > 1.25 | `no_new_slots` | 0: no starts |
| pace > 1.5, or the allowance spent | `gate_only` | 0: no starts |

A rung engages above its edge and releases only below the edge − 0.05, so a pace hovering at
an edge does not flip the level each tick (on 25 Oct it hovered at 1.09–1.12). `budget_rung_held`
is true while hysteresis is holding a rung the pace alone would not give. A new week starts with no rung held. The
effective `pressure.level` is the stricter of the budget rung and the window ladder, and a
change in it is a `pressure` change for the gate. A `normal` rung adds no limit, so an unread
window stays `unknown`. `tick_gate` and `POST /wake/check` carry the last weekly figure and
reserve forward when the caller leaves them out, recomputing the ladder against now; a figure
whose week has reset since stops counting. `status_tick` records what it is given and nothing
else.

**Ignoring the weekly ladder** ([argus-config#1573](https://github.com/deanjstone/argus-config/issues/1573)).
The directives' `overrides` accept `{key: ignore_weekly_budget, value: true, until, reason}`
(`true` only; `until` is exclusive, as for the other overrides). While one is live the server
skips the budget ladder whatever a tick sends: weekly figures are validated and the readings
still kept, but no rung is resolved, the effective level is the window ladder alone, and the
total cap is the directives cap. It also holds for a rung an earlier tick stored, so it takes effect at
once, with no new tick, and when the entry expires or a later version drops it the next tick
that sends the figures applies the ladder again. `budget_rung` reads null while it is live.

**Lifting the budget rung for a time-boxed sprint** ([argus#73](https://github.com/deanjstone/argus/issues/73)).
The directives' `overrides` accept `{key: lift_budget_rung, value: {slots, models, weekly_ceiling_percent}, until, reason}`:
`slots` is a positive integer at most `max_slots`, `weekly_ceiling_percent` is above 0 and at most 100, and `models`
is a non-empty list of `sonnet` and/or `haiku` (default both; Opus is never allowed). `until` is exclusive and the
entry is time-boxed like the others. While it is live, the week used is under the ceiling and the budget rung is
`no_opus` or `no_new_slots`: the effective total cap is `slots` (never above the directives total cap) in place of
the ladder's cut, `slot_start` is no longer refused for a `no_new_slots` rung, and the effective level reads
`no_opus` so Opus stays barred. A `slot_start` that passes `model` must name one of the override's models; leaving
`model` out is accepted, and a budget-exempt start is not held to it. Nothing else is lifted: a `gate_only` level
from either ladder, a window level of `no_new_slots` or the host caps still refuse as ever. The override ends at
`until` or at the first tick that records a week used at or past the ceiling, and a refusal then says so. It takes
effect and ends with no new tick otherwise, as `ignore_weekly_budget` does, and that one wins when both are live.
`status_read` `pressure` returns `budget_override_until`, `budget_override_slots`, `budget_override_models`,
`budget_override_ceiling_percent` (null with no live entry) and `budget_override_active` (true while it lifts the
rung now). argus-config's directives check and `directives_effective.py` must accept the key before a record
carrying it is written.

**The pace-gated third slot** ([argus#64](https://github.com/deanjstone/argus/issues/64), owner 22 Nov 2026: "Max slots to 3 when
pace is less than x1.00"). The directives accept `pace_slot_bonus: {below_pace, total_cap}`: `below_pace` is a positive
number, `total_cap` a positive integer at least `max_slots`, and no other field. While it is set, the server counts slots
against `total_cap` whenever the week's pace is strictly below `below_pace`, and against the total cap the tick sent (the
directives `max_slots`) otherwise. It only raises a cap: a tick that already sends the bonus cap keeps it. The pace is
used ÷ the elapsed share of the week, taken against now rather than from the last tick, so a start or a wake check sees
it fall as the week goes on. It uses the ladder's first-day rule: in the first day of a week no pace is read, so it counts
as below, as the first hour does; so does a week with no weekly figure (none sent, or `ignore_weekly_budget` is live) and
a week that has reset since the last tick. The bonus is the first step, and the rest still applies on top: the budget rung
cuts the cap to 0 from `no_new_slots` up (or to a live `lift_budget_rung` override's `slots`, bounded by the bonus cap),
and `host_caps` still bound each host. A live `max_slots` override suspends the bonus, since the owner set that cap by
hand. `slot_start`, `slot_resume_ci` and `POST /wake/check`'s `free_slot` room use the same cap. `status_read` `pressure`
returns `pace_slot_bonus` (the setting, or null), `pace_slot_bonus_active` (true while it raises the cap above the tick's),
`pace_slot_bonus_suspended` and `slot_cap_reason`, a sentence naming the cap that applied and why. argus-config's
directives check and `directives_effective.py` must accept the key before a record carrying it is written.

**Slot caps.** A tick passes the directives' `total_cap` and `host_caps` (`{"wsl2": 2,
"homelab": 1}`; a host left out has no cap of its own). `slot_cap` still works as the total cap
for a caller that has not moved to `total_cap`; if both are given `total_cap` wins. A tick that
passes no `host_caps` records none, so a caller that does not send them is held to the total
alone, as before. `slot_start` is refused when the AFK loop's last recorded tick left the
effective level at `no_new_slots` or `gate_only`, when the running slots already fill the
effective total cap (the directives total; 0 from `no_new_slots` up), or when
the starting `host` already runs its own cap. Before any tick is recorded there is nothing to
enforce. Running workers carry on. `POST /wake/check` wakes for a free slot only while some
host still has room.

**Budget-exempt repos** (argus#1012). A tick may pass `budget_exempt_repos`, a list of
`owner/repo` (the directives' trunk-trial repos). A running slot in a listed repo sits outside
the slot caps (argus#1033): no `slot_start` counts it toward the total cap, the effective cap or a
host cap, so non-exempt starts count only non-exempt running slots. A `slot_start` in a listed
repo skips those caps; it is refused if the
repo already runs a slot (one running slot per exempt repo), and it still checks `no_new_slots`
and `gate_only`. `tick_gate` carries the last list forward when a call omits it; a `status_tick`
that omits it records none. `POST /wake/check` reads the stored list, counts only non-exempt
running slots, and, while any repo is listed, counts room for a free slot against the directives
total, because the poll does not know which repo the takeable work is in. `status_read` still
counts every running slot in `slots.used`. `status_read`
`pressure.budget_exempt_repos` returns the list; `effective_slot_cap` is unchanged. Schema
version 9 adds the `budget_exempt_repos` column to `loop_status`.

**Budget-exempt issues** ([argus#60](https://github.com/deanjstone/argus/issues/60)). The directives'
`budget_exempt_issues` is an optional list of `owner/repo#N`, each an issue the owner named.
`slot_start` reads it from the current directives, so the caller passes no flag. A listed issue
passes `no_new_slots` and `gate_only`, skips every cap, and while it
runs it is not counted toward the total, effective or host caps. One listed issue runs at a
time: a second listed start is refused until the first closes. It does not use the
`efficiency:orchestrator` slot above, so each keeps its own one at a time. Nothing else is
waived: the memory, load and disk gates are the tick's, not the server's, and still apply. An
issue not listed is refused at those levels as ever, and a later directives version that drops
it ends the exemption. `status_read` `pressure.budget_exempt_issues` returns the list.

**Budget-exempt slots** (argus#1171). An issue labelled `efficiency:orchestrator` (it cuts the
orchestrator's token or tick cost) starts with `slot_start` `budget_exempt: true`; the caller
passes it, the server does not read labels. Such a start is allowed at `no_new_slots` and still
refused at `gate_only`; it skips every cap, and while it runs it is
not counted toward the total, effective or host caps (the same as a slot in an exempt repo). One
budget-exempt slot runs at a time: a second start is refused until the first closes. The slot row
records `budget_exempt`; `slot_list` (and every slot a write returns) shows it, and `status_read`
`slots.budget_exempt_running` counts the running ones. Use Sonnet or Haiku for it: the server does
not check the model, the charter does. `POST /wake/check` takes an optional `takeable_exempt`
(how many takeable issues carry the label) and, at `no_new_slots` with `takeable_exempt > 0` and no
exempt slot running, answers `free_slot`. The caller passes it rather than the server guessing,
because `takeable` does not say which issues carry the label and a guess would wake every tick at
`no_new_slots`. A new schema version adds `slots.budget_exempt INTEGER NOT NULL DEFAULT 0`.

`status_read` `pressure` returns `weekly_used_percent`, `weekly_resets_at`, `burn_per_day`,
`allowance_per_day`, `budget_ratio`, `budget_rung`, `budget_rung_held`, `reserve_percent` and
`effective_slot_cap`, with `weekly_pace`, which sets the rung; `slots.hosts` returns `used` and
`cap` per host.

Schema version 7 added `window_level`, `weekly_used_percent`, `weekly_resets_at` and
`weekly_pace` to `loop_status`. Schema version 8 adds the `weekly_readings` table and
`host_caps`, `reserve_percent`, `budget_rung`, `budget_held`, `burn_per_day`,
`allowance_per_day` and `budget_ratio` to `loop_status`; each applies once, in place, and
existing rows keep their level as the window side. Rolling back the code leaves the added
columns and table unused, which an older build ignores.

`tick_gate` is the first call of every tick. It takes the same input as `status_tick` and
compares it with the caller's last recorded tick:

- the directives version,
- the `needs:owner` set (order-insensitive),
- the effective pressure level (window and budget ladders), when given or carried forward,
- every slot event by anyone since that tick (worker reports and un-parks included).

If nothing changed it records the tick itself, carrying forward the fields left out, so a
quiet tick is one shell call (pull the directives, `gh search` the queue), `tick_gate`, and
the Monitor re-arm. If something changed it returns the reasons and the events and records
nothing; the full checklist then ends with `status_tick`, which moves the cursor past them.

## Leases

Each orchestrator role (`afk`, `direction`) has at most one lease, naming the thread that is
that role right now. `status_tick` and `tick_gate` count only from the holder: any other
thread's tick records nothing and returns `holds_lease: false` with the holder's id, and
leaves a `lease_conflict` event that only Aquila's gate sees. With no lease held, no tick
counts.

**Slot writes need the `afk` lease too** (argus#882). `slot_start`, `slot_park`, `slot_close`,
`slot_free` and `slot_rebuild` with `apply: true` take the caller's own thread as
`caller_thread_id` (`slot_start` already has `thread_id` for the worker). Both hosts' `afk` MCP
servers carry the same role token, so the token cannot say which orchestrator is calling. A
caller that does not hold the `afk` lease is refused with the holder named, and leaves a
`lease_conflict` event for Aquila's gate. The exception is the standby drain: a non-holder
that is not the lease's primary may `slot_close`, `slot_park` and `slot_free` a slot whose host
equals the `host` it passes, never `slot_start`. A compare-only `slot_rebuild` needs no lease.

Rollout: a call with no `caller_thread_id` is accepted for one release, with a
`slot_write_unchecked` event for Aquila's gate and a `warning` in the result, so an
orchestrator whose charter does not pass the id yet keeps working. Set
`LOOP_STATE_REQUIRE_CALLER_THREAD=1` in `~/.config/argus/loop-state-mcp.env` to refuse such calls once the charter passes it.

**`owner_turn` needs the `direction` lease** (argus#1042). It takes the caller's own thread as
`caller_thread_id`; a caller that does not hold the `direction` lease is refused with the
holder named, records no presence and hands over no "since you left" lines, and leaves a
`lease_conflict` event. This stops a stray thread launched in the orchestrator's workspace
(it inherits the `direction` token) from recording an owner turn (argus-config#1031). A call
with no `caller_thread_id` is accepted for one release, with an `owner_turn_unchecked` event and
a `warning` in the result; `LOOP_STATE_REQUIRE_CALLER_THREAD=1` refuses it, for slot writes and
`owner_turn` together, so turn it on only after both charters pass the id.

**The owner chat of a split tick** (argus#54, [argus-config/1426](https://github.com/deanjstone-hl/argus-config/issues/1426)).
When a tick thread holds the `direction` lease, the owner's own chat is not the holder, so `owner_turn` would
refuse it. `owner_thread_set { host, thread_id, caller_thread_id }` registers that chat as the host's
`owner_thread_id` (`wsl2` or `homelab`, one thread each; a new call replaces the host's). Only the `direction`
holder may call it, and only while the owner is present (`owner_turn` within 30 minutes, not stepped away); a
non-holder, including the registered owner thread itself, is refused with the holder named, and the call must name
`caller_thread_id`.

- `owner_turn` accepts the holder or either host's registered owner thread. A turn from the owner thread sets
  presence and hands over the "since you left" lines; it is not activity of the holder, so a stalled tick thread
  still reads stalled.
- Every other write from the owner thread is refused, naming the holder, with a `lease_conflict` event
  (`detail.reason: owner_thread_write`) for the holder's next gate: `tick_gate`, `status_tick`, `slot_*`,
  `lease_*`, `directives_set`, `child_*`, `away_note`, `notify_claim` and `outage_observe`. The server tells the
  owner thread by the `X-T3-Thread-Id` header and by any `thread_id` or `caller_thread_id` the call names, so a
  session with no header is caught only by a name. Reads stay open.
- The registration lives in its own table (a new schema version adds the `owner_threads` table), not on the lease row, so
  `lease_move`, `lease_release`, `lease_failover` and `lease_reclaim` leave it alone. `lease_read` shows it as
  `owner_threads: { wsl2, homelab }` once one is set; until then the key is absent and nothing else changes: with
  no registration every call behaves as before.
- Live steps for the owner: none for the server beyond promotion (the migration runs when the service starts).
  Registering the chat is a call made at cutover ([argus-config/1539](https://github.com/deanjstone-hl/argus-config/issues/1539)).

**The session's own thread id** (argus#51). `caller_thread_id` and a tick's `thread_id` are
arguments the model types, and a T3 fork inherits its parent's thread id, so a fork could call
`owner_turn`, `tick_gate` or a slot write as the lease holder. The server therefore also reads
the `X-T3-Thread-Id` request header. The harness sends it, not the model: T3 sets `T3CODE_THREAD_ID`
in every Claude process's environment, and the loop-state `headersHelper`
(`hooks/loop-state-mcp-headers.mjs` in argus-config) prints it as a header. A fork is a new T3 thread
with its own value.

- A call that names a thread other than the header's is refused, naming both, and leaves a
  `lease_conflict` event (`detail.reason: thread_header_mismatch`) for the holder's next gate. It covers
  `caller_thread_id` on `slot_start`, `slot_park`, `slot_close`, `slot_free`, `slot_rebuild`,
  `owner_turn` and `directives_set`, and `thread_id` on `status_tick`, `tick_gate`, `slot_report` and
  `slot_await_ci`.
- With the header and no `caller_thread_id`, the header is the caller, so leaving the argument out does
  not skip the lease check.
- With no header, the call is accepted as before and the first one per role and thread is logged
  (`X-T3-Thread-Id`, in the service journal), so the rollout shows who still sends none.
  `LOOP_STATE_REQUIRE_THREAD_HEADER=1` refuses those calls; turn it on only once the helper is promoted
  everywhere and the journal shows no legitimate caller without it.
- Not covered: the tools that carry no caller id at all (`lease_move`, `lease_release`,
  `lease_failover`, `lease_reclaim`, `child_*`, `away_note`, `notify_claim`, `outage_observe`). They
  name other threads, not the caller, so there is nothing to check the header against yet. The one thing the header does check on
  them is a registered owner thread (see "The owner chat of a split tick" above, argus#54): that session is refused on all of them.

Only Aquila writes leases. An unheld lease is taken with `lease_move`. A held one moves in the
retire-first order (rotation, #655): delete the old thread's `schedule_task`, then
`lease_move` naming the old holder as `from_thread_id` with `old_schedule_task_deleted: true`,
then settle the old thread, then the successor boots. `lease_release` is the rollback: same
two arguments, and afterwards nobody's tick counts until the next move.

**One thread, both roles** (the merged orchestrator, argus-config#796-#798). Nothing ties a
lease to a distinct thread, so one thread may hold both: leases, liveness, failover, reclaim
and `/wake/check` are all per role, and the thread is the same id in each. Pinned in
`test/leases.test.ts`. What that means in practice:

- The thread ticks twice, once per role, with the role's own token (`afk` and `direction`
  are separate tokens). A tick for one role never counts for the other, so a thread that ticks
  only one role leaves the other `late` and then `stalled`.
- A wake is per role and is answered by that role's own `tick_gate` or `status_tick`. Answering
  `afk` leaves a pending `direction` wake, which reads `late` once it is 10 min old and
  `stalled` only at 2 missed ticks.
- A standby fails over and reclaims one role at a time (`lease_failover`, `lease_reclaim`, with
  the `afk` token for `afk` and the `direction` token for either). Between the two calls the
  standby holds one role and the primary the other.
- `lease_move` takes an optional `host` (`wsl2` | `homelab`), the host of the thread taking the lease,
  and records it as the lease's `primary_host` (null when omitted); `lease_read` shows it
  ([#1046](https://github.com/deanjstone/argus/issues/1046)). `lease_reclaim` takes the same optional
  `host`: a thread other than the recorded primary succeeds when its `host` equals `primary_host`, and
  becomes the lease's primary, so a new WSL2 thread (its id changes often) hands the lease back without
  another `lease_move`. The exact-id path is unchanged, and a new thread passing the other host, or no
  host, is refused. Failover keeps `primary_host`. Schema version 10 adds the column; existing leases
  read null.
- `lease_move` always makes `to_thread_id` the lease's primary (`store.ts` `leaseMove`), the
  last thread given the lease by a move. Rotating the merged thread therefore makes the
  successor primary of both roles, but only once both moves are done. A `lease_move` made
  while a standby holds the lease (instead of `lease_reclaim`) also rewrites the primary, after
  which the old primary can no longer reclaim. Failover and reclaim never rewrite it.

## Server-decided ticks: `POST /wake/check`

The loop-wake client (argus-config#778) asks this route whether a tick needs a model turn,
instead of every tick being one ([#831](https://github.com/deanjstone/argus/issues/831)). It
authenticates with the role tokens above: the token's role must be the body's `role`, and a
`worker` token is refused (403). The body is validated strictly; an unknown or mistyped field
is a 400.

```json
{ "role": "afk", "host": "wsl2", "thread_id": "…", "directives_version": "…",
  "needs_owner": ["owner/repo#1"], "window_used_percent": 42, "takeable": 3 }
```

`window_used_percent`, and `weekly_used_percent` with `weekly_resets_at`, are optional; `takeable` is required for `afk`; `takeable_exempt` is optional (argus#1171), and so is `host_gates_ok` (argus#1167, below). The answer is
`{ "wake": bool, "reason": "…", "recorded": bool }`, and the route writes no event, so polling
never wakes either gate.

| Caller | Situation | `wake` | `reason` |
|---|---|---|---|
| `wsl2` holder | the `tick_gate` comparison is unchanged, no outage edge, and (afk) no free slot with `takeable > 0` | false, quiet tick recorded by the client (`recorded: true`) | `quiet` |
| `wsl2` holder | the comparison changed in a reason that can be acted on (see *Wake only when it can act*) | true | `changed:<reasons>` |
| `wsl2` holder (direction) | the AFK loop is stalled with no open outage, or recovered with one open | true | `outage_opened` / `outage_closed` |
| `wsl2` holder (afk) | a running slot has `pending_approvals > 0`, at any pressure | true | `pending_approvals` |
| `wsl2` holder (afk) | a free slot on any host it may start on (total cap has room, and the `host_caps` entry of `wsl2` or of `homelab` does: the holder also fills homelab slots through the linked environment, [#58](https://github.com/deanjstone/argus/issues/58)), `takeable > 0`, pressure below `no_new_slots`, `host_gates_ok` not `false`, and not already answered with this same slot set and counts | true | `free_slot` |
| `wsl2` holder (afk) | pressure `no_new_slots`, `takeable_exempt > 0`, no budget-exempt slot running, `host_gates_ok` not `false` | true | `free_slot` |
| `wsl2` holder | no tick recorded by the model for 4 h | true | `heartbeat` |
| `wsl2` holder | an earlier wake is still unanswered | true | `unanswered` |
| `wsl2` holder | the role never ticked | true | `first_tick` |
| `wsl2`, the lease's primary | the standby holds the lease | true | `reclaim` |
| `wsl2`, neither | | false | `not_holder` |
| `homelab`, the lease's primary | it holds the lease | as the `wsl2` holder rows (`changed:*`, `free_slot`, `pending_approvals`, `heartbeat`, `unanswered`, `outage_*`) | — |
| `homelab` standby | the holder is alive or late, no running `host: homelab` slot | false, nothing recorded | `primary_alive` |
| `homelab` standby | the holder is stalled | true | `failover` |
| `homelab` standby | it holds the lease | true at most once per cadence | `standby_cadence` / `standby_waiting` |
| `homelab` standby (afk) | the primary holds the lease, a `running` `host: homelab` slot is open (parked and ready slots do not count), and the holder's last tick has an `errors` entry starting `drain-left:` (any case) that names that slot's issue, e.g. `drain-left: deanjstone/argus#9 homelab not reachable` (it could not drain the slot itself; no other error text counts) | true at most once per cadence | `drain` |
| `homelab` standby (afk) | the holder is alive and its last tick has no `drain-left:` entry: it drains homelab slots itself, so a wake would be an empty turn ([#57](https://github.com/deanjstone/argus/issues/57)) | false | `primary_alive` |
| anyone | nobody holds the lease | false | `no_lease` |

## Wake requests: `POST /wake/request`

The ops hub can wake Aquila now instead of waiting for the next tick
([#1189](https://github.com/deanjstone/argus/issues/1189)): an Update button on a diagram asks for a wake for
one named issue.

```json
{ "issue": "deanjstone/argus#1189" }
```

- **Auth:** the hub's bearer, `LOOP_STATE_PROMOTION_TOKEN`, the same secret and the same `@argus/bearer-auth` check as
  `POST /events/promoted`: no new secret, and ops-hub still holds no role. A role token is refused (401), and with the
  variable unset the route is off and refuses every caller. The hub can ask for a wake and report a promotion, nothing
  else: it reads and writes no slot, lease or directive.
- **Body:** strict. Anything but `issue`, or an `issue` that is not `owner/repo#number`, is a 400.
- **The wake reason:** the request is a `wake_requested` event on the direction gate. `POST /wake/check` answers the
  direction lease holder `{ "wake": true, "reason": "wake_requested:<issue>[,<issue>…]" }` on every poll until a
  `tick_gate` or `status_tick` passes the event (it then reads as any wake: answered within 10 min). `tick_gate` lists
  it in `changes` as `{ kind: "wake_requested", issue, at }` and in `reasons`. The afk loop never sees it, and a thread
  that does not hold the direction lease stays `not_holder`. The reason is checked ahead of the other direction reasons,
  so it is named alone.
- **Rate limit,** kept in the events table so a restart does not reset it:
  - an issue whose request is still pending (Aquila has not ticked since) answers `200 { "recorded": false, "reason": "pending", "budget_rung": …, "budget_rung_held": … }`
    and records nothing, so a double press is one wake;
  - the same issue again within 2 min of a recorded request (`WAKE_REQUEST_COOLDOWN_MS`), or any issues together beyond 6 per
    hour (`WAKE_REQUEST_HOURLY_CAP`), answers `429 { "error": "rate_limited", "retry_after_seconds": n, "budget_rung": …, "budget_rung_held": … }` with a `Retry-After`
    header, and records nothing.
  - A recorded request answers `200 { "recorded": true, "budget_rung": …, "budget_rung_held": … }`.
- **The budget rung** ([#47](https://github.com/deanjstone/argus/issues/47)): every 200 and 429 body also carries
  `budget_rung` (`normal`, `no_opus`, `no_new_slots` or `gate_only`) and `budget_rung_held` (hysteresis keeps the rung above
  what the ratio alone gives), read from the AFK loop's last recorded tick: the row the slot gate enforces. The hub's bearer
  reads nothing else from loop-state, so this is how its Update dialog says the filed issue will wait: a rung above `normal`
  lowers the effective total cap to 1, and `no_new_slots` and `gate_only` start no ordinary slot. `budget_rung` is `null` (with
  `budget_rung_held: false`) until a tick has recorded a weekly figure: the ladder is unseen, which is not `normal`. A 429
  carries them beside `retry_after_seconds`. Reading them writes nothing, and needs no new secret or route.
- **A wake never bypasses a gate.** It only makes the next poll answer `wake: true`. The model tick it starts still runs
  every gate: the slot cap, the budget rungs, the host load gates. This route starts no slot and moves no lease.

**Latency: a poll path, not a direct send.** loop-state cannot reach into a T3 thread, so the wake is answered on the
loop-wake client's next poll ([argus-config runbook](https://github.com/deanjstone/argus-config/blob/main/docs/runbooks/loop-wake.md)).
That timer is `*:05/30` (every 30 min) on WSL2 and `*:00/10` (every 10 min) on homelab, so the wait is at most one
interval after the request: 30 min worst case on WSL2, 10 min on homelab, plus the route's own few milliseconds. A
"within minutes" Update button needs the faster poll on the holder's host, or a direct send from the hub to the thread.

## Promotion events: `POST /events/promoted`

Aquila learns that the owner promoted a repo without polling
([#1118](https://github.com/deanjstone/argus/issues/1118)). ops-hub reports each move of a
repo's `deploy` branch here, and the server records a `promoted` event.

```json
{ "repo": "deanjstone/argus", "from_sha": "<40 hex, or null>", "to_sha": "<40 hex>",
  "at": "2026-11-10T08:00:00.000Z", "source": "approve" }
```

- **Auth:** its own bearer, `LOOP_STATE_PROMOTION_TOKEN` (checked with `@argus/bearer-auth`), not a role
  token: ops-hub holds no role and can write nothing else. A role token is refused (401). With the
  variable unset the route is off and refuses every caller (401).
- **Body:** strict. An unknown field, a SHA that is not 40 hex, a `repo` that is not `owner/repo`, a `source`
  other than `approve` (ops-hub's Approve path) or `webhook` (a `push` to `deploy`, which also catches
  `promote.sh` and rollback-card pushes), or an `at` that is not an ISO time is a 400.
- **Idempotent on `repo` + `to_sha`:** the first report answers `{ "recorded": true }` and writes the event;
  a repeat answers `{ "recorded": false }` and writes nothing. The Approve path and the webhook both
  report the same push, so the second is the repeat.
- **Direction only, and no wake:** the event is Aquila's, and it wakes nothing
  ([argus-config#1351](https://github.com/deanjstone/argus-config/issues/1351)). `tick_gate` lists it in `changes` as
  `{ kind: "promoted", repo, from_sha, to_sha, source, at, … }` and in `reasons`, so a model tick that runs for another
  reason still sees it. `POST /wake/check` treats `promoted` as noise: alone it is a quiet check, and the client's quiet
  tick moves the event cursor past it. The wake belongs to argus-config's `hooks/tick-prep.py`, which fires
  `promoted_followup` only when the flagged issue (or one its note names) is open with `needs:owner`. The AFK loop never
  sees the event.

### Wake only when it can act (argus#1167)

Four rules keep the check from waking a model that has nothing to do. Each applies to the
check only: `tick_gate` still reports everything it always did.

- **`host_gates_ok`** (optional boolean, `afk` check). The client reads the host's own gates
  (load, memory pressure, disk, the quiet window) without a model; `false` means a slot could
  not start now, so neither `free_slot` row wakes. Left out reads as `true`, so an older
  client behaves as before. Accepted and ignored on a `direction` check. A non-boolean is a 400.
- **Noise is never the only reason.** `owner_turn`, `away_noted`, `notified`, `promoted`, `child_started`
  and `child_closed` are Aquila's own ledger writes. They are left out of `changed:<reasons>`;
  when nothing else changed the check is quiet and the client's quiet tick moves the event
  cursor past them. A real reason next to them still wakes and names only itself. Outage edges,
  directives, `needs_owner`, slot events and the warning events (`*_unchecked`,
  `lease_conflict`) are not noise.
- **Pressure dwell.** A pressure level that differs from the last recorded tick is a
  `pressure` reason only once the check has seen the same new level for 20 min
  (`DEFAULT_PRESSURE_DWELL_MS`, option `pressureDwellMs`; 0 wakes at the first poll). Until
  then the quiet tick keeps the held level, so a flip that is gone by the next poll never
  wakes, and a free slot counts only the stricter of the held and current level. A flip
  next to another real reason wakes at once under that reason. A first reading after an
  `unknown` level has nothing to flip back to and wakes at once. The dwell is in memory: a
  restart of the service only restarts it.
- **`free_slot` backs off once answered** (argus-config#1357). Only running slots count against the
  caps, so a parked slot whose worker is still live (an approval prompt the owner has not answered)
  leaves its host looking free, and the orchestrator rightly holds it. After a `free_slot` wake the
  model answered (a `tick_gate` or `status_tick` since it) the same answer stays quiet while the slot
  set (issue, state, host), `takeable`, `takeable_exempt` and the pressure level are unchanged. Any
  change, or a poll where no slot is wanted (gates closed, cap reached), ends the back-off, so the
  next free slot wakes once. A wake the model has not answered still wakes again. The back-off is in
  memory: a restart of the service costs one more wake.

- **`free_slot` needs room on a host the caller may start on** (argus-config#1366, [#58](https://github.com/deanjstone/argus/issues/58)).
  A `homelab` thread starts slots only on its own host, so for it a slot counts as free for the wake only when the total
  cap and the `host_caps` entry for the `host` the poll names both have room: room on the other host (homelab 1/1,
  wsl2 0/2, total 1/2) wakes neither the homelab holder nor anything else. The `wsl2` `afk` holder also fills free
  homelab slots through the linked environment (charter, "Starting slots" under Cross-env control), so for it the
  slot is free when the total cap has room and either host's entry does: with wsl2 2/2 and homelab 0/1 it wakes for
  the homelab slot, counted against homelab's entry, not wsl2's. The homelab standby that does not hold `afk` is
  never woken for `free_slot` while the primary is alive. A host with no `host_caps` entry is bounded by the total
  cap alone.

The 4 h heartbeat is unchanged and remains the backstop for all five.

**Wake acknowledgement.** Every `wake: true` must be answered by a `tick_gate` or
`status_tick` call from that thread (lease or not), or a `lease_failover` / `lease_reclaim`
to it, within 10 min. Otherwise liveness reports `late` (an unanswered wake alone never
makes it `stalled`, and so never triggers a `failover` wake or a `lease_failover`), and the
primary's next check re-wakes with `unanswered` instead of recording a quiet tick. With no
quiet tick recorded and no work by the holder (see *Loop status*), the missed ticks pile up and
the thread is `stalled` at 2 (about an hour). Quiet ticks recorded by the client keep liveness alive between wakes, and the 4 h
heartbeat bounds how long a dead thread can go unnoticed.

`status_read` adds `last_tick_recorded_by` (`model` or `client`), `last_model_tick_at`,
`ticks` (model and client-recorded counts for the last 7 days and all time, counted from
schema version 5), and `wake` (the holder's last wake, its reason and any unanswered
`pending_since` / `ack_due_at`). `tick_gate` and `status_tick` return what they always did.

## Pending approvals

A worker blocked on a tool-approval prompt looks idle: its thread reads `completed` and
`t3_pending_request_list` omits approvals ([argus-config#787](https://github.com/deanjstone/argus-config/issues/787)).
The AFK tick reads each running worker's `pendingRequestCount` from `t3_thread_read` and passes
it to `status_tick` as `pending_approvals`, an optional map keyed by issue
([#836](https://github.com/deanjstone/argus/issues/836)):

```json
{ "thread_id": "…", "directives_version": "…", "needs_owner": [], "pending_approvals": { "owner/repo#5": 1, "owner/repo#6": 0 } }
```

- **Omitted** leaves every count as it was, so a caller that never sends it sees no change. Within
  the map, an issue left out keeps its count and `0` clears it. An issue with no running slot is
  skipped (the slot was freed or parked since the worker was read). A negative or fractional count,
  or a key that is not an issue, refuses the whole tick.
- **Read back** as `pending_approvals` on every slot (`slot_list`, `slot_start` and the rest; `0`
  by default) and as `status_read` `slots.pending_approvals`, a map of the running slots above 0.
- **Cleared** by `slot_park`, `slot_close`, `slot_free`, a restart of a ready slot and a rebuild
  that moves a slot out of `running`. Only a running slot counts.
- **Wakes the AFK thread**, not Aquila: `POST /wake/check` answers `wake: true`,
  `reason: "pending_approvals"` for the `afk` holder while any running slot is above 0, at any
  window pressure (parking costs no slot). The AFK tick parks the slot with `needs:owner` and
  messages Aquila, which is what clears the reason; a tick that reports the count and leaves the
  slot running keeps it waking, and the unanswered-wake rule applies as for any wake.
- Only `status_tick` takes the field. `tick_gate` ignores it and carries the counts forward.

Schema version 6 adds `slots.pending_approvals INTEGER NOT NULL DEFAULT 0`; it applies once, in
place, and existing rows read 0. Callers older than this change ignore the argument.

## Aquila's ledger

Only the `direction` role can read or write it, and its writes never wake the AFK loop's gate.

- **Children:** `child_start` records a thread Aquila launched or delegated; `child_close`
  records its verified outcome (`done`, `failed`, `abandoned`). `ledger_read` lists the open
  ones (`include_closed` for all).
- **Owner presence:** `owner_turn` at the start of every owner turn sets `last_owner_turn`. It counts from
  the `direction` holder or a registered owner thread (`owner_thread_set`, argus#54).
  The owner is present for 30 minutes after it, unless the turn passed `stepping_away`, which
  switches to away at once.
- **Since you left:** `away_note` appends a line while the owner is away. The next
  `owner_turn` returns the pending lines once and marks them handed over.
- **Notified items:** `notify_claim` takes a class (`needs_owner`, `stall`, `window`) and every
  item that qualifies now, returns the ones never notified, and records them, so each item
  pushes once. A class gets one push per tick (since Aquila's last recorded tick); later new
  items in the same tick come back as `deferred`, unrecorded.
- **Stall outages:** `outage_observe` takes whether the AFK loop is stalled now. It returns
  `notify: "outage"` when an outage opens, `"recovery"` when it closes, and null otherwise, so
  a stall pushes once per outage plus once on recovery.

## Run

```bash
pnpm --filter @argus/loop-state-mcp build
LOOP_STATE_TOKENS='afk=…,direction=…,worker=…' node apps/loop-state-mcp/dist/index.js
```

| Variable | Default |
|---|---|
| `LOOP_STATE_TOKENS` | required; tokens are at least 24 characters |
| `LOOP_STATE_DB` | `~/.argus/backlog-loop/loop.db` (the directory is created) |
| `LOOP_STATE_HOST` | `127.0.0.1` |
| `LOOP_STATE_PORT` | `3791` |
| `LOOP_STATE_CADENCE_MINUTES` | `30` |
| `LOOP_STATE_PROMOTION_TOKEN` | unset: `POST /events/promoted` and `POST /wake/request` refuse everyone. Set: at least 24 characters, and not a role token |

`GET /healthz` is open. `/mcp` is Streamable HTTP, stateless, behind the bearer token.
The db runs in WAL mode; schema versions live in `PRAGMA user_version`, and a later version
is appended to `MIGRATIONS` in `src/store.ts`, never edited in place.

## Test

`pnpm test`. The suites build the server in-process on a temp SQLite file with a test clock
and call the MCP tools as each role (argus-config#662, test seam 1).

## Deploy

On the homelab, from `~/repos/argus` (the deploy copy, on `main`):

```bash
bash apps/loop-state-mcp/deploy.sh --install   # first time: also links and enables the unit
bash apps/loop-state-mcp/deploy.sh             # every later deploy
```

`deploy.sh` reads `loop-state-token-afk`, `loop-state-token-direction` and
`loop-state-token-worker` from Bitwarden Secrets Manager (`~/.bws_token`), refuses if any is
missing or shorter than 24 characters, and writes them as `LOOP_STATE_TOKENS` into a 0600
`~/.config/argus/loop-state-mcp.env` (outside the deploy copy so an agent can fix it, [argus-config#1267](https://github.com/deanjstone/argus-config/issues/1267); the old `apps/loop-state-mcp/.env` is deprecated and `deploy.sh` warns while it remains; the unit loads the old file first and the new one after it) (plus `LOOP_STATE_PROMOTION_TOKEN` from the optional `loop-state-promotion-token` secret, which turns
`POST /events/promoted` on), with the db at `~/.argus/backlog-loop/loop.db` on local disk. It builds
this package, links `systemd/loop-state-mcp.service` into `~/.config/systemd/user/` on
`--install`, reloads systemd, restarts the unit, and waits for `/healthz`. No token is ever printed.

The unit sets `ManagedOOMPreference=omit` ([homelab#424](https://github.com/deanjstone/homelab/issues/424)):
systemd-oomd killed it at 14 MB under `app.slice` memory pressure on 7 Nov 2026, which stalled
every slot and tick, so oomd now picks an agent or CI scope first. oomd reads the property
when the unit starts, which is why the deploy reloads before it restarts. Check it with
`systemctl --user show loop-state-mcp -p ManagedOOMPreference` (reads `omit`).

The server binds `127.0.0.1:3791`. The tailnet reaches it through `tailscale serve`, set
once by hand: `tailscale serve --bg --https=3791 http://127.0.0.1:3791`, which publishes
`https://homelab.tailnet-example.ts.net:3791/mcp` (tailnet only).

**Registration** lives in argus-config, not here: `register_loop_state_mcp` adds one
user-scope `loop-state` entry to `~/.claude.json` on WSL2, whose headersHelper
(`hooks/loop-state-mcp-headers.mjs`) sends the token of the orchestrator workspace the
session runs in (the charter map `envs/wsl2/charters.txt`: `~/aquila`, `~/afk`) and the `worker` token anywhere
else. `scripts/loop-state-client-token.sh` writes the three tokens to `~/.argus/loop-state/`.

**Turn-start cost** (argus-config#669, measured against T3's 90 s MCP registration limit,
argus-config#656): the headersHelper runs in 32–37 ms, and a loopback
`initialize` + `tools/list` takes 31–80 ms. Time to a `claude -p` session's `init` event
had a median of 10.15 s with this server against 9.95 s with no MCP server at all, inside
the 8.3–10.2 s spread of the empty runs; the notice board, on the same host over the
tailnet, came in at 10.10 s.

The live deploy is [argus-config#670](https://github.com/deanjstone/argus-config/issues/670),
with the owner. This package has no release track yet.
