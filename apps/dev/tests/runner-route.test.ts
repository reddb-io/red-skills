import { describe, expect, it } from "vitest";

import { runners } from "@reddb-io/red-castle/engine";

import { AFK_MODEL_TIERS, CONFIG_DEFAULTS, loadConfig, resolveTaskRoute, resolveTier } from "../src/core/config.js";

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

  it("reports flag, env, file, and project_start precedence without a silent winner", () => {
    const values = loadConfig("/repo/.red/config.yaml", {
      ignoreActivationGate: true,
      read: () => [
        "plugins:",
        "  dev:",
        "    afk:",
        "      routes:",
        "        complex:",
        "          runner: hermes",
        "          model: route-model",
        "          effort: medium",
        "",
      ].join("\n"),
    });

    expect(resolveTaskRoute(values, "complex", {
      flagRunner: "codex",
      projectStartRunner: "claude",
      env: { RED_AFK_RUNNER: "opencode", RED_AFK_MODEL: "runtime-model" },
    })).toMatchObject({
      runner: "codex",
      model: "runtime-model",
      effort: "medium",
      origins: { runner: "flag", model: "env", effort: "file" },
    });

    expect(resolveTaskRoute(values, "complex", { projectStartRunner: "claude" })).toMatchObject({
      runner: "claude",
      origins: { runner: "project_start" },
    });
  });

  it("ships an explicit current table for every supported runner", () => {
    for (const runner of runners) {
      for (const tier of AFK_MODEL_TIERS) {
        expect(CONFIG_DEFAULTS[`afk.models.${runner}.${tier}.model` as keyof typeof CONFIG_DEFAULTS]).toBeTruthy();
        expect(CONFIG_DEFAULTS[`afk.models.${runner}.${tier}.effort` as keyof typeof CONFIG_DEFAULTS]).toBeTruthy();
      }
    }

    expect(resolveTier(CONFIG_DEFAULTS, "hermes", "think")).toEqual({ model: "claude-opus-5", effort: "high" });
    expect(resolveTier(CONFIG_DEFAULTS, "claude-minimax", "think")).toEqual({ model: "MiniMax-M3", effort: "low" });
    for (const tier of AFK_MODEL_TIERS) {
      expect(resolveTier(CONFIG_DEFAULTS, "claude", tier)).toEqual({ model: "claude-opus-5", effort: "high" });
      expect(resolveTier(CONFIG_DEFAULTS, "codex", tier)).toEqual({ model: "gpt-5.6-sol", effort: "high" });
    }
  });
});
