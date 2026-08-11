import { describe, expect, it } from "vitest";
import { encodeLines } from "@reddb-io/toon";
import {
  afkPaths,
  appendCastleHistoryRecord,
  buildMinimalBootDeps,
  castleStateSnapshotPath,
  collectMonitorInputs,
  collectStatuslineAfk,
  collectStatuslineDocs,
  collectStatuslineWorkers,
  createEnginePaths,
  decode,
  dirname,
  encode,
  existsSync,
  fakeBinDir,
  inferGitHubRepoSlug,
  join,
  mkdirSync,
  mkdtempSync,
  nowS,
  detachedSpawnRecorder,
  parseGitHubRepoSlugFromRemoteUrl,
  readFleetState,
  readFileSync,
  readToonCache,
  resolveAttemptProbeArming,
  resolveAttemptHead,
  resolveRunSettings,
  rmSync,
  runBoot,
  scratch,
  tmpdir,
  type ExecOutput,
  withTimeout,
  withFakeGh,
  writeCastleStateSnapshot,
  writeFileSync,
  writeRenderableAttempt,
} from "./wire.helpers.js";

describe("resolveAttemptProbeArming (issue #405)", () => {
  const dir = "/red/tmp/workers/w1/42-a1";

  it("arms the head probe + lane-idle reaper under no-sandbox", () => {
    expect(resolveAttemptProbeArming({ sandbox: "none", branch: "afk/x/1", attemptDir: dir })).toEqual({
      headProbeArmed: true,
      laneArmed: true,
    });
  });

  it("arms the head probe but NOT the lane-idle reaper under docker (host process tree is container-blind)", () => {
    expect(resolveAttemptProbeArming({ sandbox: "docker", branch: "afk/x/1", attemptDir: dir })).toEqual({
      headProbeArmed: true,
      laneArmed: false,
    });
  });

  it("arms the head probe but NOT the lane-idle reaper under podman", () => {
    expect(resolveAttemptProbeArming({ sandbox: "podman", branch: "afk/x/1", attemptDir: dir })).toEqual({
      headProbeArmed: true,
      laneArmed: false,
    });
  });

  it("arms nothing without a worker branch (every mode)", () => {
    for (const sandbox of ["none", "docker", "podman"] as const) {
      expect(resolveAttemptProbeArming({ sandbox, branch: undefined, attemptDir: dir })).toEqual({
        headProbeArmed: false,
        laneArmed: false,
      });
    }
  });

  it("does not arm the lane-idle reaper without an attempt dir even under no-sandbox", () => {
    expect(resolveAttemptProbeArming({ sandbox: "none", branch: "afk/x/1", attemptDir: undefined })).toEqual({
      headProbeArmed: true,
      laneArmed: false,
    });
  });
});

describe("resolveAttemptHead (#1390)", () => {
  const ok = (stdout = ""): ExecOutput => ({ code: 0, stdout, stderr: "" });
  const fail = (code = 1): ExecOutput => ({ code, stdout: "", stderr: "" });

  it("prefers the live worker worktree HEAD over a stale branch ref", async () => {
    const calls: string[][] = [];
    const exec = async (cmd: string, args: readonly string[]): Promise<ExecOutput> => {
      calls.push([cmd, ...args]);
      const joined = args.join(" ");
      if (joined === "worktree list --porcelain") {
        return ok(
          [
            "worktree /repo",
            "HEAD base",
            "branch refs/heads/main",
            "",
            "worktree /repo/.red/tmp/workers/w1/1390/worktree",
            "HEAD moved-head",
            "branch refs/heads/afk/w1/1390-loc",
            "",
          ].join("\n"),
        );
      }
      if (joined === "rev-parse --verify --quiet HEAD") return ok("moved-head\n");
      if (joined === "rev-parse --verify --quiet refs/heads/afk/w1/1390-loc") return ok("boot-base\n");
      return fail();
    };

    await expect(
      resolveAttemptHead(
        { cwd: "/repo/.red/tmp/workers/w1/1390", exec },
        "afk/w1/1390-loc",
      ),
    ).resolves.toBe("moved-head");
    expect(calls).toContainEqual(["git", "rev-parse", "--verify", "--quiet", "HEAD"]);
  });

  it("falls back to the branch ref when no registered worker worktree exists yet", async () => {
    const exec = async (_cmd: string, args: readonly string[]): Promise<ExecOutput> => {
      const joined = args.join(" ");
      if (joined === "worktree list --porcelain") return ok("worktree /repo\nbranch refs/heads/main\n");
      if (joined === "rev-parse --verify --quiet refs/heads/afk/w1/1390-loc") return ok("branch-head\n");
      return fail();
    };

    await expect(resolveAttemptHead({ cwd: "/repo/.red/tmp/workers/w1/1390-a1", exec }, "afk/w1/1390-loc")).resolves.toBe(
      "branch-head",
    );
  });
});

