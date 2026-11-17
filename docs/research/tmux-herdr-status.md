# Research: tmux.ts / ccbot#25 herdr pane-control status

Resolves deanjstone/argus#218 (child of map #214). Investigation date: 2026-08-10.

## 1. Is `tmux.ts` still shelling out to real `tmux`?

Yes, unchanged. Read in full at
`~/repos/argus/apps/ccbot/src/utils/tmux.ts` (worktree copy:
`apps/ccbot/src/utils/tmux.ts`, 98 lines). Every exported function still
calls `spawnSync('tmux', ...)` via the shared `run()` helper (lines 5–15):

| Export | Line(s) | tmux subcommand |
|---|---|---|
| `getCurrentSession()` | 25–29 | `display-message -p '#S'` |
| `getCurrentSessionWindow()` | 32–36 | `display-message -p '#S:#W'` |
| `hasSession()` | 38–41 | `has-session -t <name>` |
| `listSessions()` | 43–47 | `list-sessions -F '#{session_name}'` |
| `sendKeys()` | 53–71 | `send-keys -t <session> -l <text>` then `send-keys -t <session> Enter` |
| `capturePane()` | 73–77 | `capture-pane -t <session> -p -S -<lines>` |
| `startPipeCapture()` | 79–87 | `pipe-pane -t <session> -o 'cat >> "<file>"'` |
| `stopPipeCapture()` | 89–97 | `pipe-pane -t <session>` (no `-o`, which detaches the pipe) |

`validateSessionName()` (lines 18–22) still allows the tmux `session:window`
form via `^[a-zA-Z0-9_:.\-]+$`, called from every function that takes a
session argument. No herdr import, socket call, or `herdr` binary
invocation appears anywhere in the file. Confirms the ticket's premise
exactly.

Call sites outside `tmux.ts` (grepped across `apps/ccbot/src`):
- `src/utils/controller-injector.ts` — `sendKeys()` (line 34) and
  `listSessions()` (line 70); `defaultSession` sourced from
  `config.defaultSession || process.env.TMUX_SESSION || 'claude-code'`
  (line 20).
- `src/utils/tmux-monitor.ts` — `hasSession()` (124), `capturePane()`
  (138, 350, 435), `startPipeCapture()`/`stopPipeCapture()` (316, 326);
  `sessionName` defaults to `process.env.TMUX_SESSION || 'main:argus'`
  (line 41).
- Channel entrypoints (`telegram/webhook.ts`, `matrix/listener.ts`,
  `slack/socket.ts`, `start-matrix-listener.ts`, `start-slack-socket.ts`)
  all thread a static `TMUX_SESSION`/`defaultTmuxSession` config string
  (default `'main:argus'`) down into these calls — this is the
  "config-supplied name" ccbot#25's Question 1 refers to.

## 2. Any herdr-related work on `tmux.ts` since ccbot#25 (~2026-08-05) or the argus#166 subtree merge (2026-08-09)?

None. `git log --all --oneline -- apps/ccbot/src/utils/tmux.ts` in
`~/repos/argus` returns exactly one commit:

```
705e019 Add 'apps/ccbot/' from commit of ccbot main
```

