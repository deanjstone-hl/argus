# Memory surfacing audit: which relevant memories fail to surface unprompted (argus#1142)

Read-only audit, run 16 Nov 2026 (about 23:00 AEDT). Nothing in the memory store, hooks, vault or `~/CONTEXT` was changed. The hook was replayed once with a throwaway session id (it reads the store and writes only a marker file in the OS tmp dir, which was removed).

## Answer in five lines

1. **Nothing relevant is pushed into a session, and the push channel is currently broken.** `list-memories-first-prompt.mjs` reads the old Supabase `memories` table. That table stopped receiving writes at the D1/Vectorize cutover on 20 Oct 2026 (argus#704, run 11:08 to 11:54 AEDT). Every session since then gets the same 5 critical plus 15 "recent" memories, newest dated 20 Oct 2026 00:39 UTC (11:39 AEDT). The live store (`memory_list`, `memory_search`) has memories up to 16 Nov.
2. **Even when it worked, the push was not about the task.** The hook never looks at the prompt: 5 critical rules (three duplicate CLAUDE.md) plus the 15 most recently updated keys, with no bodies. Hit rate for the 12 tasks that had a needed memory in the store: 0 of 12 from the recent list, 1 partial from the critical list.
3. **Search finds them when asked.** All 12 needed memories were found by one natural query each, at rank 1 to 7 (11 of 12 within the top 5). Nobody asked.
4. **6 of 20 tasks had nothing to find yet.** The knowledge reached the store 9 hours to 10 days after the task started (session-extract runs at 03:30 AEDT the next day; inbox captures took 6 to 10 days).
5. **No fix is applied here.** Six proposed fixes are at the end, ranked by effect, with a size each.

## Method

- **Tasks.** 20 real tasks from `~/CONTEXT/SESSIONS/` stubs, 13 Oct to 9 Nov 2026: 7 argus-config, 6 homelab, 7 product repos (4 myargus/atto1, 2 argus, 1 budget). The stub's `Goal` section is the first prompt the agent saw (all were AFK slot briefs, so the first prompt is the issue brief).
- **Needed.** A memory counts as needed only if it was in the store **before the task started** (`created_at` earlier than the stub's `started`, in UTC) and its "How to apply" bears on the task. Memories extracted from the task's own session (`Source session: [[SESSIONS/<task>]]`) are excluded, since they cannot have helped. Judged by reading the memory text returned by `memory_search`, and the files in `~/CONTEXT/MEMORY/` for two spot checks.
- **Surfaced unprompted.** The two hook outputs an agent receives with no search: the SessionStart signals (project registry, carryover, none of which list memories) and `list-memories-first-prompt.mjs`. The replay output is in the appendix.
- **Search.** One `memory_search` call per task with the natural query an agent would type (shown in the table), default semantic ranking. The tool returns a similarity score; ranks are within the returned list. `memory_search` ran against the live store as of 16 Nov, so a memory written after the task can appear above a needed one. Those are noted and not counted as needed.
- **Limits.** One query per task, not a tuned query. "Needed" is my judgment from the memory text, not from re-running the task. The hook's state on each task date cannot be replayed (no history of the table), so the unprompted column uses today's hook output plus the recent-list time window: the 15 recent slots span about one day, so a task more than a day after a memory's `updated_at` could not have seen it either way.

## Per-task table

Keys are memory keys in the store. "Search rank" is the position of the needed memory for the query shown. Unprompted is **no** for every task unless stated.

| # | Task (repo, issue, start AEDT) | Natural query | Needed (pre-existing) | Unprompted | Search rank | Cause of miss |
|---|---|---|---|---|---|---|
| 1 | argus-config#684 stop secrets landing in transcripts, 19 Oct 22:55 | `secrets in session transcripts guard` | `pattern_cat_secret_file_leaks_transcript` (0.694); family: `fact_claude_mcp_get_leaks_bearer_token` | partial: critical `preference_bitwarden_first_always` (flag any echoed secret) | 2 | never searched |
| 2 | argus-config#891 `core.fsync=committed` in env gitconfigs, 26 Oct 09:58 | `core.fsync gitconfig WSL2 crash` | `fact_wsl2_crash_empty_git_objects` (0.768; states no repo sets `core.fsync`) | no | 1 | never searched |
| 3 | argus-config#1104 owner-steps scripts, 4 Nov 13:31 | `owner steps script live steps deploy gate` | `decision_promotion_approval_covers_manifest_deploys` (0.750, weak) | no | 4 | never searched (weak need) |
| 4 | argus-config#1152 deploy gate asks on read-only commands, 5 Nov 10:13 | `deploy gate read-only commands promote.sh false positive` | none strong; `fact_deploy_branch_push_needs_approval_thread` (weak). The two exact answers (`fact_settings_ask_globs_match_execution_only`, `fact_deploy_gate_prompts_on_script_names_in_bash`) were written after the task | no | 3 (weak) | not yet in store (extraction lag) |
| 5 | argus-config#1279 loop-wake compacts standby on stale tokens, 9 Nov 18:20 | `loop-wake compact standby thread stale context tokens` | none. `fact_loop_wake_compact_250k` (0.801) was created 9 Nov 16:30 UTC, 9 hours after the task started, from the same-day session for #1262 | no | n/a (1 once written) | not yet in store (extraction lag) |
| 6 | argus-config#818 delete LGN5 t3code backup, 31 Oct 08:53 | `delete t3code backup LGN5 Windows USERPROFILE` | none strong; `fact_t3code_wsl2_boot_service` is background only | no | 1 (background) | no relevant memory; not a miss |
| 7 | argus-config#871 directives v8 host caps, 29 Oct 10:38 | `directives host caps memory gate ladder repo_holds` | none. `fact_wake_check_no_host_caps_fields` (0.754) and `fact_ladder_v2_charter_gaps` were written after | no | n/a (1 to 2 once written) | not yet in store (extraction lag) |
| 8 | homelab#157 runner I/O tuning, 13 Oct 23:39 | `homelab runner I/O tuning disk` | `fact_linux_server` (0.752, memory-bound, HDD, runner layout); `fact_homelab_ci_concurrency_io_overload` (0.739) | no | 2 and 5 | never searched |
| 9 | homelab#300 systemd-oomd killed the user manager, 28 Oct 13:48 | `systemd-oomd killed user manager init.scope homelab` | `fact_homelab_oomd_kills_user_services_group` (0.788; kills inside `user@1000.service`, T3 scopes are victims, brief advice) | no | 2 (rank 1 was written after the task) | never searched |
| 10 | homelab free-GitHub-org migration plan, 18 Oct 06:40 | `move private repos to free GitHub organisation Actions minutes` | `decision_ci_runs_on_homelab_no_github_minutes` (0.757); `fact_github_actions_minutes_economics` (0.752; "a free org has its own 2,000 minutes") | no | 2 and 3 | never searched |
| 11 | homelab#362 jit-dispatcher deploys on promotion, 4 Nov 19:29 | `jit-dispatcher deploy self-restart JIT runner` | `fact_jit_dispatcher_unproven_until_first_live_job` (0.786). The self-restart answer was written after | no | 4 | never searched |
| 12 | homelab#231 eSCL scan service, 17 Oct 11:03 | `eSCL scanner scan service homelab` | `decision_homelab_scan_app_shape` (0.780; port 3880, hardened system unit, no login, `/api/status`) | no | 1 | never searched (the issue text links the map, which a careful agent would read) |
| 13 | homelab#246 apsjobs-discovery roles to SQLite, 22 Oct 13:27 | `apsjobs-discovery roles SQLite timer backfill` | `fact_apsjobs_discovery_service` (0.750; 07:30 timer, `state.json`, copy-installed). `decision_jobs_review_view_worker_proxy_sqlite` is captured 17 Oct but stored 23 Oct | no | 2 | never searched; second memory not yet in store (capture lag 6 days) |
| 14 | atto1#40 PGlite `beforeAll` timeout under runner load, 18 Oct 21:07 | `PGlite beforeAll timeout flake CI runner load` | none. `fact_vitest_worker_timeout_homelab_runner` (capture dated 17 Oct) reached the store on 23 Oct | no | n/a | not yet in store (capture lag 6 days) |
| 15 | myargus#364 flaky LiveNotesPage test, root cause not timeout, 29 Oct 12:07 | `flaky vitest test root cause not raising timeout myargus` | `fact_vitest_worker_timeout_homelab_runner` (0.793); `fact_budget_server_ci_flake_cpu_starvation` (0.774, "do not raise timeouts first") | no | 1 and 1 (in the #14 query) | never searched |
| 16 | myargus#406 skip Build on post-squash main push, 5 Nov 15:54 | `myargus CI skip build deploy on push to main turbo cache` | none. `fact_myargus_turbo_cache_host_dir` (0.797) and `fact_build_job_skip_needs_ref_main` (0.839) were written after | no | n/a (1 to 2 once written) | not yet in store (extraction lag) |
| 17 | argus main red, memory-mcp sync test, 18 Oct 05:18 | `memory-mcp sync-files-to-supabase test fails on main` | `fact_supabase_sync_silent_exit0_pattern` (0.817); `fact_memory_mcp_history` (0.813) | no | 1 and 2 | never searched |
| 18 | argus#574 one fail-closed constant-time bearer check, 28 Oct 06:04 | `constant-time bearer token check fail-closed Workers` | none found. Best hit 0.711 is off-topic (`fact_watchtower_empty_checks_masks_401`). A filename and content grep for `timingSafeEqual`, `constant-time`, `checkBearer` finds nothing relevant | no | never found | no memory exists, or none retrievable; not a surfacing failure |
| 19 | myargus#274 stockade photo save fails with Postgres 42P10, 13 Oct 09:05 | `stockade photo upsert Postgres 42P10 ON CONFLICT` | none. `fact_postgrest_onconflict_partial_index` (0.791) is the task's own output, captured 13 Oct, stored 23 Oct | no | n/a (1 once written) | not yet in store (capture lag 10 days) |
| 20 | budget go-live runbook, 15 Oct 14:57 | `budget go-live runbook` | `decision_budget` (0.696; hosting split, homelab Postgres, deploy.sh, cutover plan #130) | no | **7**, behind 5 legacy `todo/budget/*` stubs (June, no type) and one unrelated Actions-minutes fact | ranked low (stub noise) |

### Counts

| Outcome | Tasks |
|---|---|
| Needed memory in the store at task start | 12 (1, 2, 3, 8, 9, 10, 11, 12, 13, 15, 17, 20) |
| Surfaced unprompted by the recent list | **0 of 12** |
| Surfaced unprompted by the critical list | 1 partial (task 1, a rule CLAUDE.md already holds) |
| Found by one natural search, rank 1 | 4 (2, 12, 15, 17) |
| Found, rank 2 to 5 | 7 (1, 3, 8, 9, 10, 11, 13) |
| Found, rank 6 or lower | 1 (20, rank 7) |
| Not yet in the store when the task ran | 6 (4, 5, 7, 14, 16, 19) |
| No relevant memory found at all | 2 (6, 18) |

## The two memories the owner named

- `fact_wsl2_crash_dumps_fill_c_drive`: stored 23 Oct 2026 22:26 UTC with tags `inbox-capture, source:claude-code`, type `fact` only in the `type` column, `applies_to: sys-admin, windows, wsl2`. It is not in the hook's type-tag filter, and the hook's store does not hold it at all. `memory_search` returns it at rank 2 (0.731) for `core.fsync gitconfig WSL2 crash`.
- `decision_no_oomscoreadjust_wsl2_user_units`: added to the vault 5 Nov 2026 03:34 AEDT, `applies_to: argus-config, wsl2`. Same two blockers.

## Causes, ranked

| Rank | Cause | Evidence | Tasks affected |
|---|---|---|---|
| 1 | **The first-prompt hook reads the frozen Supabase store.** The hook queries Supabase `memories` (`SUPABASE_URL` from the deployed `.env`). The memory store moved to D1/Vectorize on 20 Oct 2026 (argus#704 session, 11:08 to 11:54 AEDT). The Supabase table has had no writes since (inferred from the data, not from a Supabase-side check): its newest row is `pattern_check_pins_before_pruning_caches`, updated 20 Oct 00:39 UTC, which is 11:39 AEDT, the cutover window | Replay below: 15 recent entries, all 19 or 20 Oct. `memory_list` returns 8 memories updated 12 to 16 Nov. The deployed script is byte-identical to the repo copy (`diff` clean, deployed 11 Nov 07:35 AEDT) | All 20, from 20 Oct onward |
| 2 | **The push is not about the task.** The hook ignores the prompt: 5 critical (sorted by key) plus the 15 most recently updated, keys and tags only, no description or body. Of 20 slots, 5 go to July-era rules (3 duplicate CLAUDE.md). The 15 recent slots cover about one day of writes (see the first lines of `memory_list`), so a relevant memory older than a day is never in them | 0 of 12 needed memories in the recent list; the one hit is a critical rule CLAUDE.md already states | 12 of 12 |
| 3 | **Never searched.** Every needed memory was one query away, at similarity 0.69 to 0.82. No task brief, charter or hook tells the agent to search before starting | 12 of 12 found at rank 1 to 7 | 12 of 12 |
| 4 | **Capture and extraction lag.** `session-extract` memories are created in a batch around 16:30 UTC (03:30 AEDT the next day), so same-day knowledge is unavailable for 9 to 24 hours. `inbox-capture` memories took 6 to 10 days to reach the store (captured 13 to 17 Oct, stored 23 Oct 22:2x UTC) | Tasks 4, 5, 7, 14, 16, 19: the exact answer exists as a later memory | 6 of 20 |
| 5 | **Ranking noise and stale content.** (a) Legacy `todo/*` stubs (type null, 5 Jun 2026) outrank real memories: `decision_budget` is rank 7 behind five of them. (b) Results carry no supersession signal: `decision_ci_runs_on_homelab_no_github_minutes` ("off permanently") still ranks 2 for a free-org query although `decision_ci_hosted_first_second_free_org` (15 Nov) reverses it. (c) `decision_budget` still says "State (2026-07-29)" | Task 20 rank; task 10 content | 2 of 12, plus latent risk on any CI-cost task |
| 6 | **Type is not in `tags` any more, and `applies_to` is unused.** Newer memories carry type only in the `type` column (for example `decision_ci_hosted_first_second_free_org`: tags `source:claude-code`). The hook filters `tags overlaps [fact, preference, ...]`, so even a fixed store would drop them. Most memories now carry `applies_to` (for example `["argus-config"]`), which would give a free repo filter, but nothing reads it | Of the 8 newest memories in `memory_list`, 1 carries a type tag | All, once cause 1 is fixed |

The index file `MEMORY.md` lists 13 hubs with counts and no individual memory, so it adds no recall by itself.

## Proposed fixes (none applied)

| # | Fix | Cause | Size | Notes |
|---|---|---|---|---|
| F1 | Point `list-memories-first-prompt.mjs` at the live store (the Worker API, whose URL and token are already in the deployed `.env` as `MEMORY_WORKER_URL`/`MEMORY_WORKER_TOKEN`), and filter on the `type` column, not tags. Add a test that fails when the newest injected row is older than 7 days | 1, 6 | S: 0.5 to 1 day, test-first | Restores the push in its present, weak form. Do this first because every session since 20 Oct lacks even that |
| F2 | Make the injection task-aware: on the first prompt, embed the prompt text, fetch the top 5 memories filtered to `applies_to` containing the cwd's repo or `all-repos`, and print key, description and the first "How to apply" line. Keep the critical set to rules not already in CLAUDE.md | 2, 6 | M: 1 to 2 days; the Worker already returns similarity scores. Latency budget under 2 s, fail open | Highest recall gain. Replay these 20 queries as the acceptance test: target 10 of 12 needed memories in the injected 5 |
| F3 | Add to the slot-worker brief template and the `research` and `grilling` skills: "run `memory_search` on the issue title and its main nouns before editing, and list the hits in your first message". Works for threads where F2 does not run (subagents) | 3 | S: under 1 hour, text only | Measure with the argus#1127 events |
| F4 | Cut the lag: run session extraction at session end or hourly instead of daily at 03:30 AEDT, and import inbox captures on arrival instead of in a batch | 4 | M: 1 day, touches the reconciler and capture path, owner-reviewed | Removes the 6 of 20 not-yet-stored cases |
| F5 | Search hygiene: exclude `todo/*` and null-type stubs from default `memory_search` (or archive them), and return a `superseded_by` hint when a newer memory has a `[[link]]` or topic overlap with a `decision_*` | 5 | S to M: half a day to exclude the stubs, 1 day for supersession | Archive of the 5 June `todo/budget/*` stubs fixes task 20 on its own |
| F6 | Drop critical rules that CLAUDE.md already holds (`preference_bitwarden_first_always`, `preference_github_standing_authorization`, `methodology_branch_pr_all_project_files`) to free 3 slots | 2 | S: 15 minutes, but the owner decides (it edits the store) | Only worth doing after F1 and F2 |

Suggested order: F1, then F3 (both small, both measurable), then F2, F5, F4, F6.

## Comparison with argus#1127 (recall logging)

argus#1127 is open and has no logging yet, so there is no recall data to compare. When it ships, the numbers to read are: events of kind `first-prompt list` versus `search hit` per session (does anyone search), and whether the needed memories from this table appear in `search hit` events for the same tasks. The issue notes only 372 of 1,447 memories carry a `Source session` line, which limits the "recalled in" trace.

## Appendix: hook replay (16 Nov 2026, about 22:50 AEDT)

Command: `echo '{"session_id":"audit-1142-replay-a"}' | node ~/.argus/argus-context-mcp-server/scripts/list-memories-first-prompt.mjs`, run in a scratch directory. The marker file it wrote was deleted afterwards. The live session hook printed the identical list.

```text
5 critical (always shown):
- methodology_branch_pr_all_project_files   [methodology, critical]  2026-10-17T11:12Z
- preference_bitwarden_first_always         [preference, critical]   2026-10-17T11:14Z
- preference_brrr_no_critical_without_permission                     2026-10-17T11:14Z
- preference_cortex_vault_conventions                                2026-10-17T11:14Z
- preference_github_standing_authorization                           2026-10-17T11:14Z

15 recent (newest first):
- pattern_check_pins_before_pruning_caches                           2026-10-20T00:39Z
- pattern_read_afk_charter_before_flagging_breach                    2026-10-20T00:39Z
- pattern_unpark_only_when_worker_not_in_owner_dialogue              2026-10-20T00:39Z
- decision_trustbut_orchestrator_skill_evaluated                     2026-10-19T20:03Z
- fact_homelab_repo_git_sync ... fact_aquila_direction_thread_live   2026-10-19T00:08Z to 20:02Z
```

Live store for comparison (`memory_list`, newest five by `updated_at`): `methodology_aquila_take_reads_handover_brief_file` (16 Nov 01:38 UTC), `preference_aquila_promotion_card_link_and_askuser` (15 Nov 22:50 UTC), `decision_repos_public_by_default_and_go_public_set` (15 Nov 19:51 UTC), `decision_ci_hosted_first_second_free_org` (15 Nov 19:47 UTC), `fact_ops_hub_e2e_refetch_delay_breaks_hub_test` (15 Nov 16:29 UTC).

Other facts used: `memory_search` is semantic (it returns a `similarity` field), not full text. `list-memories-first-prompt.mjs` caps at 20 rows (`TOTAL_CAP = 20`), takes every `critical`-tagged row first, then fills with `updated_at` order.
