import { describe, expect, it } from "vitest";

import { loadConfig, resolveTaskRoute } from "../src/core/config.js";

describe("AFK task-class runner routes", () => {
  it("selects the runner for a task class and resolves that runner's tier defaults", () => {
    const values = loadConfig("/repo/.red/config.yaml", {
      ignoreActivationGate: true,
      read: () => [
        "plugins:",
        "  dev:",
        "    afk:",
        "      routes:",
        "        simple:",
        "          runner: codex",
        "",
      ].join("\n"),
    });

    expect(resolveTaskRoute(values, "simple")).toEqual({
      taskClass: "simple",
      runner: "codex",
      model: "gpt-5.6-sol",
      effort: "high",
      origins: {
        runner: "file",
        model: "default",
        effort: "default",
      },
    });
  });
});
