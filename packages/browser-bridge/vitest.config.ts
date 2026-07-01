import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["*.test.ts"],
    environment: "node",
    pool: "forks",
    testTimeout: 15_000,
  },
});
