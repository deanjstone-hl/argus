# AGENT_VIEW_BACKEND drift: why ccbot reverted to the `cli` backend

Research ticket: [argus#216](https://github.com/deanjstone/argus/issues/216) (child of map [#214](https://github.com/deanjstone/argus/issues/214)).
Investigated 2026-08-10. All claims below cite primary sources (commit diffs, PR diffs, live file contents).

## Question

Spec [#135](https://github.com/deanjstone/argus/issues/135)'s resolution states ccbot's `AgentViewMonitor` was "deployed and flipped to `herdr` as the live default 2026-08-05" (PR [ccbot#26](https://github.com/deanjstone/ccbot/pull/26)). The live runtime `~/.argus/ccbot/.env` now reads `AGENT_VIEW_BACKEND=cli`. Why did it revert?

## Findings

### 1. `deploy.sh` never defaulted to `herdr` — in either repo, at any point

`apps/ccbot/deploy.sh` in `argus` has exactly one commit in its history: `705e019`, the subtree-add of ccbot's history (`git log --all --oneline -- apps/ccbot/deploy.sh`). Its content is byte-identical to the archived `deanjstone/ccbot` repo's `deploy.sh` at `main`, whose full history is four commits (`8dd61e0`, `99cc7cf`, `f1d2188`, `d42f54f`).

The only commit that ever touched `AGENT_VIEW_BACKEND` in `deploy.sh` is **`d42f54f`** ("feat(deploy): support AGENT_VIEW_BACKEND/AGENT_VIEW_HERDR_SHADOW", PR [ccbot#28](https://github.com/deanjstone/ccbot/pull/28), merged 2026-08-05T21:27:51Z). Its diff adds:

```sh
AGENT_VIEW_BACKEND="${AGENT_VIEW_BACKEND:-cli}"
AGENT_VIEW_HERDR_SHADOW="${AGENT_VIEW_HERDR_SHADOW:-0}"
...
echo "AGENT_VIEW_BACKEND=${AGENT_VIEW_BACKEND}"             >> "$ENV_FILE"
echo "AGENT_VIEW_HERDR_SHADOW=${AGENT_VIEW_HERDR_SHADOW}"   >> "$ENV_FILE"
```

Live today at `apps/ccbot/deploy.sh:66-81` (`:70` is the `cli` default). The default has **always** been `cli`; the value comes solely from the **calling shell's environment at deploy time**.

### 2. PR ccbot#26 did not touch `deploy.sh` at all

`gh pr diff 26 -R deanjstone/ccbot` contains no `deploy.sh` hunk. It added the flag *support* in application code — `src/utils/agent-view-monitor.ts` gained `process.env.AGENT_VIEW_BACKEND === 'herdr' ? 'herdr' : 'cli'` (diff line 1109) — plus `herdr-agents.ts` and a vitest parity suite. `.claude/SYSTEM.md` was updated in the same PR to state `cli` is the default. So #135's "PR ccbot#26 … flipped to herdr as the live default" conflates *code support* (#26) with a *live runtime flip* that #26 never made.

### 3. `deploy.sh` truncates `.env` on every run — a hand-edit was never survivable either

`apps/ccbot/deploy.sh:61` is `: > "$ENV_FILE"`. This predates the herdr work: it is present at `f1d2188` (`git show f1d2188:deploy.sh`, line 61), i.e. before `d42f54f`. So both possible flip mechanisms were non-durable:

- **Before `d42f54f`**: `.env` was truncated and the flag was never re-written, so a hand-edited `AGENT_VIEW_BACKEND=herdr` line vanished on the next deploy and the code default (`cli`) took over.
- **After `d42f54f`**: the flag is re-written, but only from the deploying shell's environment.

`d42f54f`'s own commit message says this explicitly: *"deploy.sh's .env template didn't write these two flags at all, so every deploy silently reset a live backend flip back to the hardcoded defaults."*

### 4. The flip was a one-shot shell variable, persisted nowhere

`deploy.sh` fetches exactly six secrets from Bitwarden Secrets Manager by explicit key (`apps/ccbot/deploy.sh:39-55`): `telegram-argus-ccgram-bot-token`, `telegram-owner-chat-id`, `slack-argus-bot-token`, `slack-argus-app-token`, `openai-api-key`, `slack-argus-app-config-token`. There is no `bws_secret` call for `AGENT_VIEW_BACKEND` — so even if a BWS/Bitwarden item stored `herdr`, **`deploy.sh` would never read it**.

Nor is it set at the service layer: `~/.config/systemd/user/ccbot.service` has only `Environment=NODE_ENV=production`, `Environment=NODE_OPTIONS=--dns-result-order=ipv4first`, and `EnvironmentFile=/home/deanj/.argus/ccbot/.env` — the very file `deploy.sh` truncates.

[ccbot#27](https://github.com/deanjstone/ccbot/issues/27) (the retroactive Director-Agent record) confirms the mechanism: *"Deployed 2026-08-05: validated in shadow mode against live data …, then flipped `AGENT_VIEW_BACKEND` to `herdr` as the default and redeployed."* Given #2/#3 above, "flipped … and redeployed" can only mean `AGENT_VIEW_BACKEND=herdr bash deploy.sh` — which is exactly the capability `d42f54f` was written to provide, and exactly as ephemeral as any other shell variable.

### 5. The argus#166 subtree-merge redeploy is the clobbering event

[argus#166](https://github.com/deanjstone/argus/issues/166) / PR [argus#174](https://github.com/deanjstone/argus/pull/174) merged **2026-08-09T04:09:45Z** (merge commit `32641d9`). Its resolution comment records: *"Live homelab cutover performed and verified: built + ran `apps/ccbot/deploy.sh` (rsync to `~/.argus/ccbot/`, same target as always), `systemctl --user restart ccbot`."*

Filesystem timestamps corroborate to the second:

```
~/.argus/ccbot/dist   2026-08-09 14:14:32 +1000
~/.argus/ccbot/.env   2026-08-09 14:14:39 +1000   (= 04:14 UTC, ~5 min after #174 merged)
```

And the resulting file (`~/.argus/ccbot/.env:7-8`):

```
AGENT_VIEW_BACKEND=cli
AGENT_VIEW_HERDR_SHADOW=0
```

That deploy ran without `AGENT_VIEW_BACKEND` exported, so `:70`'s `${AGENT_VIEW_BACKEND:-cli}` supplied `cli`, and `:61`'s truncate discarded whatever was there. The service has since restarted (`ActiveEnterTimestamp=Mon 2026-08-10 18:31:40 AEST`, `active (running)`), so **ccbot is live on the `cli` backend today**, with shadow mode off.

### Timeline

| When (UTC) | Event | Source |
|---|---|---|
| 2026-08-05 11:48 | ccbot#26 merged — `AGENT_VIEW_BACKEND` code support, default `cli`. `deploy.sh` untouched | `gh pr view/diff 26 -R deanjstone/ccbot` |
| 2026-08-05 21:27 | ccbot#28 / `d42f54f` — `deploy.sh` writes the flags, default `cli`, sourced from calling shell | commit diff |
| 2026-08-05 (per #27) | Shadow-validated, then flipped live to `herdr` via a redeploy — value held only in that shell | ccbot#27 body |
| 2026-08-05 21:38 | ccbot#29 — absolute `claude`/`herdr` bin paths (systemd minimal PATH) | PR body |
| 2026-08-06 03:03 | ccbot#30 — herdr `idle` maps to `running` | PR title |
| 2026-08-07 04:19 | ccbot#31 — project-path matching fix | PR list |
| 2026-08-09 04:09 | argus#174 merged (subtree-merge ccbot into `apps/ccbot`) | `gh pr view 174` |
| 2026-08-09 04:14 | `apps/ccbot/deploy.sh` run → `.env` truncated and rewritten with `AGENT_VIEW_BACKEND=cli` | file mtimes + contents |

Note: any of the 08-05 → 08-07 redeploys for #29/#30/#31 would have had the same effect unless the deployer re-exported the variable each time. The 08-09 deploy is simply the last one, and the one whose artefacts are still on disk.

## Root cause

**The `herdr` flip was never made durable — it existed only as a shell variable on one `deploy.sh` invocation.** `deploy.sh` truncates `~/.argus/ccbot/.env` on every run (`apps/ccbot/deploy.sh:61`) and re-derives `AGENT_VIEW_BACKEND` from the calling shell, defaulting to `cli` (`:70`). There is no committed default, no BWS secret read, and no systemd `Environment=` entry holding `herdr`. Any redeploy by anyone not manually exporting `AGENT_VIEW_BACKEND=herdr` silently reverts the backend. The argus#166 subtree-merge redeploy on 2026-08-09 04:14 UTC was that redeploy.

This confirms the ticket's stated hypothesis, with one refinement: the flip was most likely a one-shot env var on the deploy command (the mechanism `d42f54f`/ccbot#28 was written to enable), not a hand-edit of `.env`. Both are equally non-durable, and neither leaves a trace in the repo — which is why the drift was silent.

A secondary contributor: #135's resolution comment attributes the live flip to PR ccbot#26, which never touched deploy config. Anyone auditing the flip from that comment would inspect ccbot#26's diff, find the flag plumbing, and reasonably conclude the rollout was complete.

## Open questions

1. **Bitwarden (for a human to check — not attempted here):** does any BW/BWS item store `AGENT_VIEW_BACKEND` (e.g. `bw get item <name>` after `bw-unlock`, or `bws secret list`)? Low impact either way: `deploy.sh:39-55` fetches only six explicitly-named secrets and none is `AGENT_VIEW_BACKEND`, so an existing item would be dead weight, not a live override. Worth confirming so #217 doesn't create a duplicate.
2. **Was the 2026-08-05 herdr window long enough to count as validation?** ccbot#27 claims shadow parity was checked before the flip, but ccbot#29 (absolute bin paths) and ccbot#30 (`idle` mapping) both landed *after* the flip, each requiring a redeploy that would itself have reverted the backend. It is unclear how much wall-clock time ccbot actually spent on `herdr`, so "confirmed stable" per `.claude/SYSTEM.md`'s staged-rollout rule may not have been met.
3. **Do sibling deploys have the same shape?** `code-relay` was deployed live in the same #135 push. Not examined here; worth a glance if the fix generalises.

## Recommendation

Fix belongs to [#217](https://github.com/deanjstone/argus/issues/217) (blocked on this ticket) — nothing changed here. #217 should make the backend choice durable rather than just re-running the flip, since a bare re-flip would drift again on the next deploy. Options, in rough order of directness:

- Change `apps/ccbot/deploy.sh:70`'s default to `herdr` (committed, reviewable, versioned) — the shell override still works for rollback.
- Or add a persisted config source `deploy.sh` reads (a BWS key alongside the existing six, or a non-truncated `~/.argus/ccbot/.env.local` merged in).
- Either way, `deploy.sh:61`'s truncate is worth calling out in the file itself: any runtime-only `.env` edit is discarded on the next deploy.

#217 should also correct the record on #135 (and ccbot#27) noting the flip was ephemeral, and re-run the live parity/stability check per `apps/ccbot/.claude/SYSTEM.md:16`, given open question 2 above.
