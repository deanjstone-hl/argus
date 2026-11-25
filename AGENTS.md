# Argus

The platform monorepo for the Argus ecosystem ([ADR-010](docs/decisions/adr-010-monorepo-consolidation-and-layout.md)).
It no longer takes new product work by default: the product families are splitting out of it into
`deanjstone-hl`, one repo each, mapped in
[argus-config/1134](https://github.com/deanjstone/argus-config/issues/1134). The split tickets are
[#1069](https://github.com/deanjstone/argus/issues/1069) (x-mcp),
[#1070](https://github.com/deanjstone/argus/issues/1070) (wiki),
[#1071](https://github.com/deanjstone/argus/issues/1071) (memory-mcp),
[#1073](https://github.com/deanjstone/argus/issues/1073) (email) and
[#1075](https://github.com/deanjstone/argus/issues/1075) (ops-hub);
[#1072](https://github.com/deanjstone/argus/issues/1072) (watchtower) was withdrawn, since watchtower
folds into the ops hub ([#1165](https://github.com/deanjstone/argus/issues/1165)), and
[#1074](https://github.com/deanjstone/argus/issues/1074) (vault-agent) ended in retirement
([#1125](https://github.com/deanjstone/argus/issues/1125)). The package table below says where each
package went. The wiki and x-mcp trees were removed by
[#1096](https://github.com/deanjstone/argus/issues/1096) and
[#1095](https://github.com/deanjstone/argus/issues/1095). Check a product's own repo before
adding work here.

What this repo holds today: the `agent` CLI and agent-engine, watchtower (dashboard, collector,
usage shim) until it folds into the ops hub, the loop-state and T3-peer MCP servers, the shared
libraries, and the ecosystem manifest (`ecosystem/`). Machine configuration stays in
`argus-config` and `sys-admin`.

For the default orchestrator workspace, see `~/.argus/workspace/` (the retired `~/agent-cli` path no longer exists).
For Claude Code config (skills, hooks, settings), see `~/repos/argus-config/`.
For machine setup and sysadmin scripts, see `~/repos/sys-admin/`.

## Packages

| Package | Path | Role |
|---|---|---|
| agent | `apps/agent-cli/` | `agent` CLI — agent-engine client, `query`, `doctor` |
| agent-engine | `apps/agent-engine/` | HTTP server (port 3747) — chat, vector search, context API |
| watchtower | `apps/watchtower/` | Infra dashboard — React/Vite web UI, deployed via Cloudflare Pages; subtree-merged, flat (no nested workspace) |
| watchtower-collector | `apps/watchtower-collector/` | Standalone Node service polling infra/usage sources for watchtower; own systemd unit |
| watchtower-usage-shim | `apps/watchtower-usage-shim/` | Standalone Node service exposing AI usage stats for watchtower's collector |
| ops-hub | `apps/ops-hub/` | **Moved to [`deanjstone-hl/ops-hub`](https://github.com/deanjstone-hl/ops-hub) ([#1075](https://github.com/deanjstone/argus/issues/1075)); removed from argus by [#1158](https://github.com/deanjstone/argus/issues/1158).** The Argus ops hub server — one Node/Hono process and one SQLite database on homelab (`ops.myargus.cc` behind Cloudflare Access), serving the notice board, the GitHub cache and the promotion cards; it fetches `ecosystem/manifest.json` (published as the `ecosystem` release asset) hourly. Runs on homelab from `~/repos/ops-hub` as `ops-hub.service`. The manifest and its checks stay here (`ecosystem/`, `scripts/ecosystem/`) |
| ops-hub-web | `apps/ops-hub-web/` | **Moved to [`deanjstone-hl/ops-hub`](https://github.com/deanjstone-hl/ops-hub) ([#1075](https://github.com/deanjstone/argus/issues/1075)); removed from argus by [#1158](https://github.com/deanjstone/argus/issues/1158).** Ops hub PWA, served by the hub and built from the design-system registry |
| loop-state-mcp | `apps/loop-state-mcp/` | Loop-state MCP for the two orchestrator threads (AFK loop + Aquila) — slots, loop status and the quiet-tick gate in one SQLite db behind typed tools, with the caller's role (afk / direction / worker) taken from its bearer token; Hono + stateless Streamable HTTP; flat. Deployed on homelab by its `deploy.sh` and `systemd/` unit, registered on WSL2 by argus-config's `register_loop_state_mcp` ([argus-config#669](https://github.com/deanjstone/argus-config/issues/669)); not live until [argus-config#670](https://github.com/deanjstone/argus-config/issues/670); no `.releaserc.json` or `release.yml` entry yet |
| memory-mcp | `apps/memory-mcp/` | **Moved to [`deanjstone/memory-mcp`](https://github.com/deanjstone/memory-mcp) ([#1071](https://github.com/deanjstone/argus/issues/1071)); removed from argus by [#1159](https://github.com/deanjstone/argus/issues/1159).** Cloud-backed MCP memory server for the `~/CONTEXT` vault (`claude-memory` tools) — stdio (Claude Code local) + Cloudflare Workers HTTP (`memory.myargus.cc`, Worker `argus-memory-mcp`) |
| wiki | `apps/wiki/` | **Moved to [`deanjstone/wiki`](https://github.com/deanjstone/wiki) ([#1070](https://github.com/deanjstone/argus/issues/1070)); removed from argus by [#1096](https://github.com/deanjstone/argus/issues/1096).** OpenWiki fork — headless codebase-doc generator agent (CLI) |
| vault-agent | `apps/vault-agent/` | **Retired and removed from argus by [#1125](https://github.com/deanjstone/argus/issues/1125)** (decision on [context/427](https://github.com/deanjstone/context/issues/427)); its history remains reachable in this repo's commit graph. Was an Obsidian plugin, a vendored snapshot of `pssah4/vault-operator` |
| vault-agent-relay | `apps/vault-agent-relay/` | **Retired and removed from argus by [#1125](https://github.com/deanjstone/argus/issues/1125).** Was the Cloudflare Worker + Durable Object relay (`argus-vault-agent-relay`, `vault.myargus.cc`); the live Worker, domain and secret are retired separately |
| x-mcp | `apps/x-mcp/` | **Moved to [`deanjstone/x-mcp`](https://github.com/deanjstone/x-mcp) ([#1069](https://github.com/deanjstone/argus/issues/1069)); removed from argus by [#1095](https://github.com/deanjstone/argus/issues/1095).** Read-only X/Twitter MCP server, runs on the homelab only (WSL2 and Windows reach it over `ssh homelab`) — reads the agent account's bookmarks for the CONTEXT ingest pipeline |
| t3-peer-mcp | `apps/t3-peer-mcp/` | MCP server letting one T3 Code environment see, message and control threads on the other's T3 server (WSL2 ↔ homelab), over an SSH tunnel with a short-lived session minted on the peer; stdio, deployed per machine by its `deploy.sh`, registered by argus-config's `register_t3_peer_mcp`; flat. No `.releaserc.json` or `release.yml` entry yet |
| email | `apps/email/` | **Moved to [`deanjstone/email`](https://github.com/deanjstone/email) ([#1073](https://github.com/deanjstone/argus/issues/1073)); removed from argus by [#1173](https://github.com/deanjstone/argus/issues/1173).** Argus shared inbox on one Cloudflare Worker — web UI, threading, compose/reply, search, Web Push and an MCP server at `/mcp` with OAuth plus `aest_` service tokens for headless agents (Worker `argus-email`, live at `mail.myargus.cc` behind Cloudflare Access); vendored snapshot of `wong2/cf-mailroom`, self-contained nested pnpm workspace. Replaces `email-worker` and `email-mcp` ([#518](https://github.com/deanjstone/argus/issues/518)) |
| bearer-auth | `packages/bearer-auth/` | Fail-closed, constant-time inbound bearer check (`checkBearer`, `timingSafeEqual`) used by `watchtower`'s `POST /checks`, and `watchtower-usage-shim`; plain JS plus a hand-written `.d.ts` because the shim runs compiled Node; flat |
| watchtower-contract | `packages/watchtower-contract/` | Watchtower check contract — `HealthStatus`, the `POST /checks` payload and its `parseCheckInput` validation, the `GET /checks` row and the specially-rendered detail shapes, shared by `watchtower` (UI and Worker) and `watchtower-collector`; source-only (no build step), flat |

### Placement — `apps/` vs `packages/`

Decided in [ADR-010](docs/decisions/adr-010-monorepo-consolidation-and-layout.md):

- **`apps/*`** — an independently deployable or runnable unit: a systemd service, a Cloudflare
  Worker, a CLI binary, a deployed site. If it can be started, deployed, or invoked on its own,
  it is an app.
- **`packages/*`** — an importable library, consumed by other workspace members via the
  `workspace:*` protocol, never deployed on its own.

A package directory is named for its **domain**, not its mechanism; agent tool surfaces take a
`<domain>-mcp` suffix (`memory-mcp`, `loop-state-mcp`). The nested-workspace question below is
orthogonal — it decides root-workspace exclusion, not which top-level directory a package
lives in.

### Package conventions

Every member of `apps/*` and `packages/*` follows these. New packages start compliant; existing
drift is fixed opportunistically.

| Convention | Rule |
|---|---|
| Tests location | `test/` for a standalone suite, or `*.test.ts` co-located beside the module. Never `tests/`. Where one package needs both a Node and a workers-pool suite, split them as `test/node/` and `test/workers/` — not `test/` versus `tests/`. |
| Test runner | `vitest`, invoked as `"test": "vitest run"`. Never `node:test`/`tsx --test`, and never two runners chained in one script. |
| Deploy entrypoint | `./deploy.sh` at package root. A package deployed by a GitHub workflow or by `wrangler deploy` alone ships no stub script and documents the real path in its README instead. |
| README | `README.md` at package root: what it is, how to run it, how it deploys |
| package.json | `name` (`@argus/*`), `description`, explicit `type` (`module` unless the package genuinely compiles to CommonJS), `engines.node: ">=22"` |
| systemd units | A package that runs as a service keeps its unit files in `systemd/` at package root (`apps/agent-engine/systemd/`, `apps/loop-state-mcp/systemd/`), installed by its own `deploy.sh` or installer. Units are never duplicated into argus-config or homelab — those repos hold units only for services whose source they own ([argus-config#338](https://github.com/deanjstone/argus-config/issues/338) decision 7b, [#418](https://github.com/deanjstone/argus/issues/418)). |
| Lockfile | Root lockfile only, unless the package carries its own nested pnpm workspace (see below) |

A nested-workspace root that holds members (as `apps/memory-mcp/package.json` did) is a container,
not a runtime package — `type` and a test runner don't apply to it; its members follow the table.

### Subtree-merged packages

`code-relay` was the first package folded in via `git subtree add` (full history preserved, part of the [argus-infra consolidation](https://github.com/deanjstone/argus/issues/163)). It was removed in [#450](https://github.com/deanjstone/argus/issues/450) after ArgusDE superseded it; its full subtree-merged history remains reachable in this repo's commit graph. It brought its own internal `apps/`+`packages/` layout and `pnpm-workspace.yaml`, which established the **nested-exclusion pattern** used below: a single-level workspace glob can't reach a *nested* workspace's members, so such a package is excluded from the root `pnpm-workspace.yaml` and stays a self-contained unit with its own lockfile, install, CI matrix entry (`nested` job in `.github/workflows/ci.yml`) and release-track install step in `release.yml`.

The **flat pattern** is the counterpart to the nested exclusion: a subtree-merged package with no nested workspace of its own joins the root `apps/*` glob directly, laid out exactly like the natively-authored `agent-cli`/`agent-engine` — no exclusion, no separate lockfile, and no `.github/workflows/` of its own, because the root `ci.yml`/`release.yml` already cover it via `pnpm -r --if-present run <script>` plus one line in `release.yml`'s `flat` array. `packages/watchtower-contract` is the worked example among the natively authored libraries. `ccbot` was the original worked example here and was removed in [#382](https://github.com/deanjstone/argus/issues/382); its full subtree-merged history remains reachable in this repo's commit graph, so there is no separate archive to go looking for. Future subtree merges should check for a nested workspace first and pick whichever pattern fits — the nested-exclusion pattern (as `memory-mcp` and `wiki` did) if the source repo already has its own multi-package workspace, or the flat pattern if it's a single package.

`watchtower` was folded in via `git subtree add` (full history preserved) into a staging prefix, then split by piece with same-branch `git mv` into three flat `apps/*` members (`watchtower`, `watchtower-collector`, `watchtower-usage-shim`) — a third option distinct from both the nested-exclusion pattern and the single-flat-package pattern, chosen because watchtower's own nested pnpm workspace had no cross-piece `workspace:`-protocol references, so nothing was lost by dissolving it into three independent root-workspace members. Each gets its own release track; no dedicated CI job needed since all three are flat workspace members covered by the existing `pnpm -r --if-present run <script>` root scripts.

`memory-mcp` (then named `mcp-server`), `wiki`, and `vault-core` came from `argus-context`, a three-package pnpm monorepo of its own — not a straight move like the above, since its packages needed a real 3-way split. Rather than `git subtree add`-ing the whole `argus-context` repo into a staging prefix and `git mv`-splitting it (the watchtower approach), each package was split into its own clean history branch first with `git subtree split --prefix=packages/<pkg> -b split-<pkg>` run against a clone of `argus-context`, then each split branch was subtree-added individually: `git subtree add --prefix=apps/memory-mcp <split-branch>`, etc. This works cleanly here because `mcp-server` and `wiki` were themselves already `git subtree add`-ed into `argus-context` from their own prior standalone repos (`mcp-memory`, `argus-wiki`) with proper `git-subtree-*` trailers — `git subtree split` recognizes those trailers and walks straight through to each package's true origin history instead of inheriting the whole monorepo's commit set. The result: `apps/memory-mcp` carries exactly the 36 commits scoped to mcp-server (its `mcp-memory` origin plus argus-context-era fixes), `apps/wiki` carries exactly the 162 commits scoped to wiki (its `argus-wiki`/`openwiki`-fork origin plus argus-context-era fixes), and `packages/vault-core` carries its 1 scaffold commit — none of the three carry the other two's history or the monorepo's cross-cutting commits, confirmed via each merge commit's second-parent commit count matching its split branch exactly. `memory-mcp` and `wiki` each kept their own nested pnpm workspace + lockfile (the nested-exclusion pattern — `!apps/memory-mcp`, `!apps/wiki`); `vault-core` had no nested workspace of its own, so it joined the root `packages/*` glob directly (the flat pattern). It was a scaffolded shared-constants package that nothing ever imported, and it was deleted in [#708](https://github.com/deanjstone/argus/issues/708) on the owner's decision in [#455](https://github.com/deanjstone/argus/issues/455): its `02.MEMORY` constant went stale at the flat-layout cutover, memory-mcp resolves both layouts through its own `vaultPaths`, and wiring it in would have meant bundling or publishing it for the `fetch-install` runtime (a hand-written `package.json` in `deploy.sh`) for two constants. Its history remains reachable in this repo's commit graph. `wiki` has since moved to [`deanjstone/wiki`](https://github.com/deanjstone/wiki) ([#1070](https://github.com/deanjstone/argus/issues/1070)) and was removed from this tree by [#1096](https://github.com/deanjstone/argus/issues/1096); its subtree-split history remains reachable in this repo's commit graph. `memory-mcp` moved to [`deanjstone/memory-mcp`](https://github.com/deanjstone/memory-mcp) ([#1071](https://github.com/deanjstone/argus/issues/1071)) and was removed by [#1159](https://github.com/deanjstone/argus/issues/1159), likewise with its history in this graph.

`vault-agent` was the **fourth** pattern, and the first with no upstream history at all: a **vendored snapshot** of `pssah4/vault-operator`, copied in as a single commit with no `git-subtree-*` trailer, because there was no plan to pull from or push back to upstream. It was excluded from the root workspace **empirically**, not structurally: adding it made `pnpm install` re-resolve peers for unrelated members (`watchtower`'s `@cloudflare/vitest-pool-workers` lost its `vite@6`-bound `vitest` and its typecheck failed on a `vite@8` `Plugin` type), because its dependency set (onnxruntime, sharp, the Claude Agent SDK) is large enough to move the shared peer graph. Use the vendored-snapshot pattern when taking third-party code you intend to diverge from; use subtree when you intend to stay in step with an upstream. And check a sibling's typecheck after adding any large package to the root workspace: the failure surfaces in a package you did not touch. vault-agent and its relay were retired and removed by [#1125](https://github.com/deanjstone/argus/issues/1125); the history remains reachable in this repo's commit graph.

`x-mcp` was the second vendored snapshot (`Barresider/x-mcp`, MIT, taken with no `git-subtree-*` trailer for the same reason as vault-agent). It showed the exclusion question being *measured* rather than assumed: its dependency set looked as heavy as vault-agent's (Playwright, a stealth plugin, Express), but adding it to the root workspace changed `pnpm-lock.yaml` additively only and `apps/watchtower`'s typecheck still passed, so it joined the root `apps/*` glob flat. The lesson is that "large dependency set" is a reason to run the two checks, not a reason to exclude by default. It has since moved to [`deanjstone/x-mcp`](https://github.com/deanjstone/x-mcp) ([#1069](https://github.com/deanjstone/argus/issues/1069)) and was removed from this tree by [#1095](https://github.com/deanjstone/argus/issues/1095); its history remains reachable in this repo's commit graph.

`email` was the third vendored snapshot (`wong2/cf-mailroom`, Apache-2.0). The same two checks were run
before placing it, and they went the vault-agent way (excluded): `apps/watchtower`'s typecheck still
passed, but the root lockfile diff was not additive (3,672 lines removed or rewritten as sibling peers
re-resolved), so it carried its own lockfile, `nested` CI entry and release-list entry
([#519](https://github.com/deanjstone/argus/issues/519)). It moved to
[`deanjstone/email`](https://github.com/deanjstone/email) ([#1073](https://github.com/deanjstone/argus/issues/1073))
and was removed from this tree by [#1173](https://github.com/deanjstone/argus/issues/1173); its history
remains reachable in this repo's commit graph. No package carries its own nested workspace now: the `nested`
machinery in `scripts/ci.sh`, `scripts/ci-changes.ts` and `release.yml` stays, with an empty list, for the next one.

## Commands

```bash
# Install all workspace dependencies (from repo root)
pnpm install

# Agent CLI
cd apps/agent-cli
pnpm run build         # tsc → dist/
./deploy.sh            # build + rsync dist/ → ~/.argus/agent-cli/ + verify shim

# Agent Engine
cd apps/agent-engine
pnpm run build
./deploy.sh            # build + rsync dist/ → ~/.argus/agent-engine/
```

Or from any session: use the `deploy` skill — `deploy agent` or `deploy agent-engine`.

### CI

`scripts/ci.sh` is the single definition of CI. `.github/workflows/ci.yml` calls it, and so
does the `.githooks/pre-push` gate, which runs `scripts/ci.sh --changed` — only the packages
that differ from `origin/main`, plus their dependents. Enable the gate once per clone with
`git config core.hooksPath .githooks`. `pnpm check` (`scripts/ci.sh --changed`) is the local
check: agents run it before every push, whether to a PR branch or straight to `main`, and
quote its result in the PR's test plan or the ticket's Resolution. GitHub CI remains the
enforcing check, and it runs on every push to `main`: nothing skips a push by its commit
subject or committer (argus-config#1183). A push runs only the tests it touches (`ci.sh --changed`
against the push's `before` SHA); `daily-full.yml` runs the whole suite once a day, and the
Release gate needs that run green and under 24 hours old (argus#65). Its `Changes` job (`scripts/ci-changes.ts`) starts only the jobs a change touches: the
root workspace and each changed nested package. The ecosystem manifest's skills check
(`scripts/ci.sh ecosystem-skills`, which needs the `SKILLS_READ_TOKEN` secret and skips without
it; see `ecosystem/README.md`) is its own workflow, `ecosystem-skills.yml`, which no pull request starts. A change to `scripts/ci.sh`, `ci.yml` or
`.github/actions/` runs everything. To add a check, edit the script, not the workflow.

### Links

URLs come from the vendored links registry (`links.json`, `*/src/lib/links.ts`), never from a
literal; `bash scripts/link-check.sh` enforces it in CI and `bash scripts/vendor-links.sh vX.Y.Z`
re-vendors it from `deanjstone-hl/frontend`. See the README's "Links come from the registry".

## Governance

**Package manager:** pnpm (workspace — `pnpm-workspace.yaml`). Never use npm or yarn.

**Worktrees:** `~/.t3/worktrees/argus/<branch-slug>/` — the folder T3 Code uses, and the only
place a worktree goes ([argus-config worktree rule](https://github.com/deanjstone/argus-config/blob/main/docs/instructions/worktrees.md)).
`~/repos/argus` is the deploy copy: it stays on `main` and is never edited. Never inside the
repo either. A worktree nested under `.claude/worktrees/` is invisible to `git status` (it is excluded in
`.git/info/exclude`) while still carrying a full `node_modules`, so it accumulates hundreds of
megabytes inside the working tree unnoticed.

**Deploys:** production deploys only from the `deploy` branch. A merge to `main` builds and tests
but neither deploys nor releases (a version is cut on the `deploy` push, see
`docs/deploy-branch.md`); `scripts/promote.sh <sha>` fast-forwards `deploy`
to a commit already on `main`, and that push runs the production workflows. Every manual path
(`apps/*/deploy.sh`, the wrangler and remote-migration `package.json` scripts) refuses to run
unless its checkout is `origin/deploy`. Promotion and every deploy need the owner's live
approval at a harness prompt, from a default-permission-mode thread; never answer an approval
prompt yourself. Details, rollback and the per-path table: `docs/deploy-branch.md`.

**Director-Agent workflow:** All non-trivial work is recorded as a GitHub issue (spec + AI implementation plan), gated on Director approval in chat. `.claude/tasks/` holds only pre-2026-07-17 history. Read `.claude/SYSTEM.md` before making any structural changes.

## Agent skills

### Issue tracker

GitHub Issues (`deanjstone/argus`) — authoritative record for all non-trivial Director-Agent work, and used by `to-tickets`, `wayfinder`, `to-spec`. See `docs/agents/issue-tracker.md`.

### Domain docs

Single-context — `docs/decisions/` at the repo root. See `docs/agents/domain.md`.

## Runtime paths

| Path | Purpose |
|---|---|
| `~/.argus/agent-cli/` | Deployed agent CLI (dist + node_modules) |
| `~/.argus/agent-engine/` | Deployed agent-engine runtime |
| `~/.argus/engine.pid` | Engine PID file |
| `~/.argus/engine.log` | Engine log |
| `~/bin/agent` | Shim → `~/.argus/agent-cli/dist/index.js` |

## Docs

Run `node scripts/docs-list.ts` to see every doc under `docs/` with a one-line summary and
when to read it, then open only what applies. Each doc needs `summary:` and `read_when:`
front matter, and `scripts/ci.sh` fails without them (see the Repo Structure Standard's
"Docs index" section).

## ADRs

`docs/decisions/` — see `docs/DECISIONS.md` for the index.

## Repo structure standard

This repo follows the account-wide [Repo Structure Standard](docs/system-specs/common/repo-structure-standard.md) (Full tier) — `AGENTS.md` as the canonical cross-tool file, PR template, and the full `docs/` taxonomy created as-needed.

## Related repos

| Repo | Role |
|---|---|
| `deanjstone/argus-config` | Claude Code config — skills, hooks, settings, rules |
| `deanjstone-hl/sys-admin` | Machine setup — install scripts, dev stack, sysadmin skills |

`deanjstone/mcp-memory` — the original standalone memory MCP server — was superseded by `argus-context`'s `packages/mcp-server` before this consolidation and is now archived ([mcp-memory#74](https://github.com/deanjstone/mcp-memory/issues/74)); no row here since its successor is the `memory-mcp` row above, not a related repo. `deanjstone/argus-context` itself (the immediate predecessor of the since-moved `memory-mcp` and `apps/wiki` and the since-deleted `packages/vault-core`) is likewise not listed, and is also archived ([#167](https://github.com/deanjstone/argus/issues/167)).

All four subtree-merged source repos — `ccbot`, `code-relay`, `watchtower`, `mcp-memory` — are archived with zero open issues (ccbot and code-relay have since been removed from this tree too, #382 and #450): their live backlogs were transferred into this repo on 2026-08-17, and the issues that were already done or superseded were closed in place. Old issue URLs redirect here.