`git show -s --format="%H %ai %s" 705e019` → `2026-08-09 14:05:23 +1000`
— this is the raw subtree-import commit itself (the argus#166 merge), not
a herdr-cutover commit. The same is true for `tmux-monitor.ts` (identical
single-commit history). No commit in `git log --all --oneline -i
--grep="herdr" -- apps/ccbot` matches anything. The addressing-model
mismatch ccbot#25 flagged is exactly as unresolved today as when the
issue was filed.

## 3. ccbot#25's three open questions — re-checked against the live `herdr` CLI

Environment: `herdr` 0.8.0 (client+server), protocol 19, installed at
`~/.local/bin/herdr`, server running locally
(`~/.config/herdr/herdr.sock`). Commands run live in this session:
`herdr agent --help`, `herdr pane --help`, `herdr agent list`,
`herdr pane list`, `herdr agent get <pane_id>`, plus per-subcommand
`--help` for `agent read/send-keys/prompt/rename/wait`,
`pane read/wait-output/send-text/send-keys/run/rename/report-agent-session`.

### Q1 — What identifies "the session ccbot should act on" under herdr, and how does a config-supplied name map to a herdr `pane_id`/agent name?

**Still unanswered — genuinely open.** Live `herdr pane list` /
`herdr agent list` output confirms `pane_id` is a dynamically assigned,
opaque identifier scoped to the current herdr server session — e.g.
`"pane_id":"wX:p8"`, `"pane_id":"wC:pC"` — generated per pane at
creation time, not something an operator picks or a config file can
predict in advance. There is no `herdr pane find`/`agent find`-by-name
subcommand in the CLI surface; the only way to resolve "the pane ccbot
should act on" is to enumerate `herdr pane list` / `herdr agent list` and
filter client-side on `cwd`/`foreground_cwd`/`terminal_title`/
`agent_session`, or to have previously recorded a `pane_id` via
`herdr pane report-agent-session` / `herdr agent rename`. None of this
existed when ccbot#25 was filed and none of it exists now. ccbot's
config today (`TMUX_SESSION` env, `defaultSession`/`defaultTmuxSession`,
default `'main:argus'`, confirmed via grep above) has no counterpart
concept on the herdr side — this mapping layer would be new code, and
its design is exactly the "research spike" ccbot#25 scoped out.

### Q2 — Does herdr expose a background output-capture-stream equivalent to `tmux pipe-pane`, or does `TmuxMonitor` need a redesign around `agent read`/`agent wait`?

**Partially answered — the "not found" premise is now outdated.**
argus#135 and ccbot#25 both stated the CLI help surface at the time
covered only `agent read`/`send-keys`/`prompt`/`attach` with no
"start a background capture stream" subcommand. That is no longer
accurate: `herdr pane wait-output <PANE_ID> --match <TEXT>|--regex
<PATTERN> [--timeout <MS>]` now exists, and per its own `--help` text:
"The selected snapshot is searched immediately, including existing
output, then polled. Without --timeout, this waits indefinitely." That
is a genuine equivalent-in-purpose primitive for `TmuxMonitor`'s
completion/waiting-pattern detection — which is what `startPipeCapture`
+ file-tail is actually used for in `tmux-monitor.ts` (watching for
specific text patterns, not archiving raw output). Combined with
`herdr agent wait <TARGET> --until <idle|working|blocked|done|unknown>
[--timeout <MS>]` (state-based waits, also polls indefinitely without
`--timeout`), the two together cover `TmuxMonitor`'s actual use case.

Caveat: this is **not** a byte-identical `pipe-pane` replacement.
`pipe-pane` continuously tees *all* pane output to a file for later
arbitrary inspection; `wait-output` is a targeted poll-until-match
primitive with no persistent capture file. If `TmuxMonitor` or any
caller relies on `startPipeCapture`'s side effect of an append-only
capture file for something other than pattern matching (not confirmed
either way in this pass — would need a read of `tmux-monitor.ts` call
sites), `wait-output` alone would not be a drop-in swap. But for the
specific gap ccbot#25/argus#135 flagged ("no background capture-stream
equivalent found"), the CLI surface has since grown one.

### Q3 — Can `validateSessionName`'s contract (`session:window`, colon-inclusive) survive as an external seam if the internal target is a herdr `pane_id`?

**Yes, structurally — the "no colons" premise needs a correction.**
ccbot#25 states herdr's addressing scheme is "lowercase only, no colons,
32-char cap" via the regex `^[a-z][a-z0-9_-]{0,31}$`. Live output shows
that regex describes the *optional, human-assigned agent name*
(settable via `herdr agent rename <target> <name>`) — not `pane_id`
itself. Actual `pane_id` values observed live (`wX:p8`, `wC:pC`, `wA:p3`,
`w0:p1`) are themselves colon-delimited two-part identifiers
(`<workspace_id>:<pane_num>`), structurally analogous to tmux's
`session:window`. So `validateSessionName`'s regex (which already
permits colons, dots, underscores, hyphens) does not need to change
shape to eventually carry a herdr identifier instead of a tmux one — the
open work is still the *mapping* from ccbot's config string to a live
`pane_id` (see Q1), not the validator's character class.

## 4. Recommendation: re-file ccbot#25 as a child of map #214, or cross-link and leave it?

**Recommend re-filing as a new child issue of #214**, for these reasons:

- `deanjstone/ccbot` is archived (read-only) — no comments, labels,
  sub-issue linking, or project-board attachment are possible on the
  original, and map #214 explicitly tracks this rewrite's children via
  GitHub's sub-issue mechanism, which an archived repo's issue cannot
  participate in.
- The code itself already moved: `apps/ccbot/src/utils/tmux.ts` now
  lives in `deanjstone/argus` (subtree-merged at 705e019, argus#166) —
  the spike's subject matter is physically in this repo now, and the
  map's other children (#218 itself, and whatever bug-fix/improved-scope
  ticket depends on this one — #218's `blocking: #221`) are argus
  issues.
- ccbot#25's content is still fully sound as written (its three
  questions are still open in substance; only Q2's premise needed a
  factual update, captured above) — it can be copied over verbatim with
  this research folded in as a "known-as-of" addendum, rather than
  reworked from scratch.

If re-filed, recommend leaving a closing comment on ccbot#25 pointing to
the new argus child issue for continuity/history, rather than deleting
or silently abandoning it (not done in this pass — re-filing was
explicitly excluded from this research ticket's scope).

## Sources

- `~/repos/argus/apps/ccbot/src/utils/tmux.ts` (full read)
- `~/repos/argus/apps/ccbot/src/utils/tmux-monitor.ts`,
  `controller-injector.ts`, `channels/{telegram,matrix,slack}/*`,
  `start-matrix-listener.ts`, `start-slack-socket.ts` (grep for
  `tmux.*`/`TMUX_SESSION`/`defaultSession`)
- `git log --all --oneline -- apps/ccbot/src/utils/tmux.ts` in
  `~/repos/argus` (commit 705e019, 2026-08-09 14:05:23 +1000)
- `gh issue view 218 -R deanjstone/argus`
- `gh issue view 25 -R deanjstone/ccbot`
- Live `herdr` 0.8.0 CLI (`herdr --help`, `herdr agent --help`,
  `herdr pane --help`, `herdr api --help`, `herdr notification --help`,
  `herdr session --help`, and per-subcommand `--help` for `agent
  list/get/read/send-keys/prompt/rename/wait` and `pane
  list/current/get/read/wait-output/send-text/send-keys/run/rename/
  report-agent-session`), and live `herdr agent list` / `herdr pane
  list` / `herdr agent get <pane_id>` output against this session's
  running herdr server (`~/.config/herdr/herdr.sock`, protocol 19)
