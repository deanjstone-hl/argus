import { defineConfig } from 'vitest/config'

// Tests are co-located with the modules they cover. Scoped to src/ so the
// compiled copies under dist/ aren't collected as a second, broken suite.
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
  },
})
