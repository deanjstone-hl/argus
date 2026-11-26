# @argus/watchtower

> **The dashboard UI moved.** It is the `/watchtower` module of the ops hub PWA
> ([`deanjstone-hl/ops-hub` ops-hub#84](https://github.com/deanjstone-hl/ops-hub/issues/84), `apps/ops-hub-web`),
> which reads the hub's own `/api/watchtower/*`. This app stays in place, UI and Worker, until the old
> `watchtower.myargus.cc` alias is retired (the close-out ticket in myargus); do not delete it before then. The
> collector, the Worker and its D1 database are unchanged. Before that host redirects it serves a
> **kill-switch**: `public/sw.js` (clears every cache, unregisters itself and reloads open pages when an installed
> copy's worker next updates) and an inline script in `index.html` doing the same for a page that opens first.
> The host never registered a service worker, so the kill-switch only matters to a copy that did. Keep `/sw.js`
> served, and out of the redirect, until the alias is retired (`src/kill-switch.test.ts`).

Infra dashboard for the Argus stack. One package, two deployables:

- **Dashboard** — React/Vite UI at `watchtower.myargus.cc`, behind passkey sign-in on the shared
  myargus Supabase project. Shows the latest check for each monitored service.
- **Worker API** — Cloudflare Worker `argus-watchtower-api` on `api.myargus.cc/watchtower/*`,
  storing checks in the D1 database `argus-watchtower`.

Checks are written by [`watchtower-collector`](../watchtower-collector/), which polls homelab and
cloud sources, and [`watchtower-usage-shim`](../watchtower-usage-shim/) feeds it AI usage stats.

## API

| Route | Auth | Purpose |
|---|---|---|
| `GET /watchtower/health` | none | liveness |
| `POST /watchtower/checks` | `Bearer WATCHTOWER_COLLECTOR_TOKEN` (skipped if the secret is unset) | collector writes one check |
| `GET /watchtower/checks` | `Bearer` Supabase session JWT, verified (ES256) against the project JWKS at `SUPABASE_URL` | latest check per `service_key` |

## Run

```bash
pnpm run dev          # Vite dev server for the dashboard
pnpm run worker:dev   # wrangler dev for the Worker API
pnpm run typecheck    # wrangler types, then tsc -b
pnpm run lint
pnpm run test         # vitest, against simulated D1
```

The dashboard needs a populated `.env`: copy [`.env.example`](.env.example) to `.env` (gitignored)
and fill each variable from the Secrets Manager key its `# BWS secret <KEY>` comment names.

## Deploy

No `deploy.sh`. Both workflows read their values (the Cloudflare token, account id and D1 token, the
D1 database id, the Supabase URL and anon key) from the `actions` project of Secrets Manager through
`bitwarden/sm-action`; the only repository secret is `BWS_ACCESS_TOKEN`
(`docs/public-cutover.md`, *Deploy values and Actions secrets*). The two halves deploy separately:

- **Dashboard** — `.github/workflows/watchtower-deploy.yml`, on every push to `deploy` touching
  `apps/watchtower/**`, to Cloudflare Pages project `watchtower` (`watchtower.myargus.cc`).
- **Worker API** — `.github/workflows/watchtower-deploy-worker.yml`, on a push to `deploy`
  touching this app, `packages/watchtower-contract/` or `packages/bearer-auth/` (or a dispatch on
  `deploy`): dry-run, D1 migrations, then `wrangler deploy`. By hand, from a checkout at
  `origin/deploy`: `pnpm run worker:deploy` (`wrangler deploy`; the migrations are separate).
  Run it after a root `pnpm install`: the Worker bundles `@argus/watchtower-contract` from
  `packages/` through its workspace link.
  The collector token is set with `wrangler secret put WATCHTOWER_COLLECTOR_TOKEN`;
  `SUPABASE_URL` is a plain var in `wrangler.jsonc`. The `SUPABASE_JWT_SECRET` secret from the
  HS256 era is unused and can be removed with `wrangler secret delete SUPABASE_JWT_SECRET`.

D1 schema changes go through [`migrations/`](migrations/). `GET /checks` reads
`service_checks_latest` (one row per service key, upserted on every `POST /checks`); the
`service_checks` history gets a row only when a key's status or detail changes, is kept for 2 days
and is pruned hourly by the Worker's cron trigger (`RETENTION_DAYS` in `src/worker/index.ts`). Operational gotchas worth reading
before touching the deploy path are in [`docs/operational-notes.md`](docs/operational-notes.md).

## Layout

- `src/pages/`, `src/components/` — dashboard UI; passkey sign-in in `SignIn.tsx` and
  `PasskeyGate.tsx`, copied from myargus shell
- `src/worker/index.ts` — the Worker API (Hono, mounted under `/watchtower`)
- `migrations/` — D1 schema
- `src/lib/` — Supabase client and display helpers, with co-located `*.test.ts`
- `test/` — Worker API and D1 migration suites
