---
title: myargus Platform Plan
status: approved
created: 2026-06-08
updated: 2026-06-09
tags: [architecture, planning, myargus]
summary: "2026-06 platform plan for myargus.cc: two monorepos, Cloudflare hosting, passkeys, Supabase"
read_when:
  - "tracing the myargus platform's founding decisions"
---

# myargus Platform Plan

## Context

Argus is forming into a unified personal operating system spanning: agent orchestration, development tooling, computer management, PKM, household budgeting, EDMS, and inventory (Stockade). Domain `myargus.cc` purchased 2026-06-08 as the internet-facing interface for all user-facing apps.

## Decisions locked

| Decision | Choice |
|---|---|
| Repository structure | Two monorepos: `argus` (AI infra) + `myargus` (user apps) |
| Domain | `myargus.cc` — subdomain per app; DNS on Cloudflare |
| Hosting | Cloudflare Pages (not Vercel) — domain already on Cloudflare; use `@cloudflare/next-on-pages` adapter |
| Auth | Passkeys (WebAuthn), RP ID = `myargus.cc` |
| Database | Single Supabase project `myargus` (ap-southeast-2) |
| DB schema pattern | Postgres schemas per domain (`budget.*`, `stockade.*`); EDMS uses Paperless-NGX's own DB |
| EDMS exposure | Cloudflare Tunnel + Access — no VPS or public IP required |
| Open WebUI | Scrapped — reference only for future custom chat interface |
| Tailscale / internal routing | Deferred — Cloudflare Tunnel covers EDMS; review remaining uses separately |
| Inventory app name | `stockade` (renamed from `hermes` 2026-06-08) |

## Subdomain map

```
myargus.cc              → shell / home dashboard
budget.myargus.cc       → Budget app
stockade.myargus.cc     → Stockade (inventory)
edms.myargus.cc         → Paperless-NGX (reverse proxy, self-hosted)
api.myargus.cc          → Shared edge functions (if needed)

[deferred — Tailscale review]
dashboard.myargus.cc    → dev-stack
memory.myargus.cc       → mcp-memory
```

## Two-monorepo boundary

### `argus/` — AI infrastructure (private, internal, not deployed to myargus.cc)

```
argus/
├── packages/
│   ├── ccbot/          (from ~/repos/ccbot)
│   ├── mcp-memory/     (from ~/repos/mcp-memory)
│   └── dev-stack/      (from ~/repos/dev-stack)
├── config/             (from ~/repos/claude-config)
│   ├── wsl2/settings.json
│   ├── windows/settings.json
│   └── hooks/
├── context/
├── docs/
│   └── adr/
├── hooks/
├── bin/
└── registry.json       (machine-readable project manifest)
```

### `myargus/` — User-facing applications (public, deployed to myargus.cc)

```
myargus/
├── apps/
│   ├── shell/          → myargus.cc
│   ├── budget/         → budget.myargus.cc
│   └── stockade/       → stockade.myargus.cc
└── packages/
    ├── ui/             shared design system + components
    └── db/             shared Supabase-generated types
```

---

## Phases

### Phase 1 — Governance (no migration, low risk)

**Goal:** Lock the rules before building anything new.

- [x] Write `argus/docs/decisions/adr-003-two-monorepo-boundary.md`
- [x] Write `argus/docs/decisions/adr-004-single-supabase-project.md`
- [x] Write `argus/docs/decisions/adr-005-passkeys-auth-standard.md`
- [x] Create `argus/registry.json` — machine-readable project manifest replacing stack.md
- [x] Update argus post-commit hook to write to registry.json on commit

### Phase 2 — myargus Supabase project

**Goal:** Create the canonical database before any app migration.

- [x] Create new Supabase project named `myargus` in ap-southeast-2 — `iyqhnvandyalaujyqbtj`
- [ ] Set Auth RP ID to `myargus.cc` — **manual step: Supabase dashboard → Auth → URL Configuration**
- [ ] Enable passkeys in Supabase Auth settings — **manual step: Supabase dashboard → Auth → Sign In Methods**
- [x] Create Postgres schemas: `budget`, `stockade`, `edms`
- [x] Document project ID and URL in `argus/registry.json` and `argus/context/stack.md`
- [x] Confirm free-tier limits — paused `hermes` to stay on free tier; retire after Phase 4

### Phase 3 — myargus monorepo scaffold

**Goal:** The repo that all user-facing apps will live in.

- [x] Create `~/repos/myargus/` with npm workspaces
- [x] Scaffold `packages/ui/` — Button + Card; grows organically
- [x] Scaffold `packages/db/` — placeholder types; run `npm run gen --workspace=packages/db` after passkeys enabled
- [x] Scaffold `apps/shell/` — Vite + React + Tailwind; passkey sign-in + home with app links
- [x] Wire passkey sign-in in shell — `supabase.auth.signInWithPasskey()` wired; needs passkeys enabled in dashboard first
- [x] Create GitHub repo `deanjstone/myargus` (private) — pushed
- [ ] Configure Cloudflare Pages: one project per app, custom subdomain per deployment — **manual step: Cloudflare dashboard**
- [ ] Budget app: complete Cloudflare edge runtime migration before deploying (see `budget/docs/TODO.md`)

