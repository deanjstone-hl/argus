# @argus/watchtower-usage-shim

Small HTTP service exposing local AI usage stats (via `ccusage`) to the
[watchtower collector](../watchtower-collector/), which cannot read them across the host
boundary itself, and reports the machine it runs on. Bearer-token authenticated, two `GET`
endpoints; any other path is a 404 and any other method a 405:

- `GET /usage` — `ccusage --json` output, for the ai-usage card
- `GET /host` — a `HostReport` (`@argus/watchtower-contract`): the Windows system drive's free
  space (`/mnt/c`), the WSL and Windows crash-dump folders (count, size, newest), memory and
  memory pressure (`/proc/meminfo`, `/proc/pressure/memory`), and `systemctl --user show`
  properties for `HOST_UNITS` (default `agent-engine.service,memory-reconcile.timer`). For the
  silent-failure cards ([#686](https://github.com/deanjstone/argus/issues/686)) it also carries
  every `--user` timer (`systemctl --user list-unit-files --type=timer`, disabled ones too; a template such as `loop-wake@.timer` is skipped and its instances come from `list-units --type=timer --all`), the
  memory-reconcile heartbeat (`CONTEXT_RECONCILE_HEARTBEAT_FILE`, default
  `~/.argus/memory-reconcile-heartbeat.json`), and the output of argus-config's
  `hooks/vault-staleness.sh` run once per vault in `HOST_VAULTS` (default `~/CONTEXT,~/CORTEX`;
  hook path `HOST_VAULT_HOOK`, default `~/.argus/hooks/vault-staleness.sh`). The hook runs
  `git ls-remote`, so its result is reused for 4 minutes. For the T3 card
  ([#1175](https://github.com/deanjstone/argus/issues/1175)) it runs argus-config's
  `hooks/t3-stale.py --no-state` (hook path `HOST_T3_STALE_HOOK`, default
  `~/.argus/hooks/t3-stale.py`; host name `HOST_T3_HOST`, default `wsl2`) and passes its JSON on as
  `t3Stale`; the hook may call `gh`, so that result is also reused for 4 minutes. Raw facts only:
  the collector decides each LNV-LGN5 card's status.

### Why the collector pulls `/host` instead of WSL2 pushing to `/checks`

The collector runs on homelab, so the LNV-LGN5 cards need a reporter on WSL2 ([#682](https://github.com/deanjstone/argus/issues/682)).
It is this shim, polled over the tailnet, rather than a new `--user` timer POSTing to
`/watchtower/checks`:

- **Nothing new to install or hold.** The shim already runs on WSL2, is already reachable
  over Tailscale, and already authenticates the collector with a token the collector already
  has. A push timer would be a new unit, and would put the collector's write token on a second
  machine.
- **A sleeping laptop reads as `unreachable`, not silence.** A pull that gets no answer is
  recorded as `unreachable`, the status every cross-host card already uses
  (ai-usage). A push that stops leaves the last good card in place until it goes stale.
- **One writer, one place for policy.** The collector stays the only thing writing checks,
  and its thresholds and the systemd evaluation it already uses for homelab apply unchanged.

Runs on WSL2 today; a Windows instance would need its own token secret.

## Run

```bash
pnpm run dev        # tsx watch src/index.ts
pnpm run build      # tsc → dist/
pnpm run start      # node dist/index.js
pnpm run test       # vitest
```

Needs `USAGE_SHIM_TOKEN` and `USAGE_SHIM_PORT` (default 8765) — see `.env.example`. The deployed copy is `~/.config/argus/watchtower-usage-shim.env`.

## Deploy

```bash
./deploy.sh
```

Run it **on the host the shim runs on**. Writes `~/.config/argus/watchtower-usage-shim.env` from Bitwarden Secrets Manager (needs
`BWS_ACCESS_TOKEN`), then builds and restarts `watchtower-usage-shim.service` if that unit is
installed here. On any other host it stops after writing the env file.

Its env file is `~/.config/argus/watchtower-usage-shim.env` (mode 600), outside the deploy copy so an agent can fix it ([argus-config#1267](https://github.com/deanjstone/argus-config/issues/1267)). The old `apps/watchtower-usage-shim/.env` still loads and is deprecated; the one-time move is argus-config's `scripts/owner-steps/1267.sh`. `deploy.sh` warns while the old file is still there.

## Layout

- `src/server.ts` — the HTTP server, injectable `runCcusage` for testing
- `src/ccusage.ts` — the real `ccusage` invocation: the pinned `ccusage` dependency, spawned
  through `process.execPath` (no `npx`)
- `src/host-report.ts` — the `GET /host` report, with injectable fs and `systemctl`
- `src/*.test.ts` — vitest, co-located
