import { defineConfig } from "vitest/config";
import { integrationGlobs } from "./vitest.suites.js";

// Heavy subprocess/resident coverage. Run explicitly, not as the AFK feedback
// package test gate.
export default defineConfig({
  test: {
    include: integrationGlobs(),
    // This suite exercises subprocess and resident boundaries. An unhandled
    // error is a gate failure even when every assertion happened to finish.
    dangerouslyIgnoreUnhandledErrors: false,
    environment: "node",
    pool: "forks",
    poolOptions: {
      forks: { singleFork: true },
    },
    fileParallelism: false,
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
