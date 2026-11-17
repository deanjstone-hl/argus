# watchtower-contract

The watchtower check contract: the `HealthStatus` union, the `POST /watchtower/checks` payload
(`CheckInput`), the `GET /watchtower/checks` row (`ServiceCheck`), and the detail shapes the
dashboard renders specially (`AiUsageHostDetail`, `SyncthingFolderDetail`, the printer, scanner, systemd unit, GitHub runner, GitHub queue (`GithubQueueDetail`, with the full waiting and in-progress job lists) and LNV-LGN5 host shapes), and `HostReport`, the usage-shim's `GET /host` reply. `parseCheckInput`
is the validation the Worker runs on every posted check.

Consumed via `workspace:*` by `apps/watchtower` (dashboard and Worker) and
`apps/watchtower-collector`.

## Source-only

There is no build step. `exports` points at `src/index.ts`, and each consumer compiles it as
its own source: Vite bundles it into the dashboard, wrangler's esbuild into the Worker, and the
collector's `tsc` sees only `import type` from it, which is erased from the collector's output.
Keep the collector's imports type-only — its `dist/` runs on plain Node, which does not load
`.ts` from a dependency.

## Run

```bash
pnpm run typecheck
pnpm test
```

## Deploy

Not deployed on its own. It ships inside the dashboard, the Worker and the collector.
