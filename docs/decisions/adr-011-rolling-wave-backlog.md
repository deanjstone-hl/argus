---
title: ADR-011 — Manage the Ecosystem Backlog with Rolling Waves
status: accepted
date: 2026-09-29
summary: "ADR-011: the ecosystem backlog board is ordered by rolling waves"
read_when:
  - placing an issue on the backlog board
  - changing board fields
---

# ADR-011: Manage the Ecosystem Backlog with Rolling Waves

## Context

The Argus Ecosystem Backlog board (`deanjstone/projects/2`) tracks issues from every repo in
the ecosystem. By 2026-09-29 it had accumulated four ordering systems that overlap and
disagree:

| Field | What it was for | Who set it |
|---|---|---|
| `Priority` (Next Up / Backlog) | "Should this be worked soon" | `/todo` at filing, and the CLAUDE.md "Board triage" rule |
| `Priority Rank` (number) | Order within Priority | Rarely anyone |
| `Wave` (W0–W7) + `Wave Category` (free text, 55 labels) | A sequenced chart for clearing the backlog ([#341](https://github.com/deanjstone/argus/issues/341)) | Only `backlog-waves drift`, run by hand |
| `Category` (Wayfinder Map / Regular) | Flags wayfinder maps | Wayfinder |

Filing an issue set `Priority`, but only `Wave` drove sequencing. So a new issue arrived "Next
Up" but with no wave, and stayed that way until someone ran `drift`: 21 open issues were in
that state on 2026-09-29. The SessionStart carryover signal counted `Priority`; the
`backlog-waves` skill counted `Wave`. Two answers to "what's next" were live at once.

The wave chart itself had worked: sequencing decisions that *delete* work ahead of the work
they would delete cleared W0 entirely and most of W1–W3. But it was built as a one-off. The
skill said it "is built for exactly one chart and is meant to end". The later waves became
subject buckets rather than plans: W4 and W7 each held about 52 open issues. There was no rule
for how a wave closes, or how the next one is cut.

The board was also linked to no live repository. Its only link was `code-relay`, which has
been archived since the argus-infra consolidation (ADR-010). So the board had no home and did
not appear under any active repo's Projects tab.

### Options considered

1. **Scope-boxed, numbered rolling waves** (chosen). Each wave has a goal and exit criteria
   and closes when the goal is met, not on a date. Waves are numbered, so there's a record of
   what shipped in each.
2. **Now / Next / Later lanes.** The simplest option, and a common product-roadmap format.
   Rejected: it keeps no history of what shipped when, and "Later" becomes the same unordered
   pile this ADR is trying to get rid of.
3. **GitHub's Iteration field (time-boxed cycles, Scrum-style).** Native, dated, and gives
   velocity. Rejected: work here is solo and agent-paced, so the dates would be invented, and
   a calendar box creates pressure to close unfinished work rather than finish it.
4. **Keep W0–W7 and just add rules.** Rejected: keeps the 52-issue buckets, which are the
   problem.
5. **An argus-only board.** Rejected: the backlog is cross-repo by nature. Most of #341's
   gates are cross-repo.

### Industry practice this draws on

- **Rolling-wave planning** (PMI, *PMBOK Guide*). Plan near-term work in detail and far-term
  work coarsely, and refine each wave as it approaches. That is exactly the Current / Next /
  Later split below.
- **Kanban's explicit policies and WIP limits.** The rules for entering and leaving a wave
  are written down (this ADR), and in-progress work is capped.
- **Now / Next / Later roadmaps.** Only the next two horizons carry commitments.
- **Shape Up** (Basecamp). A backlog is a liability, not an asset, and work is scoped by
  appetite. Hence the fixed wave-size cap and the pruning of stale items.

## Decision

**The board is managed as a sequence of scope-boxed, numbered rolling waves.**

### Fields

| Field | Values | Rule |
|---|---|---|
| `Wave` | `W<n>` for the Current and Next waves, plus `Later` and `Triage` | The single ordering field. New issues land in `Triage`. |
| `Status` | Todo / In Progress / Done | Kept as-is. The `In Progress` board column has a WIP limit. |
| `Execution Mode` | AFK / HITL / BOTH | Kept: says whether an agent can take the issue unattended. |
| `Category` | Wayfinder Map / Regular | Kept. |

**Retired:** `Priority`, `Priority Rank` and `Wave Category`. Grouping within a wave uses
native sub-issues (the `Parent issue` field), which wayfinder maps already use.

### Wave rules

- **At most two waves are detailed at any time.** The *Current* wave is being worked. The
  *Next* wave is planned and gated but not started. Everything else is `Later`, unordered.
- **Each wave has a name and a size cap of about 10–15 issues.** They are recorded in the
  `backlog-waves` skill's `waves.json` (amended 2026-10-07; originally also rendered into the
  chart issue, which has since been retired — see Consequences). Waves originally also had a
  goal and exit criteria; those were dropped on 2026-10-07 (see below).
- **Within the Current wave, work is taken in dependency order.** GitHub's native issue
  dependencies (`blockedBy`) gate it, as they do today.
- **A wave advances when its last issue closes** (amended 2026-10-07). The Next wave then
  becomes Current with no review, and a new Next wave is cut from `Later`. `Later` is pruned
  at the same time: an issue untouched for 90 days is closed as stale with a comment, or
  explicitly kept.

  Originally a wave closed when its goal was met, through a four-step review: carry over
  unfinished issues, promote Next, cut a new Next, prune `Later`. The owner dropped goals,
  exit criteria and the closing review on 2026-10-07. W1's exit criteria had stopped
  describing how issues were actually handled, and the board as it stood was the intended
  way of working. The `close-wave` mode became `cut-next`, which keeps only the last two
  steps.
- **`Triage` is always emptied.** Every triaged issue is placed in the Current wave, the Next
  wave or `Later`, or it is closed.

### Board home

The board stays ecosystem-wide and is linked to `argus`, which holds this ADR. The link was
made on 2026-09-29. The `code-relay` link remains only because an archived repository is
read-only and cannot be unlinked without unarchiving it.

### Keeping the method in place

GitHub's built-in auto-add workflow cannot carry intake on its own. Each workflow targets one
repository, a Pro plan allows five, and none of them add existing issues retroactively
([docs.github.com, "Adding items automatically"](https://docs.github.com/en/issues/planning-and-tracking-with-projects/automating-your-project/adding-items-automatically)).
The ecosystem has 17 active repos. Board column limits are advisory only, not enforced
([docs.github.com, "Customizing the board layout"](https://docs.github.com/en/issues/planning-and-tracking-with-projects/customizing-views-in-your-project/customizing-the-board-layout)).
So the rules are kept in place by the tooling that already runs:

1. **Filing:** `/todo` (and the other issue-filing skills) add the issue to the board with
   `Wave = Triage`.
2. **Daily sweep:** the homelab `session-tasks` job adds any open issue missing from the
   board, sets it to `Triage`, and reports three things: the `Triage` count, an `In Progress`
   count over its limit, and any wave over its size cap.
3. **Session signal:** `carryover-signal.sh` reads `Wave`, not `Priority`.
4. **Rules:** the CLAUDE.md "Board triage" rule is rewritten to this method in every
   environment.
5. **Skill:** `backlog-waves` becomes permanent. Its "meant to end" clause is removed, and it
   gains a `close-wave` mode that walks through the closing review above (replaced by
   `cut-next` on 2026-10-07, when the closing review was dropped).

### Re-cut

The existing chart is re-cut rather than carried over:

- **Numbering restarts at W1** (amended 2026-09-29, before any migration ran; originally
  continued from W8). Renaming an option keeps the values already set on items, in the UI
  or through `updateProjectV2Field` as long as each existing option's `id` is passed.
  Tested on a scratch project, then applied on 2026-09-29: all 638 items' values were
  identical before and after. Omitting an `id` recreates that option and clears its values.
  The steps ran in this order:
  1. Rename the old options `W0`…`W7` to `old-W0`…`old-W7` (done 2026-09-29).
  2. Add the new `W1`, `W2`, `Later` and `Triage` (done 2026-09-29).
  3. Re-cut from the old values.
- `old-W1`'s open issues become the Current wave (W1).
- `old-W2`'s open decisions become the Next wave (W2).
- `old-W3`…`old-W7` go to `Later`.
- Anything found stale during the re-cut is closed rather than moved.
- **The old options are deleted when the retired fields are**, which clears which old wave
  each closed issue belonged to. That loss is accepted. A `board.py dump` snapshot is posted
  to the retirement ticket first, so the history survives in text form.

## Consequences

- There is one answer to "what's next": the Current wave, minus anything with an open
  blocker. The carryover signal and `backlog-waves` agree because they read the same field.
- The migration touches about 15 files in `argus-config` that read or write `Priority`:
  - the `todo` skill;
  - `carryover-signal.sh` and `board-priority-check.sh`;
  - `session-tasks-daily.sh`;
  - `common/todo-convention.md`;
  - the CLAUDE.md for all four environments;
  - their bats tests.

  `Priority` and its siblings can only be deleted after every one of those consumers has
  moved. Deleting a single-select field clears its values irreversibly.
- The migration is tracked as a task-type wayfinder map in this repo.
- Waves no longer finish on a date, or on a goal (amended 2026-10-07). The trade-off is
  that nothing forces a wave closed: an issue that never closes holds its wave as Current
  indefinitely. The size cap and the 90-day `Later` prune are what stop the old drift back
  toward big buckets.
  If waves start to overrun, cap the wave harder rather than add a deadline.
- **The chart issue is retired** (amended 2026-10-07; originally
  [#341](https://github.com/deanjstone/argus/issues/341) stayed the chart issue, its rendered
  regions showing the Current and Next waves in detail). The owner closed #341 on 2026-10-07
  because it had served its purpose. By then it had fallen well behind the board (it showed
  W2 as current and an empty `Triage`, while the board had W1 current and 55 in `Triage`).
  The board's `Wave` field is now the only record of the waves. The skill's `render` mode
  was removed in [argus-config#448](https://github.com/deanjstone/argus-config/pull/448).
- Adding an issue by hand from an unusual path (the GitHub UI, another tool) still reaches
  the board, but only at the next daily sweep. For up to a day it is visible in its repo and
  absent from the board.
