# @argus/agent-cli

The `agent` CLI — agent-engine client plus a few Claude Code utilities (`query`, `doctor`).

The terminal-multiplexer session launcher (bare `agent`, `agent -p`) and `agent listen` were retired in
[argus#549](https://github.com/deanjstone/argus/issues/549): T3 Code is the only agent harness.

## Run

```bash
pnpm run build      # tsc → dist/
pnpm run test       # vitest
node dist/index.js  # or `agent`, once deployed
```

## Not installed as a global

There is no `argus` command and no `@argus/cli` package. The first CLI (`packages/cli`, bin `argus`) was
renamed to `agent` on 2026-06-21 and now lives here. The CLI is deployed to `~/.argus/agent-cli/` and
reached through the `~/bin/agent` shim; do not `npm link` or `npm install -g` it.

## Deploy

```bash
./deploy.sh
```

Builds, rsyncs `dist/` to `~/.argus/agent-cli/`, and verifies the `~/bin/agent` shim points at
it. From a Claude Code session the `deploy` skill wraps this: `deploy agent`.

## Layout

- `src/commands/` — one module per subcommand
- `src/hooks/` — Claude Code hook entrypoints
- `src/lib/` — shared helpers
- `test/` — vitest suite
