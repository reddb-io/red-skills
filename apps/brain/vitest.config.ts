import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    // dashboard.test.ts spawns the brain CLI via `tsx` (compile + store open +
    // HTML build), bounded by its own 40s subprocess `TIMEOUT`. Vitest's default
    // 5s per-test timeout trips first under load (e.g. an AFK feedback-gate run
    // sharing the box with a live agent), false-failing a healthy test. Give the
    // test body more room than the subprocess so the subprocess timeout is the
    // real bound; pure-unit tests still finish in ms.
    testTimeout: 45_000,
    hookTimeout: 45_000,
  },
});
