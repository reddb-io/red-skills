import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  afkPaths,
  resolveRunSettings,
  collectMonitorInputs,
  readFleetState,
  resolveAttemptGuardArming,
  buildMinimalBootDeps,
  withTimeout,
} from "../src/runtime/wire.js";
import { runBoot } from "../src/core/boot.js";

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "afk-wire-"));
}

describe("resolveAttemptGuardArming (issue #405)", () => {
  const dir = "/red/tmp/workers/w1/42-a1";

  it("arms the guard + lane-idle reaper under no-sandbox", () => {
    expect(resolveAttemptGuardArming({ sandbox: "none", branch: "afk/x/1", attemptDir: dir })).toEqual({
      guardArmed: true,
      laneArmed: true,
    });
  });

  it("arms the guard but NOT the lane-idle reaper under docker (host process tree is container-blind)", () => {
    expect(resolveAttemptGuardArming({ sandbox: "docker", branch: "afk/x/1", attemptDir: dir })).toEqual({
      guardArmed: true,
      laneArmed: false,
    });
  });

  it("arms the guard but NOT the lane-idle reaper under podman", () => {
    expect(resolveAttemptGuardArming({ sandbox: "podman", branch: "afk/x/1", attemptDir: dir })).toEqual({
      guardArmed: true,
      laneArmed: false,
    });
  });

  it("arms nothing without a worker branch (every mode)", () => {
    for (const sandbox of ["none", "docker", "podman"] as const) {
      expect(resolveAttemptGuardArming({ sandbox, branch: undefined, attemptDir: dir })).toEqual({
        guardArmed: false,
        laneArmed: false,
      });
    }
  });

  it("does not arm the lane-idle reaper without an attempt dir even under no-sandbox", () => {
    expect(resolveAttemptGuardArming({ sandbox: "none", branch: "afk/x/1", attemptDir: undefined })).toEqual({
      guardArmed: true,
      laneArmed: false,
    });
  });
});

