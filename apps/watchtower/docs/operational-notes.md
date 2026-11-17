# Operational notes — watchtower

Hard-won gotchas from building and deploying watchtower. Kept because each one cost a
debugging session and none are recoverable from the code.

Was `HANDOFF.md`; the HANDOFF convention is retired (see the root `AGENTS.md`). The
status/session-log sections it carried were point-in-time and are dropped — GitHub Issues are
the backlog, and the one item still open from it, the Duplicati adapter, is tracked at
[argus#284](https://github.com/deanjstone/argus/issues/284).

## Gotchas

**Realtime on `service_checks` was enabled directly against the remote Supabase project, not just via a checked-in migration file.** `alter publication supabase_realtime add table ...` was run through the Supabase MCP `apply_migration` tool during task-005 verification, before PR #10 merged. The migration file (`supabase/migrations/0002_service_checks_realtime.sql`) documents this for history/reproducibility (e.g. a fresh environment), but re-running it against the *current* myargus project is a no-op — don't be alarmed that "the migration hasn't been applied yet" according to git history; check `list_migrations` against the live project, not just the repo, before assuming state.

**Cloudflare adapter uses `/workers/services/{name}`, not `/workers/scripts/{name}`.** The scripts endpoint returns raw script content (not JSON), which breaks any `jq`-style parsing. The services endpoint returns proper metadata (`default_environment`, `created_on`, `modified_on`).

**Cloudflare credentials: prefer the existing scoped token over the Global API Key.** `CLOUDFLARE-TOKEN-PAGES` in Bitwarden already has read access to the Pages projects (`stockade`, `knowledge`, `myargus`, `reader`) and Workers scripts (`argus-memory-mcp`, `reader-api`) watchtower needs to poll — task-004 reused it rather than minting a new token or touching the unscoped Global Key. The harness's auto-mode classifier will actively block attempts to use the Global Key for anything beyond a single explicitly-scoped lookup; don't try to work around that block, surface the tradeoff to the Director instead (this happened once in task-004 and the Director chose to reuse the scoped token).

**`bw create item` echoes the full new item, including the plaintext secret, to stdout.** Happened once creating the Supabase Management API PAT item. Not a bug to route around — flag it to the Director every time it happens (confirmed wanted behavior, not excessive caution). See the global `feedback_flag_credential_exposure` memory.

**Frontend auth code has no shared package to pull from — it's copy-paste by convention.** There's no shared `@myargus/auth` package across the myargus monorepo apps; `src/pages/SignIn.tsx`, `src/components/PasskeyGate.tsx`, and the `experimental: { passkey: true }` client option in `src/lib/supabase.ts` were all adapted directly from `~/repos/myargus/apps/shell/src/`. If shell's passkey pattern changes, watchtower's copy won't pick it up automatically — check both places.

**Homelab's git checkout doesn't auto-follow `main`.** After task-003's PR merged, homelab was left checked out on the now-stale `feature/task-003-syncthing-adapter` branch rather than `main` — `git pull` there silently pulled that branch's own (unchanged) remote, not `main`, so task-004's adapters were merged in GitHub but never actually reached the running service. Always confirm `git branch --show-current` is `main` on homelab before assuming a `git pull` picked up the latest.

**pnpm/node aren't on homelab's non-interactive `$PATH`.** Both are managed by `fnm` and only resolve in an interactive login shell. Build/deploy commands run over `ssh user@homelab "..."` need the fnm-installed binaries referenced directly, e.g. `export PATH=/home/srvr/.local/share/fnm/node-versions/v22.23.1/installation/bin:$PATH` before `pnpm install`/`pnpm run build`. The systemd unit already accounts for this (`ExecStart` points straight at the fnm node binary), but manual SSH commands don't get that for free.

**`cloudflare/wrangler-action` breaks in a pnpm workspace unless `wrangler` is already a devDependency.** The action's fallback install (`pnpm add wrangler`) throws `ERR_PNPM_ADDING_TO_ROOT` in a workspace (root installs need `-w`, which the action doesn't pass) — every Deploy run failed on this until `wrangler` was pinned directly in `package.json` (PR #14), letting the action's own preflight `pnpm exec wrangler --version` check find it and skip installing. Also required setting `sharp`/`workerd` (wrangler's transitive deps) to `true` in `pnpm-workspace.yaml`'s `allowBuilds` — pnpm 11's build-script approval gate blocks their postinstall otherwise.

**Every new myargus subdomain needs its origin added to Supabase's `webauthn_rp_origins` before passkey sign-in works.** First live passkey attempt against `watchtower.myargus.cc` failed with "Credential verification failed" — the RP ID (`myargus.cc`) check passes client-side, but Supabase separately validates the origin against an explicit allowlist server-side. Fixed via the Supabase dashboard (Auth → Passkeys → RP Origins), adding `https://watchtower.myargus.cc` to the existing list. See `[[fact_supabase_webauthn_rp_origins]]` — apply this proactively for any future myargus subdomain, don't wait to be surprised by it again.
