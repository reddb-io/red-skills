import { defineConfig } from "vitest/config";
import { integrationGlobs } from "./vitest.suites.js";

// #242: heavy integration suite. The RedDB-backed real-server / real-CLI tests
// and the latency-budget benchmark live here, run explicitly (or in CI), NOT in
// the AFK feedback loop. Forced single-fork + long timeouts so the real HTTP /
// MCP / CLI processes get a stable environment instead of fighting for cores.
export default defineConfig({
  test: {
    include: integrationGlobs(),
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
