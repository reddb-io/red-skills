import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Dev tests + the shared-layer tests (src/packages/shared/*.test.ts).
    // The dev app carries the toolchain that runs the shared suite.
    include: ["tests/**/*.test.ts", "../../packages/shared/**/*.test.ts"],
    environment: "node",
    pool: "forks",
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
