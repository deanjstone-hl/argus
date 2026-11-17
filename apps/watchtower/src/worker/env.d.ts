// Secrets (wrangler secret put in a later live-provisioning phase), not
// wrangler.jsonc bindings, so they aren't in the generated
// worker-configuration.d.ts. Augmenting both the bare global Env and the
// namespaced Cloudflare.Env — same pattern as apps/memory-mcp/src/env.d.ts.
interface WatchtowerApiSecrets {
  WATCHTOWER_COLLECTOR_TOKEN?: string
}

// Both interfaces below are intentionally empty — this is TypeScript
// declaration merging (an `interface` augments the existing global `Env`
// via inheritance; a `type` alias can't merge this way), not a mistake.
// memory-mcp's identical pattern never hit this lint rule because that
// package has no ESLint config; watchtower's frontend does.
declare global {
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type
  interface Env extends WatchtowerApiSecrets {}
  namespace Cloudflare {
    // eslint-disable-next-line @typescript-eslint/no-empty-object-type
    interface Env extends WatchtowerApiSecrets {}
  }
}

export {}
