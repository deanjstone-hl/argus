import { defineConfig } from "oxlint";

export default defineConfig({
  // links.ts and links-core.ts are vendored from the frontend registry (scripts/vendor-links.sh);
  // a lint fix here would be overwritten by the next vendoring.
  ignorePatterns: ["**/node_modules/**", "**/dist/**", ".wrangler/**", "worker-configuration.d.ts", "src/lib/links.ts", "src/lib/links-core.ts"],
  jsPlugins: [{ name: "anti-slop", specifier: "../../tools/oxlint/anti-slop/index.ts" }],
  plugins: ["typescript", "react"],
  rules: {
    "typescript/no-floating-promises": "error",
    // Existing code predates these rules and ESLint never enforced them here, so
    // they report as warnings until the backlog is cleared.
    "anti-slop/no-chained-type-assertions": "warn",
    "anti-slop/no-widen-then-assert": "warn",
    "anti-slop/no-conditional-empty-object-spread": "warn",
    // Carried over from the ESLint config: react-hooks (recommended) and react-refresh.
    "react/rules-of-hooks": "error",
    "react/exhaustive-deps": "warn",
    "react/only-export-components": ["warn", { allowConstantExport: true }],
  },
  overrides: [
    {
      files: ["**/*.test.{ts,tsx}", "**/test/**"],
      rules: { "anti-slop/no-module-mocking": "warn" },
    },
    {
      // Vendored from the design-system registry: `button` and `badge` export their
      // `*Variants` helpers next to the component, and the next `shadcn add` would
      // overwrite any edit made here.
      files: ["src/components/ui/**/*.{ts,tsx}"],
      rules: { "react/only-export-components": "off" },
    },
  ],
});
