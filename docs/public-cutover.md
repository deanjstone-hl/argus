---
summary: "How argus became a public repository with one squashed commit: why, the rules the guard test pins, the private values and their Secrets Manager keys, and the cutover owner step"
read_when:
  - "editing a workflow, a deploy.sh, a fixture or a doc and the scrub scan or scripts/public-safe.test.ts fails"
  - "adding a private value (an address, a Cloudflare id, a token) to a script or a test"
  - "running or reading scripts/owner-steps/1207.sh"
  - "asking why old issue numbers or SHAs of argus no longer resolve"
---

# Public cutover

argus goes from a private repository with about 2,500 commits to a **public repository with one
squashed commit** (argus#1207, map homelab#478, owner decision homelab#465, 16 Nov 2026). The earlier
history stays private in `deanjstone/argus-archive`, which also keeps every old issue and pull
request, the releases and the tags. The models are `deanjstone/skills` (skills#27) and
`deanjstone/sys-admin` (sys-admin#194, run live on 16 Nov 2026).

## Why a fresh history, not a rewrite

The audit (homelab#464) found 93 tailnet addresses, 72 tailnet names, 7 Cloudflare ids, 4 LAN
addresses, third-party-authored commits and scraped posts in the history. GitHub, on removing
sensitive data from a repository: "Rewriting history will change the hashes of the commits that
introduced the sensitive data", and if you only rewrite and force push, "the commits with
sensitive data may still be accessible elsewhere": "Directly via their SHA-1 hashes in cached
views on GitHub", "In any clones or forks of your repository" and "Through any pull requests that
reference them"
([Removing sensitive data from a repository](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/removing-sensitive-data-from-a-repository)).
The first step there is to "revoke and/or rotate that secret". None of the values found is a
credential: a tailnet address is unroutable outside the tailnet and a Cloudflare id is not a
token, so the exposure is the shape of the network and the account, not access. A new repository
has no old commits to reach by SHA, and no open pull request to carry them.

## What a public repository changes

([Setting repository visibility](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/managing-repository-settings/setting-repository-visibility))
"The code will be visible to everyone who can visit GitHub.com." "Anyone can fork your
repository." "Actions history and logs will be visible to everyone." "Stars and watchers for
this repository will be erased." "All push rulesets will be disabled." "The repository will
automatically gain access to GitHub Advanced Security features." The page says nothing about
transferring issues; skills#27 found that GitHub refuses a transfer from a private to a public
repository, so the script makes the new repository public last.

Forks ([About forks](https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/working-with-forks/about-forks)):
"A fork's visibility depends on the upstream repository." "Public repository forks are public."

Fork pull requests ([Managing GitHub Actions settings](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/enabling-features-for-your-repository/managing-github-actions-settings-for-a-repository)):
"By default, all first-time contributors require approval to run workflows." The strictest
policy is "Require approval for all external contributors", which the script sets
(`all_external_contributors`). "Workflows from forks do not have access to sensitive data such
as secrets." But "If you are using self-hosted runners, potentially malicious user-controlled
workflow code will execute automatically", and `pull_request_target` runs "regardless of
approval settings". Hence the rules below.

## The rules the guard test pins

`scripts/public-safe.test.ts`:

1. Every job runs on `ubuntu-latest`. The only other runners allowed are
   `[self-hosted, homelab, deploy]` and `[self-hosted, wsl2-deploy]`, and only in a workflow
   whose triggers are a push to `deploy` and `workflow_dispatch` (which needs write access),
   in a job whose `if:` refuses any ref but `refs/heads/deploy`. Those are the nine `*-deploy.yml`
   workflows that run `deploy.sh` against a unit on a host. The pull request dry run of the three
   homelab units is `deploy-dry-run.yml`, hosted. `ci.yml`, `release.yml`, the two Cloudflare
   deploys and `ecosystem-release.yml` are hosted.
2. No `pull_request_target`; no `CI_RUNS_ON` or `runner.environment`; no action or workflow from
   a repository of the owner; no `BWS_ACCESS_TOKEN`.
3. A workflow a pull request starts reads no secret but `GITHUB_TOKEN` and has top-level
   `permissions: contents: read`. `ecosystem-skills.yml` reads `SKILLS_READ_TOKEN` and so has no
   `pull_request` trigger; `brrr-notify` is gone.
4. The tree has no private value (`scripts/scrub-scan.sh`: gitleaks' default rules plus rules for
   tailnet addresses and names, LAN addresses, email addresses, AU mobile numbers, Cloudflare
   ids and Access team domains). A failing scan prints the rule and the place, never the value.
   CI installs a pinned gitleaks (8.30.1, checked against its published sha256).

The runbook `wsl2-deploy-runner.md` in argus-config says a public repository may *never* use the
`wsl2-deploy` label. Rule 1 is why this repository does anyway: a fork cannot start those jobs.
That line of the runbook is the owner's to decide and is not changed here.

## Placeholders

Test fixtures and docs use values that identify nothing, and `.gitleaks.toml` allows exactly
these: a tailnet address `100.64.0.1` to `100.64.0.20`, the tailnet name `tailnet-example.ts.net`,
the Access team `team.cloudflareaccess.com`, a UUID that starts `00000000-0000-`, a hex id with a
run of 16 zeros, `git@github.com` and systemd instances (`postgres@15-main.service`).

## Private values

Five values moved to Bitwarden Secrets Manager under the key names in
`apps/watchtower-collector/.env.example`: `ARGUS_TAILSCALE_IP_HOMELAB`, `ARGUS_TAILSCALE_IP_WSL2`,
`ARGUS_CLOUDFLARE_ACCOUNT_ID`, `ARGUS_CLOUDFLARE_ZONE_ID` and `ARGUS_D1_WATCHTOWER_DATABASE_ID`.
`apps/watchtower-collector/deploy.sh` reads the first four, and the D1 id, by name;
`scripts/private-value.sh <KEY>` is the same lookup for other scripts (an environment variable
of that name wins). The Worker's `wrangler.jsonc` holds a placeholder D1 id and
`apps/watchtower/scripts/with-d1-id.sh <command>` puts the real one in for the command and
restores the file; the deploy workflow gets it from the Actions secret
`WATCHTOWER_D1_DATABASE_ID`. `scripts/owner-steps/1207.sh` creates the five keys from the last
old commit that held them (`688d5f049a4dcbd24f72b2bc5738700a99b695cb`).

## The cutover (owner step)

```bash
bash scripts/owner-steps/1207.sh --dry-run    # reads state, prints every action, changes nothing
bash scripts/owner-steps/1207.sh              # the live run: its own approval
```

Run it on WSL2 from a clean checkout of `main` equal to `origin/main`, in a quiet window (no
promotion in flight, the orchestrator loops frozen). Before the live run, store the four Actions
secret values GitHub cannot return in Secrets Manager (`ARGUS_CLOUDFLARE_API_TOKEN`,
`ARGUS_CLOUDFLARE_D1_TOKEN`, `ARGUS_VITE_SUPABASE_URL`, `ARGUS_VITE_SUPABASE_ANON_KEY`; the dry
run lists what is missing). In order, each step checking state first, so a stopped run can run
again:

1. rename `argus` to `argus-archive` (stays private);
2. create the five BWS keys (the project of `watchtower-collector-token`);
3. create `argus` as a private repository with one squashed commit of the scrubbed tree;
4. clone the labels; set the Actions secrets the workflows read from BWS; copy the Actions
   variables that pass the scrub scan (`CI_RUNS_ON` is dropped, `BRRR_WEBHOOK_SECRET` is dropped);
5. transfer the open issues, except the cutover's own (`1207`);
6. scan the transferred issues' text; a finding stops the run before step 7 (exit 3);
7. make `argus` public and set the fork approval policy to all external contributors;
8. print the wiring (see below).

It never pushes `deploy`, never runs `promote.sh` and starts no workflow. After it, the owner's
Approve on the ops-hub card creates `deploy` in the new repository.

## Wiring it prints (nothing is automatic)

- **Hub:** `deanjstone/argus` is already in `apps/ops-hub/promotion-repos.txt`
  (`OPS_HUB_PROMOTION_REPOS`) and the name does not change; the hub's GitHub App must be able to
  reach the new repository id.
- **Homelab runners:** the JIT dispatcher's enrolment names the repo, so it needs no edit; its
  fine-grained token must select the new repository.
- **WSL2 deploy runner:** `LNV-LGN5-wsl2-deploy` follows the rename to `argus-archive`; remove it
  there and register it on the new repository (`scripts/install-wsl2-deploy-runner.sh`, argus-config).
- **Deploy copies:** `~/repos/argus` on both hosts runs live units. Do not move it: its `origin`
  now points at the new repository and the deploy workflows switch it to the new `origin/deploy`.
- **Other repositories** pin `deanjstone/argus/.github/actions/host-pnpm@<old SHA>`: repoint them.
- **Issue numbers restart;** references to `argus#N` elsewhere now mean the new repository
  (the rewrite rules of argus-config#1064).
- **First push:** the vendored README guard fails on the root commit (a root commit has no
  `HEAD^1`, exit 128). Known, argus-config#1440; not a regression.
- **Versions:** tags stay in the archive; the first `feat` or `fix` of an app releases it as 1.0.0.
