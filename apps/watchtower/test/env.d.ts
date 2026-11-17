import type { D1Migration } from 'cloudflare:test'

// TEST_MIGRATIONS is a test-only binding injected by vitest.config.ts (not a
// wrangler.jsonc binding, so it isn't in the generated worker-configuration.d.ts).
// `cloudflare:workers`'s `env` export is typed as `Cloudflare.Env`, not the
// bare global `Env` that `ExportedHandler<Env>` uses — augment the namespaced
// one so `env.TEST_MIGRATIONS` type-checks in the setup file and test file.
declare global {
  namespace Cloudflare {
    interface Env {
      TEST_MIGRATIONS: D1Migration[]
    }
  }
}
