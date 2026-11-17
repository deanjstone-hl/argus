---
title: ADR-012 — Shared Inbox Moves to mail.myargus.cc on a Vendored Mailroom
status: accepted
date: 2026-10-07
summary: "ADR-012: shared inbox moves to mail.myargus.cc on a vendored cf-mailroom (apps/email)"
read_when:
  - "working on apps/email, email-worker or email-mcp"
---

# ADR-012: Shared Inbox Moves to mail.myargus.cc on a Vendored Mailroom

> **Update ([#1173](https://github.com/deanjstone/argus/issues/1173)):** `apps/email` moved to [`deanjstone/email`](https://github.com/deanjstone/email) and was removed from this repo; `apps/email-worker` and `apps/email-mcp` were removed by [#712](https://github.com/deanjstone/argus/issues/712). Paths below are history.

## Context

The Argus shared inbox runs on two home-grown packages:

| Package | Worker | Role |
|---|---|---|
| `apps/email-worker` | `argus-agent-email` | Inbound ingest (Email Routing) into D1 + R2, outbound send glue, forwarding to `FORWARD_ADDRESS` |
| `apps/email-mcp` | `argus-agent-email-mcp` | Agent tool surface: a stdio transport (REST clients against D1/R2) and a Worker transport at `mcp.myargus.cc/email/*` |

Agents can use these, but no human can. There is no web UI, no threading, no compose or
reply with attachments, no search and no notifications. Reading the inbox means asking an
agent to read it. The stdio transport also duplicates the storage layer as REST clients and
needs per-machine deploys and secrets.

[wong2/cf-mailroom](https://github.com/wong2/cf-mailroom) (Apache-2.0) is a Cloudflare-native
mailroom that already does all of this. It has a web UI, threading, compose/reply with
attachments, search, Web Push, and an OAuth 2.1 MCP endpoint with idempotent sends and a
daily send cap. It also has AI drafting and auto-labels. It runs on the same primitives:
Workers, D1, R2, queues, KV.

### Options considered

1. **Vendor mailroom as `apps/email` and retire both packages** (chosen).
2. **Build a UI and threading onto email-worker/email-mcp.** Rejected: that rebuilds most
   of mailroom by hand, and the result would still lack OAuth and send idempotency.
3. **Subtree mailroom and track upstream.** Rejected: Argus diverges on arrival (design-system
   UI, forwarding, service-token auth, AI off), so pulling from upstream would mean
   resolving conflicts on every pull. The same reasoning made `vault-agent` and `x-mcp` vendored
   snapshots (see the root `AGENTS.md`).
4. **Serve it under `mcp.myargus.cc/email/*` like today.** Rejected: OAuth 2.1 discovery
   (`/.well-known/oauth-authorization-server`, `/.well-known/oauth-protected-resource`)
   resolves against the host root. A path-prefixed MCP endpoint behind a shared host can't
   publish its own authorization-server metadata without taking over that host's
   `/.well-known` for every other app on it.

The full decision set came out of a grilling session on 2026-10-07 and is recorded in the
Notes of map [#518](https://github.com/deanjstone/argus/issues/518). This ADR records the
architectural decisions from that set. The map is the authority for the rest.

## Decision

**Mailroom replaces email-worker and email-mcp.** A vendored snapshot of
`wong2/cf-mailroom@56f5221507a75839d6c49a941051f3e868885648` lands as `apps/email`
(`@argus/email`). It carries no `git-subtree-*` trailer and there is no plan to pull from
upstream again. Provenance goes in `apps/email/AGENTS.md`, and the Apache-2.0 §4(b)
statement of changes goes in `apps/email/NOTICE`. Every Cloudflare resource is named
`argus-email*` (Worker, D1, R2, queues, KV). "Mailroom" appears only in provenance. The
package converts from npm to pnpm. Whether it joins the root workspace flat or stays
nested-excluded is decided by measurement, per the root `AGENTS.md`.

**One host: `mail.myargus.cc`.** The web UI, the API and `/mcp` all live on that one
hostname, behind Cloudflare Access. Access has a Bypass for `/mcp` and `/.well-known`, so
OAuth discovery and MCP clients reach the Worker's own auth. This is a **recorded
exception** to the `mcp.myargus.cc/<app>` path taxonomy. The reason is that OAuth discovery
needs the host root (option 4 above). `mcp.myargus.cc/email/*` is retired after cutover.

**MCP auth is OAuth plus a service token, and stdio is retired.** Interactive clients use
mailroom's OAuth 2.1 `/mcp`. Headless agents use a scoped service token stored in
Bitwarden. Both paths go through the same Send Attempts record, idempotency keys and daily
send cap, so neither one can bypass the send safeguards. The stdio transport is removed.
Every agent reaches the inbox over HTTP.

**Argus deltas on top of the snapshot:**

- Every inbound message is forwarded to `FORWARD_ADDRESS` after the D1/R2 write. A
  forwarding failure is logged and never thrown, so it can't fail ingest.
- The UI is built from `deanjstone/design-system` registry components pinned at v2.5.0, with
  the same pin and guard as `apps/notice-board-web`. They replace upstream
  `src/components/ui`.
- AI drafting and auto-labels ship as code but are **disabled**. There is no Workers AI
  spend. Enabling them is a separate, later decision.

**Data:** a fresh D1 and R2. The existing messages are replayed from raw MIME through the
new inbound handler. The old `argus-agent-email` D1 and R2 stay read-only for 30 days and
are then deleted.

## Consequences

- People get a real inbox UI (threading, compose, search, push) on the same Cloudflare
  stack, with no new vendor and no new runtime.
- Two packages, two Workers, the REST-backed stdio store and its per-machine deploy go away.
  So does the `~/.argus/hooks/email-mcp-launch.sh` launch script that `argus-config` wires
  up. That registration needs removing from argus-config at cutover.
- Argus now owns a large vendored codebase whose upstream it does not follow. Upstream fixes
  have to be ported by hand when they matter. That cost was accepted for the reasons in
  option 3.
- `mail.myargus.cc` is the first app outside the `mcp.myargus.cc/<app>` taxonomy. Any later
  app that needs its own OAuth authorization server should follow this exception and use its
  own host, not a shared path prefix.
- The Access Bypass on `/mcp` and `/.well-known` means those paths rely entirely on the
  Worker's own OAuth and service-token checks. Tests for the auth layer carry that weight.
- Follow-up work is tracked as the task tickets under map
  [#518](https://github.com/deanjstone/argus/issues/518): vendoring (with the pnpm
  conversion), the design-system UI swap, forwarding, service-token auth, provisioning and
  deploy, the `agents@` cutover and replay, repointing Claude Code's email MCP in every
  environment, and retiring the old packages and resources.
