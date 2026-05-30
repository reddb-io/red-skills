import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Dev tests + the shared-layer tests (src/shared/*.test.ts). The dev domain
    // carries the toolchain that runs the shared suite until src/shared self-tests.
    include: ["tests/**/*.test.ts", "../../shared/**/*.test.ts"],
    environment: "node",
    pool: "forks",
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
