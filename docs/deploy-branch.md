---
summary: "How argus deploys: production moves only when the owner promotes main to the deploy branch; what runs where, promote, roll back, manual paths"
read_when:
  - "deploying or promoting anything in argus"
  - "editing a deploy workflow, a deploy.sh or a package's deploy script"
  - "asking why a merge to main did not deploy"
---

# Deploying argus: the deploy branch

Production deploys only from the `deploy` branch. Merging to `main` builds and tests, but
deploys nothing, cuts no version and publishes no release or release asset (argus#1168). The owner moves `deploy` forward to a commit that
is already on `main`, and that push runs the production workflows. Model and decisions:
argus-config#504 (map), #506, #507, #508, #509, #519, #548. Pilot: myargus
(argus-config#510). Roll-out here: argus-config#600 (agent work) and #520 (owner steps).

## What deploys from where

| Event | Workflow | Result |
|---|---|---|
| push to `main` | `ci.yml` | build, test; no deploy |
| push to `main` touching `ecosystem/**`, weekly, or a dispatch | `ecosystem-skills.yml` | the ecosystem manifest's skill entries against the installed skills (needs `SKILLS_READ_TOKEN`, skips without it); never on a pull request |
| push to `deploy`, or a dispatch on `deploy` | `release.yml` | job `Test before release (main CI on this SHA)` first checks that something is releasable (`scripts/ci/release-needed.sh`) and reuses `main`'s green full CI run of the promoted SHA; job `Test before release (the full gate)` runs `scripts/ci.sh` only when there is no such run; job `Release` (`needs:` both) then runs semantic-release for every track. A promotion with nothing releasable runs no test and cuts no version. See *Versions* |
| push to `deploy` touching `ecosystem/manifest.json`, or a dispatch on `deploy` | `ecosystem-release.yml` | validates the manifest and replaces the `ecosystem.json` asset of the `ecosystem` release, which the ops hub fetches hourly (`ecosystem/README.md`) |
| push to `deploy` touching `apps/watchtower/**` or `packages/watchtower-contract/**` | `watchtower-deploy.yml` | Cloudflare Pages `watchtower` (the dashboard only) |
| push to `deploy` touching `apps/watchtower/**`, `packages/watchtower-contract/**` or `packages/bearer-auth/**`, or a dispatch on `deploy` | `watchtower-deploy-worker.yml` | dry-run, D1 migrations, then the `argus-watchtower-api` Worker |
| push to `deploy` touching `apps/loop-state-mcp/**`, or a dispatch on `deploy` | `loop-state-mcp-deploy.yml` | on the homelab runner: moves the deploy copy `~/repos/argus` to `origin/deploy`, runs `apps/loop-state-mcp/deploy.sh` from it (`.env` from BWS, build, restart `loop-state-mcp.service`), then reads `/healthz` and the unit's start time back. The unit runs from that copy, so the job's own checkout is never what gets built (argus#1051) |
| push to `deploy` touching `apps/watchtower-collector/**`, or a dispatch on `deploy` | `watchtower-collector-deploy.yml` | on the homelab runner: the same deploy-copy run of `apps/watchtower-collector/deploy.sh`, then the unit's start time and `dist/` read back |
| push to `deploy` touching `apps/agent-engine/**`, or a dispatch on `deploy` | `agent-engine-deploy.yml` | on the WSL2 deploy runner: `apps/agent-engine/deploy.sh` from `~/repos/argus` at `deploy` (build, sync to `~/.argus/agent-engine`, restart `agent-engine.service`), then `/health` and the unit's start time read back |
| push to `deploy` touching `apps/agent-cli/**`, or a dispatch on `deploy` | `agent-cli-deploy.yml` | on the WSL2 deploy runner: `apps/agent-cli/deploy.sh` (build, sync to `~/.argus/agent-cli`, shim), then the installed `dist/index.js` compared with the build |
| push to `deploy` touching `apps/watchtower-usage-shim/**`, `packages/bearer-auth/**` or `packages/watchtower-contract/**`, or a dispatch on `deploy` | `watchtower-usage-shim-deploy.yml` | on the WSL2 deploy runner: `deploy.sh` (`.env` from BWS, build, restart `watchtower-usage-shim.service`), then the unit's start time read back |
| push to `deploy` touching `apps/t3-peer-mcp/**`, or a dispatch on `deploy` | `t3-peer-mcp-wsl2-deploy.yml` | on the WSL2 deploy runner: `deploy.sh` installs the WSL2 half (`t3-peer-mcp-deploy.yml` installs the homelab half) |

### Runners

This repository is public (argus#1207), so a fork's pull request can start any workflow that has a
`pull_request` trigger. Every job runs on `ubuntu-latest` except the ones that run `deploy.sh` against a unit
on a host of the owner's. Those are in workflows that only a push to `deploy` (or a dispatch, which needs write
access) starts, never in `ci.yml` or any workflow with a `pull_request` trigger: `[self-hosted, homelab, deploy]`
for the homelab units and `[self-hosted, wsl2-deploy]` for the WSL2 ones. The pull request dry run of
the three homelab units is `deploy-dry-run.yml`, hosted. There is no `CI_RUNS_ON` variable. `scripts/public-safe.test.ts`
pins the rules and `scripts/deploy-branch.test.ts` pins the lists.

### WSL2 targets

The four WSL2 workflows run on the `wsl2-deploy` self-hosted runner, a `systemd --user` unit on the
owner's laptop (argus-config `docs/runbooks/wsl2-deploy-runner.md`, argus#1025). Each moves the
deploy copy `~/repos/argus` to `origin/deploy`, installs the target's dependencies there and runs
the target's own `deploy.sh`; the copy is where the units run from, and it rests detached at `origin/deploy` afterwards (see *Gotchas*). Rules:

- **Asleep means queued.** The runner is online only while the laptop is awake. An approval given
  while it sleeps deploys when it wakes (GitHub fails a job that waits about 24 hours). Check the
  Actions tab, not the card, before assuming a target is live. A second promotion that arrives while
  one is queued replaces the pending run of the same target; the survivor deploys the head of
  `deploy` either way.
- **No pull request job.** The runner is the owner's machine, so no PR can run on it. The only
  checks before the first run are `scripts/deploy-branch.test.ts` and the target's own tests.
- **Deploy-time env files live outside the deploy copy.** Every one follows the same rule,
  `~/.config/argus/<app>.env`, so an agent can fix it
  ([argus-config#1267](https://github.com/deanjstone/argus-config/issues/1267)); helper `scripts/lib/app-env.sh`.

`scripts/deploy-branch.test.ts` fails when a new `apps/*/wrangler.jsonc` has neither a deploy workflow nor a named reason.

Path filters apply to the range a push brings. Creating `deploy` at a commit already on
`main` may start no path-filtered workflow [speculation: GitHub does not document the
filter for a new branch that brings no new commits]. That is harmless while production
already matches `main`; run the workflow's last `main` run as the check.

## Versions

A version is cut when the owner promotes, never by a merge to `main` (argus#1066,
argus-config#1048, #1167). `release.yml` runs on every push to `deploy` (and a dispatch,
refused unless the ref is `deploy`; a dispatch is an owner step, as it cuts a real version)
as three jobs:

1. `Test before release (main CI on this SHA)` (job `gate`) first asks whether anything
   would ship (argus#1168). `scripts/ci/release-needed.sh` reads git from the last root
   `v<X.Y.Z>` tag to the promoted SHA and says `release=true` for a `feat`, `fix`, `perf` or
   `revert` subject or a `BREAKING CHANGE`, the commits semantic-release publishes, and for a
   missing tag or any git error (a skipped release is the failure to avoid). With nothing
   releasable the other two jobs skip: no test, no version. The root tag is the anchor because
   the release step tags the root last and stops at the first failure, so a half-failed run
   leaves it where it was and a retry sees the same range. Then it vouches for the promoted
   SHA, which is already on `main` (argus#1120). `scripts/ci/release-proof.sh` (vendored from
   argus-config and synced, never edited; `release.yml` sets `RELEASE_PROOF_WORKFLOW=CI`,
   `RELEASE_PROOF_EVENTS=push` and the required jobs, and the `Release scripts` CI job fails a
   hand-edited copy) reuses `main`'s
   result when a push run of `CI` on that SHA ran the whole gate and passed: its `Build` job
   and one `Build (<package>)` job for every nested package, all `success`. A `main` run on
   the SHA that is red fails the job, so a red SHA never releases. A pull_request run, a
   scoped run (Changes started only the touched packages), a run whose Build job skipped, a
   running or a cancelled one prove nothing: with no full green run (or on any API error)
   the next job runs the full gate. Most pushes to `main` are scoped, so the reuse applies
   when the promoted SHA's own push ran in full (a change to `scripts/ci.sh`, `ci.yml` or
   `.github/actions/`).
2. `Test before release (the full gate)` (job `test`) runs only when the gate found
   something releasable and no full green `main` run: `scripts/ci.sh` (root workspace, repo
   scripts and every nested package).
3. `Release` `needs:` both, so a red test means no version. It runs after a passing `test`, or
   after the gate when `main`'s green run was reused. It checks out `deploy`, skips itself
   if `deploy` has moved past the tested SHA (the run for the newer push releases it), then
   runs semantic-release once per track: each package under `apps/` and `packages/` with a
   `.releaserc.json` (tag `@argus/<name>-v<X.Y.Z>`, commits touching that package only), then
   the root (`v<X.Y.Z>`, any commit).

Rules:

- **A promotion of only `chore`/`docs`/`ci`/`refactor`/`test` commits deploys and cuts no
  version.** The gate finds nothing releasable and the test and release jobs skip, so no test
  runs either. No job filters on the push's commit list: a push event lists 20 commits at most
  and a promotion can ship more.
- **Nothing is committed back.** `deploy` is fast-forwarded from `main`, so a commit made on it
  would fork the branches. Every `.releaserc.json` keeps only commit-analyzer,
  release-notes-generator and github; the git, changelog and npm plugins are gone. The GitHub
  Release notes are the changelog from here on. Each package's `CHANGELOG.md` and
  `package.json` `version` stay at their last released value and no longer track the tag.
- **No `workflow_run`.** On `workflow_run` GitHub sets `GITHUB_REF` to the default branch, so
  semantic-release would see `main` and silently dry-run (design-system#190). The test gate
  runs in the same workflow instead.
- **One release at a time**, group `release`, never cancelled. A tag made with `GITHUB_TOKEN`
  starts no other workflow.
- **Retry a failed run** with `gh workflow run release.yml -R deanjstone/argus --ref deploy`
  (owner step); the next promotion tags only what is new since the last tag.
- Tags made before argus#1066 point at `chore(release):` commits on `main`; they are reachable
  from `deploy` once it passes them, so the first promotion continues from `v3.27.2`.

## See what is merged but not deployed

```bash
git fetch origin && git log --oneline origin/deploy..origin/main
```

## Promote

Run it from a T3 **approval-required** thread or a terminal. The deploy gate asks for live
approval there and denies it in every other permission mode (argus-config#548).

```bash
scripts/promote.sh --dry-run <sha>   # what would ship, and the exact push
scripts/promote.sh <sha>             # git push origin <sha>:refs/heads/deploy
gh run list --branch deploy --limit 5
```

`<sha>` is any commit on `origin/main`, not only a release tag. `scripts/promote.sh main`
promotes the tip. The push is fast-forward only: the script refuses a SHA that is not on
`main` or that would move `deploy` backwards.

### A commit carrying the skip-CI marker cannot be promoted

Until argus#1066 the release bot appended the skip-CI marker to its `chore(release):` commit
on `main`; those commits stay in history, and the rule below still covers them (and any commit
that carries the marker). GitHub
runs no push-triggered workflow when the head commit of a push carries the marker (a
bracketed `skip ci`, `ci skip`, `no ci`, `skip actions` or `actions skip` anywhere in the
message, or a `skip-checks: true` trailer), so a push of `deploy` to that commit moves the
branch and deploys nothing (argus-config#1060). Before argus#1066 the newest SHA on `main` was
usually such a release commit.

- `scripts/promote.sh` refuses such a target, on a dry run too, and prints the nearest
  first-parent ancestor without the marker as the command to run. It never ships that SHA on
  its own: the deploy gate approves the literal command it was shown. When nothing
  deployable lies ahead of `deploy`, it says so and suggests nothing.
- The ops hub card never targets such a commit. It steps back to the newest earlier
  candidate without the marker, for a flagged SHA too (the flag stays on the card), and the
  owner approves the SHA the card shows. When every commit ahead of `deploy` carries the
  marker, the target is empty and the guard says `skip-marker` until the next commit lands.
  Approve checks the message again live, which covers a repo with no `deploy` branch yet.

Only the head commit of the push counts: a marker deeper in the range is harmless.

### Replay a promotion that ran no workflow

Every workflow in the table above that deploys on a push to `deploy` also takes a
`workflow_dispatch`, and refuses to deploy from any other ref. Path filters plan from the
push's own range, so a skipped push is never picked up by the next one. A dispatch redeploys
that target at the head of `deploy`, and the owner picks which targets to replay: those
whose `paths:` match the files the skipped range changed. A dispatch is a deploy, so it
needs the same live approval as a promotion, and an agent never runs one.

```bash
gh workflow run <workflow-file> -R deanjstone/argus --ref deploy
```

The workflow file must already exist on `deploy`, so a new workflow can be dispatched only
after a promotion has carried it there; that promotion deploys the target on its own.

## Roll back

A rollback is a deploy, and it never force-pushes `deploy`:

1. `git revert <bad-sha>` on a branch, open a PR, merge it to `main`.
2. `scripts/promote.sh <the revert's SHA on main>`.

## Manual paths

Every manual production path refuses to run unless the checkout's `HEAD` is `origin/deploy`
with no uncommitted changes to tracked files (argus-config#519). The check is
`scripts/require-deploy-checkout.sh`; it asks origin directly and fails closed.

The guard also takes one per-host deploy lock (argus-config#1156), `~/.cache/argus-deploy.lock`,
shared with every repo's guard, before its checks. Two deploys on a host never run together:
the homelab runner can take two jobs at once, each `deploy`-push workflow has its own
`concurrency` group, and the workflows share the one deploy copy `~/repos/argus`. A
break-glass `deploy.sh` is covered too. A holder keeps the lock until the guard's parent (the
`deploy.sh` or the shell running a `pnpm run deploy` chain) exits; a second guard call under
the same parent goes through. It waits `ARGUS_DEPLOY_LOCK_WAIT` seconds (default 3600), then
refuses with exit 1 naming the holder. `ARGUS_DEPLOY_LOCK_MAX_HOLD` (7200) caps a holder,
`ARGUS_DEPLOY_LOCK_FILE` moves the file, `ARGUS_DEPLOY_LOCK=off` skips it. The lock starts
at the guard, so a workflow's earlier step that moves the deploy copy (`git switch --detach
origin/deploy`) is not inside it. Tests: `scripts/deploy-lock.test.ts`.

```bash
git fetch origin deploy && git switch --detach origin/deploy
apps/agent-engine/deploy.sh homelab
```

| Path | Guard |
|---|---|
| `apps/*/deploy.sh` (agent-cli, agent-engine, loop-state-mcp, t3-peer-mcp, watchtower-collector, watchtower-usage-shim) | calls the checkout guard first |
| `pnpm run worker:deploy` in watchtower | `bash ../../scripts/require-deploy-checkout.sh && …` |

The memory MCP server, with its Worker, stdio release and `argus-context-fetch-install` timer, moved to
[`deanjstone/memory-mcp`](https://github.com/deanjstone/memory-mcp) ([#1071](https://github.com/deanjstone/argus/issues/1071)),
which deploys from its own `deploy` branch; argus holds no workflow or script for it. The shared inbox
(`argus-email` Worker, `mail.myargus.cc`) did the same: it moved to
[`deanjstone/email`](https://github.com/deanjstone/email) ([#1073](https://github.com/deanjstone/argus/issues/1073)),
which deploys from its own `deploy` branch, and `apps/email` and its workflow were removed from argus
([#1173](https://github.com/deanjstone/argus/issues/1173)).

A package that ships a raw `wrangler deploy` outside its `package.json` script is not
covered by the script; the deploy gate hook still holds it for live approval.

`./deploy.sh verify`-style read-only checks are not production changes and are not guarded.

## Tests

`scripts/deploy-branch.test.ts` covers `promote.sh`, the guard, and the wiring: every
`deploy.sh`, every wrangler or remote-migration script and the workflow triggers. Each
`deploy.sh` that has its own suite also has the fixture
`scripts/test-support/make-deploy-checkout.sh`, which makes a scratch directory a checkout
at `origin/deploy`.

## Gotchas

- **A push made with `GITHUB_TOKEN` triggers no other workflow.** A workflow that moved
  `deploy` would move the branch and deploy nothing. Promotion is a local push with the
  owner's own credentials; `promote.sh` refuses to run inside GitHub Actions.
- **Never squash-merge `main` into `deploy`.** It would fork the branches. Promotion is a
  fast-forward push only.
- **`watchtower-deploy-worker.yml` runs `pnpm exec wrangler deploy`, not
  `pnpm run worker:deploy`,** for the same reason, after a dry-run and the D1 migrations (with
  `CLOUDFLARE_D1_TOKEN`). The owner decided on 31 Oct 2026 that the Worker deploys on promote
  (argus#983); the first run ships everything merged to `apps/watchtower` since the last
  manual `worker:deploy`.
- **Between merging the retargeted workflows and the first promotion, nothing deploys.**
  Create `deploy` straight after merging that change.
- **`~/repos/argus` stays on `main`, so a manual deploy from it is refused.** Deploy from a
  detached worktree at `origin/deploy`:
  `git -C ~/repos/argus worktree add --detach ~/.t3/worktrees/argus/deploy origin/deploy`
  (then `git -C ~/.t3/worktrees/argus/deploy checkout --detach origin/deploy` after each
  promotion). Homelab's
  `repo-git-sync` tracking `deploy` for argus (argus-config#507) is separate work.
