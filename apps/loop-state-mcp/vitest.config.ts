import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // Matches ops-hub: a loaded self-hosted CI runner overruns vitest's 5s default (argus#535).
    testTimeout: 20_000,
    // Hooks get the same budget: a stalled runner failed deploy.test.ts's mkdtemp
    // beforeEach at vitest's 10s default (argus#1192).
    hookTimeout: 20_000,
  },
})
