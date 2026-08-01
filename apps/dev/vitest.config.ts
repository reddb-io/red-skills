import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Dev tests + the shared-layer tests (packages/shared/*.test.ts).
    // The dev app carries the toolchain that runs the shared suite.
    include: ["tests/**/*.test.ts", "../../packages/shared/**/*.test.ts"],
    // Every test file reaches `redskilled` through a sandbox of its own (#2981):
    // "no daemon answers" has to be a fact about this process, not about the
    // machine the suite happens to run on.
    setupFiles: ["./tests/support/redskilled-isolation.ts"],
    environment: "node",
    pool: "forks",
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