### Phase 4 — Stockade migration

**Goal:** Move Stockade onto the shared platform; first production app on myargus.cc.

- [x] Migrate Stockade schema to `myargus` Supabase under `stockade.*` — migration applied
- [x] Update Stockade app env vars — URL + anon key updated to `iyqhnvandyalaujyqbtj`
- [x] Wire scan button into `products.ts` — `openScanner` + `lookupBarcode` wired
- [ ] Phase 5 secrets — set `TELEGRAM_BOT_TOKEN` + service role GUC — **manual: Supabase dashboard → Edge Functions → secrets**
- [ ] Phase 7 icons — replace placeholder PNGs in `cmdpal/HermesSearch/Assets/` — **design step**
- [x] Merge all feature branches → main — phases 2–7 merged and pushed
- [ ] Move `~/repos/stockade/` into `myargus/apps/stockade/` — deferred until Cloudflare Pages setup
- [ ] Deploy to `stockade.myargus.cc` via Cloudflare Pages — deferred until Phase 3 Cloudflare setup
- [ ] Retire old Supabase project `mldxlujlinhlsmfyzcwp` — do after deploy confirmed

### Phase 5 — Budget migration

**Goal:** Move Budget onto the shared platform.

- [x] Migrate Budget schema to `myargus` Supabase under `budget.*`
- [x] Update Budget app env vars — URL + anon key updated; service role key: add "myargus-supabase-service-role-key" to Bitwarden
- [x] Update Budget Supabase client files — all 4 files use `{ db: { schema: 'budget' } }`
- [ ] Complete Cloudflare edge runtime migration in Budget app (see `budget/docs/TODO.md`)
- [ ] Move `~/repos/budget/` into `myargus/apps/budget/` — deferred until Cloudflare Pages setup
- [ ] Deploy to `budget.myargus.cc` via Cloudflare Pages
- [ ] Retire old Budget Supabase project

### Phase 6 — Argus infra monorepo consolidation

**Goal:** Tighten the infra layer. Do when next touching ccbot or mcp-memory — not a priority in isolation.

- [x] Copy `~/repos/ccbot/` → `argus/packages/ccbot/` (commit `aedef04`)
- [x] Copy `~/repos/mcp-memory/` → `argus/packages/mcp-memory/` (commit `2026ee5`)
- [x] Copy `~/repos/dev-stack/` → `argus/packages/dev-stack/` (commit `3ba03ca`)
- [x] Copy `~/repos/claude-config/` → `argus/config/` (commit `a895cb1`)
- [x] Update `~/.claude/settings.json` symlink → `~/argus/config/wsl2/settings.json`
- [ ] Update mcp-memory deployment to Cloudflare Pages — `rootDirectory = packages/mcp-memory` — **manual: Cloudflare dashboard** (was Vercel)
- [x] deploy.sh paths in ccbot OK — uses `$(dirname "$0")`; no changes needed
- [x] Update GitHub remotes of standalone repos to point to `deanjstone/argus`
- [x] Retire standalone repos: ccbot-argus, argus-memory-mcp, claude-stack, dev-stack (archived on GitHub 2026-06-11)

### Phase 7 — EDMS (Paperless-NGX)

**Goal:** Self-hosted document management at `edms.myargus.cc` using [Paperless-NGX](https://docs.paperless-ngx.com/).

**Architecture decision:** Paperless-NGX is a Docker-based self-hosted app with its own PostgreSQL database. It is NOT a Next.js app and does NOT use the shared Supabase project. `edms.*` schema in Supabase is not required.

**Prerequisite:** Tailscale/hosting review (currently deferred) must happen first — Paperless-NGX needs a persistent server.

- [ ] Decide hosting target: local NAS/server exposed via Tailscale funnel, or a VPS (Hetzner/OCI free tier)
- [ ] Deploy Paperless-NGX via Docker Compose on target host
- [ ] Configure `edms.myargus.cc` → reverse proxy to Paperless-NGX instance
- [ ] Wire Paperless-NGX auth — consider Supabase as OIDC provider if SSO is wanted
- [ ] Add Docker Compose config to `argus/packages/` or `argus/config/` for version control

---

## Deferred

- **Tailscale / internal routing review** — Cloudflare Tunnel covers EDMS; review remaining Tailscale use cases separately (dev dashboard, mcp-memory internal access)
- **Custom chat interface** — Open WebUI as UX reference; build after core apps stable
- **`api.myargus.cc`** — shared edge function gateway; only if cross-app API patterns emerge
- **GitHub repo rename cleanup** — `claude-stack` → `claude-config`, `argus-memory-mcp` → `mcp-memory`; low priority until Phase 6

## Resolved / out of scope

- Open WebUI — scrapped as product; reference only
- Hanko / Passage — not needed; Supabase Auth with passkeys sufficient
- Per-app Supabase projects — superseded by single shared project decision
