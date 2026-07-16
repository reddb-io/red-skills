import { defineConfig } from "vitest/config";
import { integrationGlobs } from "./vitest.suites.js";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    exclude: integrationGlobs(),
    environment: "node",
    pool: "forks",
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
