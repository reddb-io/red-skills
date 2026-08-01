import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    pool: "forks",
    // The fake daemon binds a real unix socket per test file; running the files
    // in parallel would race on the shared runtime directory they derive.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
