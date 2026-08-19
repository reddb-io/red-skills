import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // The brain STORE engine is a package now (ADR 0152, #4026), because the
    // daemon holds it too. Its tests are co-located with it and run here, the
    // way `apps/dev` runs the `packages/github` suites.
    include: ["tests/**/*.test.ts", "../../packages/brain-store/**/*.test.ts"],
    testTimeout: 10_000,
    hookTimeout: 10_000,
  },
});
