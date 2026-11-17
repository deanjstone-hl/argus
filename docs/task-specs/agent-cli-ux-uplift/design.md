---
title: agent-cli Terminal UX Uplift (chalk / ora / cli-table3)
date: 2026-07-08
status: approved
approved: true
tags: [plan, agent-cli]
summary: "Design for agent-cli terminal output: chalk, ora and cli-table3"
read_when:
  - changing agent-cli output formatting
---

## Context

Prompted by a review of [ratatui](https://github.com/ratatui/ratatui) as a potential uplift for `agent-cli`. Ratatui is a Rust-only full-screen TUI framework (widgets, layout engine, alternate-screen event loop) — no JS/TS bindings, and `agent-cli` (`~/repos/argus/apps/agent-cli/`) is a thin Commander-based CLI (open/run/search/read/write/server/doctor/query), not a full-screen app. Adopting it would mean a Rust rewrite, which is out of scope.

The real gap is smaller: output today is raw `console.log`/`console.error` with hand-rolled ANSI codes (`doctor.ts`), no spinners during network waits (`server start`'s 5s poll loop, `run`/`search` engine calls), and no tabular formatting for `search` results. This plan scopes a lightweight, Node-native uplift instead — no framework, no interaction-model change.

**Not in scope:** replacing the `fzf`-based interactive pickers in `lib/projects.ts` (`pickProjectInteractive`, `pickPackageInteractive`). They already work well and swapping to a JS prompt library (e.g. `@clack/prompts`) would be a UX regression (fzf's fuzzy search is better) for no benefit — skip it.

## Current state (as reviewed)

| File | Pattern |
|---|---|
| `src/commands/doctor.ts` | Hand-rolled `\x1b[32m✓\x1b[0m` / `\x1b[31m✗\x1b[0m` constants |
| `src/commands/server.ts` | Silent `for` loop polling `isEngineRunning()` every 500ms up to 5s, no feedback |
| `src/commands/search.ts` | Loose `console.log` blocks per result, no alignment |
| `src/commands/run.ts`, `search.ts` | Every network call (`engineChat`, `engineSearch`) can hang with zero visual feedback |
| `open.ts`, `server.ts`, `search.ts`, `run.ts`, `read.ts`, `write.ts` | Each hand-writes its own `argus-agent: <message>` error prefix — duplicated, inconsistent (some say `argus-agent`, doctor says nothing, some say `agent`) |

## Proposed changes

### 1. Add dependencies
```bash
cd ~/repos/argus/apps/agent-cli
pnpm add chalk ora cli-table3
```
(pnpm — this is the argus monorepo workspace, not the npm-default global convention.)

### 2. New shared helper: `src/lib/ui.ts`
Centralize the repeated status/error patterns into one module:
```ts
import chalk from 'chalk';

export const ok = (s: string) => chalk.green(s);
export const fail = (s: string) => chalk.red(s);
export const warn = (s: string) => chalk.yellow(s);
export const dim = (s: string) => chalk.dim(s);

export function errorOut(message: string): never {
  console.error(`${chalk.red('agent:')} ${message}`);
  process.exit(1);
}
```
Replace the ad-hoc `console.error('argus-agent: ...')` / `console.error('agent:', ...)` calls in `open.ts`, `server.ts`, `search.ts`, `run.ts`, `read.ts`, `write.ts` with `errorOut(...)`. Fixes the existing `argus-agent` vs `agent` prefix inconsistency as a side effect.

### 3. `doctor.ts`: swap raw ANSI for chalk
Replace the `OK`/`FAIL` `\x1b[...]` constants with `ok('✓')` / `fail('✗')` from `lib/ui.ts`. Same output, no manual escape codes.

### 4. `server.ts` `start`: add an `ora` spinner around the health-check poll
Wrap the existing 10×500ms loop:
```ts
const spinner = ora('waiting for engine health check').start();
for (let i = 0; i < 10; i++) {
  await sleep(500);
  if (await isEngineRunning()) {
    spinner.succeed(`engine started (pid ${child.pid})`);
    return;
  }
}
spinner.fail(`started but health check timed out — see ${ENGINE_LOG}`);
```
No behavior change, just visible progress instead of a silent hang.

### 5. `run.ts`: spinner around `engineChat`
```ts
const spinner = ora('dispatching to agent-engine').start();
try {
  const text = await engineChat(prompt);
  spinner.stop();
  process.stdout.write(text + '\n');
} catch (err) {
  spinner.fail((err as Error).message);
  process.exit(1);
}
```

### 6. `search.ts`: replace loose `console.log` with `cli-table3`
```ts
import Table from 'cli-table3';
const table = new Table({ head: ['#', 'score', 'file'], style: { head: ['cyan'] } });
results.forEach((r, i) => table.push([i + 1, r.score.toFixed(3), r.fileName]));
console.log(table.toString());
// keep the chunk preview printed below the table, unchanged
```
Wrap the `engineSearch` call itself in an `ora` spinner too, same pattern as `run.ts`.

### 7. No changes to
`open.ts`'s fzf pickers, `wt.ts`, `projects.ts` core logic, `read.ts`/`write.ts` file I/O, `query.ts` (passthrough to `claude --print`, already plain by design for scriptability).

## Risks / considerations

- `ora` writes to a TTY; must confirm it degrades gracefully (no spinner frames) when stdout is piped — it does this by default (checks `process.stdout.isTTY`), but verify after wiring in.
- Passthrough/`-q`/`query` output must stay spinner-free and uncolored — those are explicitly documented as "plain output, scriptable." Don't route `query.ts` through `lib/ui.ts` coloring.
- Adds 3 small deps (chalk, ora, cli-table3) with no native bindings — safe for the `deploy.sh` rsync + `npm install` runtime step (no ABI concerns, unlike native binaries — see `feedback_native_binary_node_abi`).

## Rollout

1. `pnpm add chalk ora cli-table3` in `apps/agent-cli`
2. Add `src/lib/ui.ts`
3. Migrate `doctor.ts`, `server.ts`, `run.ts`, `search.ts` per above
4. Sweep remaining commands (`open.ts`, `read.ts`, `write.ts`) to use `errorOut()` for consistency
5. `npm run typecheck && npm run build`
6. Manual smoke test: `agent doctor`, `agent server start` (cold, engine not running), `agent search <query>`, `agent run <prompt>`
7. `./deploy.sh` (or `deploy agent` skill) to ship to `~/.argus/agent-cli/`

## Addendum: folded-in scope (shipped 2026-07-08)

Two additional items were folded into this same implementation pass, beyond the original UX-uplift scope:

1. **`doctor.ts` skill/CLAUDE.md checks** — added `claude.md` (symlink reachability of `~/.claude/CLAUDE.md`) and `skills` (broken-symlink scan of `~/.claude/skills/`, via new `checkSkills()`) checks, prompted by a review of whether Claude-shipped slash commands and custom skills are reliably available in `agent-cli` sessions.
2. **agent-engine systemd autostart** — agent-engine had no autostart on WSL2 (only existed as a pattern on homelab). Added:
   - `~/repos/argus-config/wsl2/systemd/user/agent-engine.service` (adapted from the homelab unit, `%h`-relative)
   - `~/repos/argus-config/wsl2/systemd/user/install-agent-engine.sh` (installs unit, substitutes fnm node path, `systemctl --user enable --now`)
   - `~/.argus/agent-engine/.env` (`ARGUS_PORT=3747`, `ARGUS_VAULT_ROOT=/home/deanj/CORTEX` — fixes a stale hardcoded fallback path in `http.ts`)
   - `doctor.ts` `engine-boot` check (`systemctl --user is-enabled agent-engine`)

## Changes

- 2026-07-08: initial draft, scoped down from a ratatui review (Rust TUI framework — not applicable to this Node/TS CLI).
- 2026-07-08: implemented and deployed. UX uplift (chalk/ora/cli-table3 + `lib/ui.ts`, migrated `doctor.ts`/`server.ts`/`run.ts`/`search.ts`/`open.ts`/`read.ts`/`write.ts`) shipped together with the doctor skill/CLAUDE.md checks and agent-engine systemd autostart (see addendum below). Verified via `agent doctor` end-to-end post-deploy. Marked `approved`.