describe("afkPaths", () => {
  it("derives the standard .red layout from a root", () => {
    const p = afkPaths("/repo");
    expect(p.tmpDir).toBe("/repo/.red/tmp");
    expect(p.stateDir).toBe("/repo/.red/state");
    expect(p.workersRoot).toBe("/repo/.red/tmp/workers");
    expect(p.historyPath).toBe("/repo/.red/state/castle/history.toonl");
    // Live supervisor artifacts live in the singleton supervisor tmp lane.
    expect(p.fleetStatePath).toBe("/repo/.red/tmp/supervisors/default/state.toon");
    expect(p.fleetFirehosePath).toBe("/repo/.red/tmp/supervisors/default/supervisor.log.toonl");
    expect(p.monitorLogCursorPath).toBe("/repo/.red/tmp/supervisors/default/monitor-log-cursors.toon");
    expect(p.supervisorPidPath).toBe("/repo/.red/tmp/supervisors/default/afk-supervisor.pid");
    expect(p.runnerCircuitDir).toBe("/repo/.red/tmp/supervisors/default/runner-circuit");
    expect(p.statuslineGitCachePath).toBe("/repo/.red/state/statusline/statusline-git-cache.toon");
    // Scratch worktrees under the tmp worktrees lane.
    expect(p.landingWorktreesDir).toBe("/repo/.red/tmp/worktrees/landing");
    expect(p.reconcileWorktreesDir).toBe("/repo/.red/tmp/worktrees/reconcile");
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
      expect(s.model).toBe("claude-opus-5");
      expect(s.effort).toBe("high");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("defaults the model from the active runner", () => {
    const root = scratch();
    try {
      expect(resolveRunSettings(root, {}, "codex").model).toBe("gpt-5.6-sol");
      expect(resolveRunSettings(root, {}, "claude").model).toBe("claude-opus-5");
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
      writeFileSync(join(root, ".red", "config.yaml"), "plugins:\n  dev:\n    enabled: true\nafk:\n  sandbox: docker\n  default_runner: codex\n");
      const s = resolveRunSettings(root);
      expect(s.sandbox).toBe("docker");
      expect(s.defaultRunner).toBe("codex");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not expose the retired live-base feedback rebase setting", () => {
    const root = scratch();
    try {
      mkdirSync(join(root, ".red"), { recursive: true });
      writeFileSync(join(root, ".red", "config.yaml"), "plugins:\n  dev:\n    enabled: true\nafk:\n  feedback:\n    rebase_on_base: true\n");
      expect(resolveRunSettings(root, { RED_AFK_FEEDBACK_REBASE: "1" })).not.toHaveProperty("feedbackRebaseBase");
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
        "plugins:\n  dev:\n    enabled: true\nafk:\n  model: shared-model\n  models:\n    codex: gpt-custom\n    claude: claude-custom\n",
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
      writeFileSync(join(root, ".red", "config.yaml"), "plugins:\n  dev:\n    enabled: true\nafk:\n  sandbox: none\n");
      expect(resolveRunSettings(root, { RED_AFK_SANDBOX: "docker" }).sandbox).toBe("docker");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("an invalid RED_AFK_SANDBOX env falls back to the config sandbox", () => {
    const root = scratch();
    try {
      mkdirSync(join(root, ".red"), { recursive: true });
      writeFileSync(join(root, ".red", "config.yaml"), "plugins:\n  dev:\n    enabled: true\nafk:\n  sandbox: podman\n");
      expect(resolveRunSettings(root, { RED_AFK_SANDBOX: "bogus" }).sandbox).toBe("podman");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("falls back to none for an unknown sandbox token", () => {
    const root = scratch();
    try {
      mkdirSync(join(root, ".red"), { recursive: true });
      writeFileSync(join(root, ".red", "config.yaml"), "plugins:\n  dev:\n    enabled: true\nafk:\n  sandbox: bogus\n");
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
      writeFileSync(join(root, ".red", "config.yaml"), "plugins:\n  dev:\n    enabled: true\nafk:\n  max_iterations: 50\n");
      expect(resolveRunSettings(root, {}).maxIterations).toBe(50);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("RED_AFK_MAX_ITERATIONS env overrides the config max_iterations", () => {
    const root = scratch();
    try {
      mkdirSync(join(root, ".red"), { recursive: true });
      writeFileSync(join(root, ".red", "config.yaml"), "plugins:\n  dev:\n    enabled: true\nafk:\n  max_iterations: 50\n");
      expect(resolveRunSettings(root, { RED_AFK_MAX_ITERATIONS: "80" }).maxIterations).toBe(80);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("an invalid env value falls back to the config max_iterations", () => {
    const root = scratch();
    try {
      mkdirSync(join(root, ".red"), { recursive: true });
      writeFileSync(join(root, ".red", "config.yaml"), "plugins:\n  dev:\n    enabled: true\nafk:\n  max_iterations: 42\n");
      expect(resolveRunSettings(root, { RED_AFK_MAX_ITERATIONS: "0" }).maxIterations).toBe(42);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("an invalid config value leaves maxIterations undefined (→ DEFAULT, never disabled)", () => {
    const root = scratch();
    try {
      mkdirSync(join(root, ".red"), { recursive: true });
      writeFileSync(join(root, ".red", "config.yaml"), "plugins:\n  dev:\n    enabled: true\nafk:\n  max_iterations: nope\n");
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
      // pid process.pid → the worker is live, so it survives the monitor's
      // renderableLive gate (#1219: the dashboard now drops dead/stale rows;
      // dead-worker filtering is covered by worker-state-reader's isRenderableLive suite).
      writeFileSync(
        join(attemptDir, "afk.state.toon"),
        JSON.stringify({ worker_id: "wAB12", pid: process.pid, runner: "claude", total: 3, done: 1 }),
      );
      const workerLog = join(dirname(attemptDir), "worker.log.toonl");
      const lane = encodeLines({ trailer: false });
      writeFileSync(
        workerLog,
        lane.push({ at: "2026-08-04T00:00:00Z", kind: "worker.log", msg: "a" })
          + lane.push({ at: "2026-08-04T00:00:01Z", kind: "worker.log", msg: "b" }),
      );
      const { workers } = await collectMonitorInputs(root);
      expect(workers).toHaveLength(1);
      expect(workers[0]!.state.worker_id).toBe("wAB12");
      expect(workers[0]!.state.done).toBe(1);
      expect(workers[0]!.logLines).toBe(2);
      expect(workers[0]!.logNewLines).toBe(2);
      // `.live` (= active) needs the full lane-fresh "alive" verdict, stricter than
      // the renderableLive render-gate — a bare process.pid worker renders but is not active.
      expect(workers[0]!.live).toBe(false);

      const lane2 = encodeLines({ trailer: false });
      writeFileSync(
        workerLog,
        lane2.push({ at: "2026-08-04T00:00:00Z", kind: "worker.log", msg: "a" })
          + lane2.push({ at: "2026-08-04T00:00:01Z", kind: "worker.log", msg: "b" })
          + lane2.push({ at: "2026-08-04T00:00:02Z", kind: "worker.log", msg: "c" }),
      );
      const again = await collectMonitorInputs(root);
      expect(again.workers[0]!.logLines).toBe(3);
      expect(again.workers[0]!.logNewLines).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("prefers castle snapshots and history for monitor inputs", async () => {
    const root = scratch();
    try {
      const paths = createEnginePaths(join(root, ".red"));
      await writeCastleStateSnapshot(
        castleStateSnapshotPath(paths, "worker", "wCA12"),
        {
          kind: "worker",
          id: "wCA12",
          version: 1,
          updated_at: "2026-07-16T20:02:00.000Z",
          worker_id: "wCA12",
          runner: "codex",
          pid: process.pid,
          started_at: "2026-07-16T20:00:00.000Z",
          current: {
            number: 1915,
            title: "flip monitor",
            activity: "impl",
            started_at: "2026-07-16T20:01:00.000Z",
            origin: "afk",
            total: 2,
            done: 1,
            loc_added: 7,
            loc_removed: 3,
          },
          queue: [1915],
          completed: [1902],
        },
      );
      await appendCastleHistoryRecord(paths.castleHistory, {
        ts: "2026-07-16T20:03:00.000Z",
        epoch: 1784232180,
        worker: "wCA12",
        issue: 1902,
        event: "done",
        duration_s: 12,
        runner: "codex",
      });

      const { workers, events } = await collectMonitorInputs(root);
      expect(workers).toHaveLength(1);
      expect(workers[0]!.state.worker_id).toBe("wCA12");
      expect(workers[0]!.state.current.number).toBe(1915);
      expect(workers[0]!.state.done).toBe(1);
      expect(workers[0]!.diffAdded).toBe(7);
      expect(workers[0]!.diffRemoved).toBe(3);
      expect(events).toEqual([{ event: "done", epoch: 1784232180 }]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("collapses retained attempt dirs to one current worker row", async () => {
    const root = scratch();
    try {
      writeRenderableAttempt(root, "wDED", 1775, "2026-07-06T10:00:00Z");
      writeRenderableAttempt(root, "wDED", 1789, "2026-07-06T10:05:00Z");
      writeRenderableAttempt(root, "wDED", 1802, "2026-07-06T10:10:00Z");
      writeRenderableAttempt(root, "wDED", 1811, "2026-07-06T10:15:00Z");

      const { workers } = await collectMonitorInputs(root);
      expect(workers.map((w) => w.state.current.number)).toEqual([1811]);
      expect(workers).toHaveLength(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("statusline worker rows collapse retained attempt dirs to the current attempt", async () => {
    const root = scratch();
    try {
      writeRenderableAttempt(root, "wDED", 1775, "2026-07-06T10:00:00Z");
      writeRenderableAttempt(root, "wDED", 1789, "2026-07-06T10:05:00Z");
      writeRenderableAttempt(root, "wDED", 1802, "2026-07-06T10:10:00Z");
      writeRenderableAttempt(root, "wDED", 1811, "2026-07-06T10:15:00Z");

      const workers = await collectStatuslineWorkers({ root, repo: "reddb-io/red-skills", remote: "origin" });
      expect(workers.map((w) => w.state.current.number)).toEqual([1811]);
      expect(workers).toHaveLength(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("statusline worker rows carry the declared gate child facts (#3182)", async () => {
    const root = scratch();
    try {
      const startedAt = new Date(Date.now() - 300_000).toISOString();
      const attemptDir = writeRenderableAttempt(root, "wGATE", 3182, startedAt);
      writeFileSync(join(attemptDir, "afk.state.toon"), JSON.stringify({
        worker_id: "wGATE",
        pid: process.pid,
        runner: "codex",
        started_at: startedAt,
        current: {
          number: 3182,
          title: "gate wait",
          phase: "validating",
          activity: "review",
          started_at: startedAt,
          wait_kind: "gate",
          wait_subject: "pnpm test",
          wait_pid: 9001,
          wait_started_at: startedAt,
          wait_deadline: "process exit",
          wait_escalation: "fail the validation stage",
        },
      }));

      const workers = await collectStatuslineWorkers({ root, repo: "reddb-io/red-skills", remote: "origin" });

      expect(workers[0]!.state.current).toMatchObject({
        wait_kind: "gate",
        wait_subject: "pnpm test",
        wait_pid: 9001,
        wait_started_at: startedAt,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reads the supervisor fleet state file for monitor rendering", async () => {
    const root = scratch();
    try {
      const path = afkPaths(root).fleetStatePath;
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(
        path,
        JSON.stringify({
          ts: "2026-05-30T11:00:00Z",
          epoch: 1780138800,
          ready_for_agent: 9,
          slots: { busy: 1, free: 2, total: 3, parked: 0 },
          spawns_this_tick: 1,
          churn: { deaths: 2, respawns: 1, window_s: 300 },
        }),
      );

      await expect(readFleetState(path)).resolves.toMatchObject({
        epoch: 1780138800,
        readyForAgent: 9,
        slotsBusy: 1,
        slotsFree: 2,
        slotsTotal: 3,
        spawnsThisTick: 1,
        churnDeaths: 2,
        churnRespawns: 1,
        churnWindowS: 300,
      });
      const { fleet } = await collectMonitorInputs(root);
      expect(fleet?.readyForAgent).toBe(9);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
