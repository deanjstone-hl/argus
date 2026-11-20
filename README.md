# Argus

The platform monorepo for the Argus ecosystem: the `agent` CLI and agent-engine, watchtower, the
loop-state and T3-peer MCP servers, the shared libraries and the ecosystem manifest. Product
families are splitting out of it into `deanjstone-hl` (map: [argus-config/1134](https://github.com/deanjstone/argus-config/issues/1134));
`AGENTS.md` lists each split and where it went. Machine configuration
lives in [`argus-config`](https://github.com/deanjstone/argus-config) and
[`sys-admin`](https://github.com/deanjstone/sys-admin), not here.

Agent-facing instructions are in [`AGENTS.md`](AGENTS.md) (imported by `CLAUDE.md`). This file is
the human orientation.

## Layout

```
apps/        independently deployable or runnable units (services, Workers, CLIs, sites)
packages/    importable libraries, consumed via workspace:*, never deployed on their own
docs/        ADRs, architecture, specs, reference (see docs/README.md)
ecosystem/   manifest.json, the apps/projects/skills list the System Map draws
scripts/     CI (ci.sh), promotion (promote.sh), repo tooling and its tests
```

The `apps/` vs `packages/` rule is [ADR-010](docs/decisions/adr-010-monorepo-consolidation-and-layout.md).
Every package's role, and how it joined the repo, is the table at the top of
[`AGENTS.md`](AGENTS.md); per-package conventions are in
[`AGENTS.md`](AGENTS.md#package-conventions). Each package's own `README.md` covers how to run,
configure and deploy it, including its environment variable names.

## Prerequisites

- Node.js 22 or newer (`engines.node` is `>=22`).
- pnpm 12.13.0, pinned by `packageManager` in `package.json`. pnpm only: never npm or yarn.

## Setup and checks

```bash
pnpm install --frozen-lockfile   # root workspace
pnpm run typecheck
pnpm run lint
pnpm run build
pnpm run test                    # every root-workspace package
pnpm run test:scripts            # the repo-level tests under scripts/ (ci.sh adds --maxWorkers=1 outside GitHub Actions)
pnpm run docs:list               # every doc under docs/ with its summary and read_when
python3 scripts/check-deploy-concurrency.py   # every deploy-push workflow has a workflow-level concurrency block (needs PyYAML; also runs in test:scripts)
```

Every package is a member of the root workspace. A package that carries its own pnpm workspace
and lockfile would be listed in `nested_packages` in `scripts/ci.sh` and excluded in
`pnpm-workspace.yaml`; none does today.

`scripts/ci.sh` is the single definition of CI; the GitHub workflow calls it too. Every mode takes the host-wide heavy lock ([argus-config/1506](https://github.com/deanjstone/argus-config/issues/1506)): `scripts/ci.sh` re-runs itself through `scripts/heavy-lock.sh`, so only one full check runs at a time on a host, whichever thread, hook or CI job starts it, and it also waits while memory `some avg60` is 10 or more. A queued run prints `waiting for the host lock` and starts when the holder ends; it exits 75 without running once `HEAVY_LOCK_TIMEOUT` (3600 s) passes. `scripts/heavy-lock.sh` and `scripts/heavy-lock.lock` are vendored byte-for-byte from argus-config (its `scripts/sync-heavy-lock.sh` rewrites both; never edit them here), and `scripts/heavy-lock.test.ts` fails on a copy that no longer matches its lock.

```bash
git config core.hooksPath .githooks   # once per clone: pre-push runs scripts/ci.sh --changed
pnpm check                            # the local check: scripts/ci.sh --changed
scripts/ci.sh --changed               # only what differs from origin/main, plus dependents
scripts/ci.sh                         # everything: root workspace, then any nested package
```

Run `pnpm check` before every push (a PR branch, or `main` once the repo is trunk) and quote its
result in the PR's test plan or the ticket's Resolution. Every push to `main` runs CI in full: no
commit subject or committer skips it.

## Links come from the registry

Every myargus and tailnet URL in this repo is built from `links.json`, the registry vendored from
[`deanjstone/frontend`](https://github.com/deanjstone/frontend) (ADR-0004). Code uses the vendored
builders (`appUrl`, `routeUrl`, `apiUrl`, `mcpUrl`, `switcherApps`, `COOKIE_DOMAIN`) from
`apps/watchtower/src/lib/links.ts`, `apps/watchtower-collector/src/lib/links.ts` and
`apps/agent-engine/src/lib/links.ts`; scripts use `bash scripts/links.sh api watchtower-api`. A
backend's environment may override an origin, never a path, and nothing carries a host fallback.

```bash
bash scripts/link-check.sh        # bans host literals, checks wrangler/Vite/manifest config and registry drift
bash scripts/vendor-links.sh vX.Y.Z   # re-vendor the registry from a frontend tag, then commit the result
```

`link-check` blocks in CI (`.github/workflows/link-check.yml`). `.link-check-ignore` lists the
files it does not scan; the ecosystem manifest's app `href`s are checked against the registry by
`scripts/ecosystem/links.ts` instead. Never edit a vendored file: change the registry in `frontend`.

## Storing a secret

A value goes into Bitwarden Secrets Manager through a hidden prompt, never a chat, a `!` command or a
typed command line. Env variables name the key and project, so nothing is hardcoded:

```bash
BWS_SECRET_KEY=<key> BWS_SIBLING_KEY=<existing-key-in-the-same-project> bash scripts/bws-store-secret.sh
bash scripts/bws-store-secret.sh --dry-run   # same variables; says create or replace, changes nothing
```

`BWS_PROJECT_ID` replaces `BWS_SIBLING_KEY`; `SECRET_NOTE`, `SECRET_EXPIRES`, `SECRET_PREFIX` and
`BWS_TOKEN_FILE` are optional. Runbook: [`docs/runbooks/bws-store-secret.md`](docs/runbooks/bws-store-secret.md).

## Branches, PRs and releases

- Work on a branch in a worktree under `~/.t3/worktrees/argus/`; `~/repos/argus` is the deploy
  copy and is never edited. Open a PR to `main`; the owner's convention is a squash merge.
- Commits and PR titles are [Conventional Commits](CONTRIBUTING.md). Merging to `main` runs CI and
  deploys nothing and publishes no release. Versions are cut on promotion: the push to `deploy`
  runs `release.yml`, which first checks that the promotion carries a feat, fix, perf, revert
  or breaking change (`scripts/ci/release-needed.sh`), then vouches for the promoted SHA (it
  reuses `main`'s green full CI run of it, or runs the full gate when there is none) and then
  runs semantic-release (one version track per package). A promotion of only chore/docs/ci
  commits deploys, runs no test and cuts no version. The `ecosystem` release asset is
  published on the `deploy` push too (`ecosystem-release.yml`).
- The release scripts in `scripts/ci/` (`release-proof.sh`, plus `release-with-retry.sh`,
  `release-scripts-check.sh` and `release-scripts.lock`) are vendored from argus-config
  (`scripts/sync-release-scripts.sh`) and are synced, never edited here. `release.yml` passes
  this repo's differences to `release-proof.sh` as `RELEASE_PROOF_*` env, and the `Release
  scripts` CI job runs `release-scripts-check.sh` on every push and pull request, failing on a
  hand-edited copy. argus-config tests the script bodies.
- The PR template asks for a README line. A change to setup, commands, config, env or deploy
  must update the relevant README, or say in the PR why it needs none. The README guard check
  (`.github/workflows/readme-guard.yml`) enforces it.

## Deploying

Production deploys only from the `deploy` branch, fast-forwarded to a commit already on `main`.
Pushing `deploy` runs the per-target workflows in `.github/workflows/*-deploy*.yml` (Cloudflare
Workers and Pages, and `deploy.sh` on the homelab or WSL2 deploy runner).

This repository is public, so CI is hosted-first: every job in `ci.yml`, `release.yml` and the
Cloudflare deploys runs on `ubuntu-latest` and reads no secret but the read-only `GITHUB_TOKEN`
in any workflow a pull request starts. The only jobs on the owner's hosts (`[self-hosted,
homelab, deploy]` and `[self-hosted, wsl2-deploy]`) are in workflows that only a push to
`deploy` (or a dispatch, which needs write access) starts. `scripts/public-safe.test.ts` pins
this. See `docs/deploy-branch.md`, *Runners*, and `docs/public-cutover.md` for the fresh-history cutover
(`scripts/owner-steps/1207.sh`) and the private values, which live in Bitwarden Secrets Manager as
`ARGUS_<KEY>`.

- Promote: the owner approves the promotion card on the ops hub. Break-glass is
  `scripts/promote.sh --dry-run <sha>` then `scripts/promote.sh <sha>`; these are owner steps.
- Roll back: `git revert` on `main`, then promote the revert. Never force-push `deploy`.
- Every `apps/*/deploy.sh` and the `wrangler` scripts refuse to run unless the checkout is at
  `origin/deploy`.
- What deploys from where, replay, and the manual paths: [`docs/deploy-branch.md`](docs/deploy-branch.md).

## Docs

- [`docs/README.md`](docs/README.md): map of `docs/`.
- [`docs/decisions/`](docs/decisions/), indexed in [`docs/DECISIONS.md`](docs/DECISIONS.md): ADRs.
- [`docs/architecture/`](docs/architecture/): how the system fits together.
- [`ecosystem/README.md`](ecosystem/README.md): the ecosystem manifest and how it reaches the hub.
- [`CONTRIBUTING.md`](CONTRIBUTING.md): commit format and the versioning model.

Issues are on GitHub (`deanjstone/argus`) and are the only backlog; there is no `TODO.md`.
