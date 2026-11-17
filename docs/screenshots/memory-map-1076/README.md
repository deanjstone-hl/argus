---
summary: "Screenshots for argus#1076: the full-bleed void Memory map at 1280x900 and 390x844, on the 147-node fixture and a synthetic 2,200-memory store"
read_when:
  - "checking how the Memory map looks, or re-checking the void layout, heat and node cap from #1076"
---

# Memory map on the void (argus#1076)

From `apps/ops-hub-web/test/e2e/memory-map.test.ts` (`E2E_SCREENSHOTS=<dir> pnpm run e2e`): the real hub e2e
server, a production build and headless Chromium with software WebGL, reduced motion on (the orb holds still).
Nothing is deployed.

| File | Shows |
|---|---|
| `desktop-memory-map.png` | the 147-node recorded fixture: canvas fills the main area, controls are glass |
| `desktop-memory-map-live-sized.png` | a synthetic 2,200-memory store at the default cap: 600 memories, at most 1,600 edges |
| `desktop-memory-map-live-sized-all.png` | the same store with **All 2200** on |
| `desktop-memory-panel.png` | a memory open in the glass panel |
| `phone-memory-panel.png` | the panel as a bottom glass sheet above the tab bar |
