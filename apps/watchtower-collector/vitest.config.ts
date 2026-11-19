import { defineConfig } from 'vitest/config'

// Module tests are co-located in src/; test/ holds the deploy.sh suite. Scoped to these two
// so the compiled copies under dist/ aren't collected as a second, broken suite.
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
  },
})
