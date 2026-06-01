import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afkPaths, resolveRunSettings, collectMonitorInputs } from "../src/runtime/wire.js";

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "afk-wire-"));
}

describe("afkPaths", () => {
  it("derives the standard .red layout from a root", () => {
    const p = afkPaths("/repo");
    expect(p.tmpDir).toBe("/repo/.red/tmp");
    expect(p.stateDir).toBe("/repo/.red/state");
    expect(p.workersRoot).toBe("/repo/.red/tmp/workers");
    expect(p.historyPath).toBe("/repo/.red/state/afk-history.jsonl");
    expect(p.configPath).toBe("/repo/.red/config.yaml");
  });
});

describe("resolveRunSettings", () => {
  it("defaults sandbox to none and runner to claude with no config", () => {
    const root = scratch();
    try {
      const s = resolveRunSettings(root);
      expect(s.sandbox).toBe("none");
      expect(s.defaultRunner).toBe("claude");
      expect(s.model).toBe("claude-opus-4-8");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("defaults the model from the active runner", () => {
    const root = scratch();
    try {
      expect(resolveRunSettings(root, {}, "codex").model).toBe("gpt-5.5");
      expect(resolveRunSettings(root, {}, "claude").model).toBe("claude-opus-4-8");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reads afk.sandbox + afk.default_runner from .red/config.yaml", () => {
    const root = scratch();
    try {
      mkdirSync(join(root, ".red"), { recursive: true });
      writeFileSync(join(root, ".red", "config.yaml"), "afk:\n  sandbox: docker\n  default_runner: codex\n");
      const s = resolveRunSettings(root);
      expect(s.sandbox).toBe("docker");
      expect(s.defaultRunner).toBe("codex");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reads runner-specific model overrides before legacy afk.model", () => {
    const root = scratch();
    try {
      mkdirSync(join(root, ".red"), { recursive: true });
      writeFileSync(
        join(root, ".red", "config.yaml"),
        "afk:\n  model: shared-model\n  models:\n    codex: gpt-custom\n    claude: claude-custom\n",
      );
      expect(resolveRunSettings(root, {}, "codex").model).toBe("gpt-custom");
      expect(resolveRunSettings(root, {}, "claude").model).toBe("claude-custom");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("RED_AFK_SANDBOX env overrides the config sandbox", () => {
    const root = scratch();
    try {
      mkdirSync(join(root, ".red"), { recursive: true });
      writeFileSync(join(root, ".red", "config.yaml"), "afk:\n  sandbox: none\n");
      expect(resolveRunSettings(root, { RED_AFK_SANDBOX: "docker" }).sandbox).toBe("docker");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("an invalid RED_AFK_SANDBOX env falls back to the config sandbox", () => {
    const root = scratch();
    try {
      mkdirSync(join(root, ".red"), { recursive: true });
      writeFileSync(join(root, ".red", "config.yaml"), "afk:\n  sandbox: podman\n");
      expect(resolveRunSettings(root, { RED_AFK_SANDBOX: "bogus" }).sandbox).toBe("podman");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("falls back to none for an unknown sandbox token", () => {
    const root = scratch();
    try {
      mkdirSync(join(root, ".red"), { recursive: true });
      writeFileSync(join(root, ".red", "config.yaml"), "afk:\n  sandbox: bogus\n");
      expect(resolveRunSettings(root, {}).sandbox).toBe("none");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("leaves maxIterations undefined with no env and no config (→ DEFAULT_MAX_ITERATIONS)", () => {
    const root = scratch();
    try {
      expect(resolveRunSettings(root, {}).maxIterations).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reads afk.max_iterations from .red/config.yaml", () => {
    const root = scratch();
    try {
      mkdirSync(join(root, ".red"), { recursive: true });
      writeFileSync(join(root, ".red", "config.yaml"), "afk:\n  max_iterations: 50\n");
      expect(resolveRunSettings(root, {}).maxIterations).toBe(50);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("RED_AFK_MAX_ITERATIONS env overrides the config max_iterations", () => {
    const root = scratch();
    try {
      mkdirSync(join(root, ".red"), { recursive: true });
      writeFileSync(join(root, ".red", "config.yaml"), "afk:\n  max_iterations: 50\n");
      expect(resolveRunSettings(root, { RED_AFK_MAX_ITERATIONS: "80" }).maxIterations).toBe(80);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("an invalid env value falls back to the config max_iterations", () => {
    const root = scratch();
    try {
      mkdirSync(join(root, ".red"), { recursive: true });
      writeFileSync(join(root, ".red", "config.yaml"), "afk:\n  max_iterations: 42\n");
      expect(resolveRunSettings(root, { RED_AFK_MAX_ITERATIONS: "0" }).maxIterations).toBe(42);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("an invalid config value leaves maxIterations undefined (→ DEFAULT, never disabled)", () => {
    const root = scratch();
    try {
      mkdirSync(join(root, ".red"), { recursive: true });
      writeFileSync(join(root, ".red", "config.yaml"), "afk:\n  max_iterations: nope\n");
      expect(resolveRunSettings(root, {}).maxIterations).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("collectMonitorInputs", () => {
  it("returns no workers and no events on an empty root", async () => {
    const root = scratch();
    try {
      const { workers, events } = await collectMonitorInputs(root);
      expect(workers).toEqual([]);
      expect(events).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reads a worker state file into a CompactWorker", async () => {
    const root = scratch();
    try {
      const attemptDir = join(root, ".red", "tmp", "workers", "wAB12", "5-a1");
      mkdirSync(attemptDir, { recursive: true });
      writeFileSync(
        join(attemptDir, "afk.state.json"),
        JSON.stringify({ worker_id: "wAB12", pid: 999999, runner: "claude", total: 3, done: 1 }),
      );
      const { workers } = await collectMonitorInputs(root);
      expect(workers).toHaveLength(1);
      expect(workers[0]!.state.worker_id).toBe("wAB12");
      expect(workers[0]!.state.done).toBe(1);
      // pid 999999 is almost certainly dead → not live
      expect(workers[0]!.live).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
