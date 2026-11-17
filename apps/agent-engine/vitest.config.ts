import { defineConfig } from 'vitest/config';

// Timeouts are raised well above vitest's 5s/10s defaults because CI runs on a
// 4-core self-hosted runner that executes two jobs concurrently, where the
// defaults are marginal rather than generous. The suite's slowest work is
// module transform and import — JobRoutes' beforeAll dynamically imports the
// whole HTTP server — which measured ~33s of import time under load, against a
// 10s hookTimeout. These values still fail fast on a genuine hang; they just
// stop a loaded machine being reported as a broken test.
export default defineConfig({
    test: {
        testTimeout: 30_000,
        hookTimeout: 60_000,
    },
});