describe("afkPaths", () => {
  it("derives the standard .red layout from a root", () => {
    const p = afkPaths("/repo");
    expect(p.tmpDir).toBe("/repo/.red/tmp");
    expect(p.stateDir).toBe("/repo/.red/state");
    expect(p.workersRoot).toBe("/repo/.red/tmp/workers");
    expect(p.historyPath).toBe("/repo/.red/state/afk-history.jsonl");
    expect(p.fleetStatePath).toBe("/repo/.red/tmp/afk-supervisor.state.json");
    expect(p.fleetFirehosePath).toBe("/repo/.red/tmp/afk-supervisor.log.jsonl");
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
      expect(s.effort).toBe("high");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("defaults the model from the active runner", () => {
    const root = scratch();
    try {
      expect(resolveRunSettings(root, {}, "codex").model).toBe("gpt-5.5");
      expect(resolveRunSettings(root, {}, "claude").model).toBe("claude-opus-4-8");
      expect(resolveRunSettings(root, {}, "codex").effort).toBe("high");
      expect(resolveRunSettings(root, {}, "claude").effort).toBe("high");
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

  // AFK runner improvement (Pattern 2): feedbackRebaseBase is undefined by
  // default (the rebase is OFF), resolves to "main" when the flag is on with
  // no lock, and to the config-locked branch when one is set. The
  // RED_AFK_FEEDBACK_REBASE=1 env knob forces it on without config.
  it("feedbackRebaseBase is undefined by default (rebase OFF)", () => {
    const root = scratch();
    try {
      expect(resolveRunSettings(root).feedbackRebaseBase).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("feedbackRebaseBase resolves to 'main' when afk.feedback.rebase_on_base is true", () => {
    const root = scratch();
    try {
      mkdirSync(join(root, ".red"), { recursive: true });
      writeFileSync(join(root, ".red", "config.yaml"), "afk:\n  feedback:\n    rebase_on_base: true\n");
      expect(resolveRunSettings(root).feedbackRebaseBase).toBe("main");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("feedbackRebaseBase resolves to the config-locked branch when set + flag on", () => {
    const root = scratch();
    try {
      mkdirSync(join(root, ".red"), { recursive: true });
      writeFileSync(
        join(root, ".red", "config.yaml"),
        "dev:\n  lock:\n    branch: release-2\nafk:\n  feedback:\n    rebase_on_base: true\n",
      );
      expect(resolveRunSettings(root).feedbackRebaseBase).toBe("release-2");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("RED_AFK_FEEDBACK_REBASE=1 forces the rebase base on without config", () => {
    const root = scratch();
    try {
      expect(resolveRunSettings(root, { RED_AFK_FEEDBACK_REBASE: "1" }).feedbackRebaseBase).toBe("main");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("the config-locked branch alone does NOT enable the rebase (flag must be on)", () => {
    const root = scratch();
    try {
      mkdirSync(join(root, ".red"), { recursive: true });
      writeFileSync(join(root, ".red", "config.yaml"), "dev:\n  lock:\n    branch: release-2\n");
      // No rebase_on_base flag → undefined even though a locked branch exists.
      expect(resolveRunSettings(root).feedbackRebaseBase).toBeUndefined();
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
      const { workers, events, fleet } = await collectMonitorInputs(root);
      expect(workers).toEqual([]);
      expect(events).toEqual([]);
      expect(fleet).toBeNull();
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

  it("reads the supervisor fleet state file for monitor rendering", async () => {
    const root = scratch();
    try {
      const path = afkPaths(root).fleetStatePath;
      mkdirSync(join(root, ".red", "tmp"), { recursive: true });
      writeFileSync(
        path,
        JSON.stringify({
          ts: "2026-05-30T11:00:00Z",
          epoch: 1780138800,
          ready_for_agent: 9,
          slots: { busy: 1, free: 2, total: 3, parked: 0 },
          spawns_this_tick: 1,
        }),
      );

      await expect(readFleetState(path)).resolves.toMatchObject({
        epoch: 1780138800,
        readyForAgent: 9,
        slotsBusy: 1,
        slotsFree: 2,
        slotsTotal: 3,
        spawnsThisTick: 1,
      });
      const { fleet } = await collectMonitorInputs(root);
      expect(fleet?.readyForAgent).toBe(9);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("withTimeout — bounded cold-cache refresh", () => {
  it("resolves with the promise value when it settles before the deadline", async () => {
    const result = await withTimeout(Promise.resolve(42), 500, -1);
    expect(result).toBe(42);
  });

  it("resolves with the fallback when the promise does not settle within the deadline", async () => {
    const never = new Promise<number>(() => { /* intentionally never resolves */ });
    const result = await withTimeout(never, 20, -1);
    expect(result).toBe(-1);
  });

  it("resolves with fallback when promise settles after the deadline (no unhandled rejection)", async () => {
    const lateResolve = new Promise<number>((resolve) => {
      setTimeout(() => resolve(99), 200);
    });
    const result = await withTimeout(lateResolve, 20, -1);
    expect(result).toBe(-1);
  });

  it("propagates rejection when the promise rejects before the deadline", async () => {
    const failing = Promise.reject(new Error("gh auth failed"));
    await expect(withTimeout(failing, 500, -1)).rejects.toThrow("gh auth failed");
  });

  it("returns fallback and avoids unhandled rejection when promise rejects after deadline", async () => {
    let lateReject!: (err: Error) => void;
    const lateRejecting = new Promise<number>((_, reject) => {
      lateReject = reject;
    });
    const result = await withTimeout(lateRejecting.catch(() => -1), 20, -1);
    lateReject(new Error("network gone"));
    expect(result).toBe(-1);
  });
});

describe("buildMinimalBootDeps — supervisor-owned-sweeps worker boot (#623)", () => {
  it("drives a real skipSweeps runBoot: bootstrap on disk, no sweep IO", async () => {
    const dir = scratch();
    try {
      const tmpDir = join(dir, ".red", "tmp");
      const deps = buildMinimalBootDeps({ root: dir, repo: "o/r", remote: "origin" }, 1_700_000_000);
      const result = await runBoot(deps, {
        precheck: {
          ghInstalled: true,
          ghAuthenticated: true,
          isGitRepo: true,
          remoteUrls: ["git@github.com:o/r.git"],
          hasMainBranch: true,
          currentBranch: "main",
          pnpmInstalled: true,
        },
        bootstrap: {
          tmpDir,
          stateDir: join(dir, ".red", "state"),
          gitignorePath: join(dir, ".gitignore"),
          workerDir: join(tmpDir, "workers", "wAAAA"),
          workerPidFile: join(tmpDir, "workers", "wAAAA", "worker.pid"),
          workerPid: 4242,
        },
        orphans: [],
        attemptCap: { byIssue: new Map() },
        branches: { snapshotRefs: [], remoteLiveRefs: [], localLiveRefs: [] },
        unblockCandidates: [],
        skipSweeps: true,
      });
      // Boot ran precheck + bootstrap then short-circuited; no sweep fields.
      expect(result.precheck.ok).toBe(true);
      expect(result.bootstrap).toEqual({ ok: true });
      expect(result.orphanCleanup).toBeUndefined();
      expect(result.straggler).toBeUndefined();
      // Bootstrap really wrote to disk (the real fs closures are wired).
      const { existsSync } = await import("node:fs");
      expect(existsSync(join(tmpDir, "workers", "wAAAA", "worker.pid"))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("throws if any sweep IO closure is invoked (guards a skip-boot regression)", async () => {
    const deps = buildMinimalBootDeps({ root: "/x", repo: "o/r", remote: "origin" }, 0);
    await expect(deps.gh.comment(1, "x")).rejects.toThrow(/skip-sweeps/);
    await expect(deps.lookups.blockerState(1)).rejects.toThrow(/skip-sweeps/);
    await expect(deps.lookups.straggler.unlabeled()).rejects.toThrow(/skip-sweeps/);
    expect(() => deps.lookups.branchIssue(1)).toThrow(/skip-sweeps/);
  });
});
