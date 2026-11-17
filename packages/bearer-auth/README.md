# bearer-auth

`checkBearer(header, secret)`: the one inbound bearer check for the Workers and Node services.
It is constant-time (both sides are SHA-256 digested through `crypto.subtle`, so it needs no
`nodejs_compat` on Workers) and fails closed: an unset or empty secret returns `false`.
`timingSafeEqual(a, b)` is the same comparison for credentials that are not `Bearer` headers.

Consumed by `apps/watchtower` (`POST /checks`) and `apps/watchtower-usage-shim`.
`deanjstone/memory-mcp` carries its own vendored copy.

## Plain JS, not TypeScript

`src/index.js` plus a hand-written `src/index.d.ts`. The usage shim runs its compiled output on
plain Node, so it cannot load a source-only `.ts` dependency the way `watchtower-contract` is
consumed. The Workers
bundle the `.js` as it is.

## Run

```bash
pnpm run typecheck
pnpm test
```

## Deploy

Not deployed on its own. It ships inside the services that import it.
