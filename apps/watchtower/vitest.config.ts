import path from 'node:path'
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers'
import { defineConfig } from 'vitest/config'

// Two projects: the co-located src/**/*.test.ts unit tests are plain Node and
// must not pay for (or run inside) workerd's sandboxed runtime, while the
// test/ suite needs the real (simulated) D1 bindings only the workers pool
// provides. Previously the node tests ran under a separate `tsx --test`
// invocation chained ahead of vitest; one runner, one config now.
// Timeouts are raised above vitest's 5s/10s defaults for the same reason as
// apps/agent-engine: CI runs on 4-core self-hosted runners, and a merge to main
// can fire five workflows onto two runners at once. The workers project is the
// slow one — every test file re-applies the D1 migrations inside workerd — and
// checks-worker.test.ts hit the 5s default under that contention while passing
// comfortably when run alone. These still fail fast on a genuine hang.
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'node',
          include: ['src/**/*.test.ts'],
          testTimeout: 30_000,
          hookTimeout: 60_000,
        },
      },
      {
        plugins: [
          cloudflareTest(async () => {
            const migrationsPath = path.join(__dirname, 'migrations')
            const migrations = await readD1Migrations(migrationsPath)

            return {
              wrangler: { configPath: './wrangler.jsonc' },
              miniflare: {
                // Test-only binding so the setup file below can apply these
                // migrations before each test file runs against real
                // (simulated) D1 storage.
                bindings: { TEST_MIGRATIONS: migrations },
              },
            }
          }),
        ],
        test: {
          name: 'workers',
          include: ['test/**/*.test.ts'],
          setupFiles: ['./test/apply-migrations.ts'],
          testTimeout: 30_000,
          hookTimeout: 60_000,
        },
      },
    ],
  },
})
