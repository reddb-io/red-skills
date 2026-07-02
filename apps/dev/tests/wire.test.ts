import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  afkPaths,
  resolveRunSettings,
  collectMonitorInputs,
  readFleetState,
  resolveAttemptGuardArming,
  resolveAttemptBudget,
  buildMinimalBootDeps,
  withTimeout,
  collectStatuslineAfk,
  collectStatuslineRepo,
  STATUSLINE_CACHE_TTL_S,
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

describe("resolveAttemptBudget (#908)", () => {
  const cfg = (m: Record<string, string>) => (key: string) => m[key] ?? "";
  it("returns undefined when no ceiling is set anywhere (inert)", () => {
    expect(resolveAttemptBudget({}, cfg({}))).toBeUndefined();
  });
  it("reads ceilings from afk.attempt.* config", () => {
    const b = resolveAttemptBudget(
      {},
      cfg({
        "afk.attempt.max_tokens": "500000",
        "afk.attempt.max_cost_usd": "5",
        "afk.attempt.max_tool_calls": "200",
        "afk.attempt.max_waiting_windows": "30",
      }),
    );
    expect(b).toEqual({ maxTotalTokens: 500000, maxCostUsd: 5, maxToolCalls: 200, maxWaitingWindows: 30 });
  });
  it("env overrides config", () => {
    const b = resolveAttemptBudget(
      { RED_AFK_ATTEMPT_MAX_TOOL_CALLS: "150" } as NodeJS.ProcessEnv,
      cfg({ "afk.attempt.max_tool_calls": "999" }),
    );
    expect(b?.maxToolCalls).toBe(150);
  });
  it("rejects non-positive / non-numeric ceilings (typo never sets a 0 cap)", () => {
    expect(resolveAttemptBudget({}, cfg({ "afk.attempt.max_tokens": "0" }))).toBeUndefined();
    expect(resolveAttemptBudget({}, cfg({ "afk.attempt.max_tool_calls": "abc" }))).toBeUndefined();
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
      writeFileSync(join(attemptDir, "afk.log"), "a\nb\n");
      const { workers } = await collectMonitorInputs(root);
      expect(workers).toHaveLength(1);
      expect(workers[0]!.state.worker_id).toBe("wAB12");
      expect(workers[0]!.state.done).toBe(1);
      expect(workers[0]!.logLines).toBe(2);
      expect(workers[0]!.logNewLines).toBe(2);
      // pid 999999 is almost certainly dead → not live
      expect(workers[0]!.live).toBe(false);

      writeFileSync(join(attemptDir, "afk.log"), "a\nb\nc\n");
      const again = await collectMonitorInputs(root);
      expect(again.workers[0]!.logLines).toBe(3);
      expect(again.workers[0]!.logNewLines).toBe(1);
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

// ---------------------------------------------------------------------------
// Helpers shared by the cache-discipline suites below.
// ---------------------------------------------------------------------------

/** Write a fake `gh` script to a temp dir and return its path. The script
 * outputs `[]` for any invocation so all count functions return 0 quickly. */
function fakeBinDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "fake-gh-"));
  writeFileSync(join(dir, "gh"), "#!/bin/sh\necho '[]'\n", { mode: 0o755 });
  return dir;
}

/** Run `fn` with a fake `gh` binary prepended to PATH, then restore PATH. */
async function withFakeGh<T>(fn: () => Promise<T>): Promise<T> {
  const dir = fakeBinDir();
  const orig = process.env.PATH;
  process.env.PATH = `${dir}:${orig ?? ""}`;
  try {
    return await fn();
  } finally {
    process.env.PATH = orig;
    rmSync(dir, { recursive: true, force: true });
  }
}

function nowS(): number {
  return Math.floor(Date.now() / 1000);
}

// ---------------------------------------------------------------------------
// collectStatuslineAfk — cache discipline (#818)
// ---------------------------------------------------------------------------

describe("collectStatuslineAfk — cache discipline", () => {
  it("cold cache: awaits gh + writes cache before returning", async () => {
    const root = mkdtempSync(join(tmpdir(), "afk-sl-afk-"));
    try {
      const tmpDir = join(root, ".red", "tmp");
      mkdirSync(tmpDir, { recursive: true });
      const cachePath = join(tmpDir, "statusline-cache.json");

      const before = nowS();
      await withFakeGh(() => collectStatuslineAfk({ root, repo: "", remote: "origin" }));

      const cache = JSON.parse(readFileSync(cachePath, "utf8")) as { queue: number; human: number; ts: number };
      expect(cache.ts).toBeGreaterThanOrEqual(before);
      expect(cache.queue).toBe(0); // fake gh returns []
      expect(cache.human).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("stale cache: awaits gh + rewrites cache before returning", async () => {
    const root = mkdtempSync(join(tmpdir(), "afk-sl-afk-"));
    try {
      const tmpDir = join(root, ".red", "tmp");
      mkdirSync(tmpDir, { recursive: true });
      const cachePath = join(tmpDir, "statusline-cache.json");

      const staleTs = nowS() - STATUSLINE_CACHE_TTL_S - 10;
      writeFileSync(cachePath, JSON.stringify({ queue: 5, human: 3, ts: staleTs }), "utf8");

      await withFakeGh(() => collectStatuslineAfk({ root, repo: "", remote: "origin" }));

      const cache = JSON.parse(readFileSync(cachePath, "utf8")) as { queue: number; human: number; ts: number };
      expect(cache.ts).toBeGreaterThan(staleTs); // ts advanced beyond the stale value
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fresh cache: read without a gh refresh (ts and values unchanged)", async () => {
    const root = mkdtempSync(join(tmpdir(), "afk-sl-afk-"));
    try {
      const tmpDir = join(root, ".red", "tmp");
      mkdirSync(tmpDir, { recursive: true });
      const cachePath = join(tmpDir, "statusline-cache.json");

      const freshTs = nowS();
      writeFileSync(cachePath, JSON.stringify({ queue: 7, human: 2, ts: freshTs }), "utf8");

      // Fake gh outputs a distinct count (3 items) so a call would change the
      // cached value from 7 → 3; if ts/queue stay the same, gh was not called.
      const dir = fakeBinDir();
      writeFileSync(join(dir, "gh"), "#!/bin/sh\necho '[{\"number\":1},{\"number\":2},{\"number\":3}]'\n", { mode: 0o755 });
      const orig = process.env.PATH;
      process.env.PATH = `${dir}:${orig ?? ""}`;
      try {
        await collectStatuslineAfk({ root, repo: "", remote: "origin" });
      } finally {
        process.env.PATH = orig;
        rmSync(dir, { recursive: true, force: true });
      }

      const cache = JSON.parse(readFileSync(cachePath, "utf8")) as { queue: number; human: number; ts: number };
      expect(cache.ts).toBe(freshTs); // ts unchanged → no write
      expect(cache.queue).toBe(7); // cached value preserved
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("0 live workers: still refreshes stale cache before returning null", async () => {
    const root = mkdtempSync(join(tmpdir(), "afk-sl-afk-"));
    try {
      const tmpDir = join(root, ".red", "tmp");
      mkdirSync(tmpDir, { recursive: true });
      const cachePath = join(tmpDir, "statusline-cache.json");

      const staleTs = nowS() - STATUSLINE_CACHE_TTL_S - 10;
      writeFileSync(cachePath, JSON.stringify({ queue: 9, human: 1, ts: staleTs }), "utf8");

      const result = await withFakeGh(() =>
        collectStatuslineAfk({ root, repo: "", remote: "origin" }),
      );

      expect(result).toBeNull(); // 0 workers → null
      const cache = JSON.parse(readFileSync(cachePath, "utf8")) as { ts: number };
      expect(cache.ts).toBeGreaterThan(staleTs); // refreshed despite 0 workers
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("counts a pid-live worker even when its activity is stale (#836)", async () => {
    const root = mkdtempSync(join(tmpdir(), "afk-sl-afk-"));
    try {
      const tmpDir = join(root, ".red", "tmp");
      mkdirSync(tmpDir, { recursive: true });
      // Fresh gh cache → collectStatuslineAfk makes no gh call.
      writeFileSync(join(tmpDir, "statusline-cache.json"), JSON.stringify({ queue: 0, human: 0, ts: nowS() }), "utf8");

      // A worker whose orchestrator process is ALIVE (pid resolves) but whose
      // agent-stream activity froze long ago — exactly a long feedback-gate /
      // build phase, after the heartbeat stops at post_attempt. Pre-#836 this was
      // dropped (isStateActive freshness gate) and line 2 vanished mid-test.
      const stale = new Date(Date.now() - 2 * 3600 * 1000).toISOString();
      const dir = join(tmpDir, "workers", "wQ", "55-a1");
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, "afk.state.json"),
        JSON.stringify({
          pid: process.pid, // alive
          current: {
            number: 55,
            stage: "tests",
            started_at: stale,
            last_event_at: stale,
            last_commit_at: stale,
            loc_added: 5, // non-zero → no live git diffstat fallback (hermetic)
            loc_removed: 1,
          },
        }),
        "utf8",
      );

      const result = await collectStatuslineAfk({ root, repo: "", remote: "origin" });
      expect(result).not.toBeNull(); // pid-live worker keeps line 2 alive despite stale activity
      expect(result!.workers).toBe(1);
      expect(result!.issues).toContain(55);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// collectStatuslineRepo — cache discipline (#818)
// ---------------------------------------------------------------------------

describe("collectStatuslineRepo — cache discipline", () => {
  it("stale cache: awaits gh + rewrites cache before returning", async () => {
    const root = mkdtempSync(join(tmpdir(), "afk-sl-repo-"));
    try {
      const tmpDir = join(root, ".red", "tmp");
      mkdirSync(tmpDir, { recursive: true });
      const cachePath = join(tmpDir, "statusline-repo-cache.json");

      const staleTs = nowS() - STATUSLINE_CACHE_TTL_S - 10;
      writeFileSync(cachePath, JSON.stringify({ openPrs: 3, openIssues: 5, ts: staleTs }), "utf8");

      await withFakeGh(() => collectStatuslineRepo({ root, repo: "", remote: "origin" }));

      const cache = JSON.parse(readFileSync(cachePath, "utf8")) as { openPrs: number; openIssues: number; ts: number };
      expect(cache.ts).toBeGreaterThan(staleTs); // ts advanced beyond the stale value
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fresh cache: read without a gh refresh (ts unchanged)", async () => {
    const root = mkdtempSync(join(tmpdir(), "afk-sl-repo-"));
    try {
      const tmpDir = join(root, ".red", "tmp");
      mkdirSync(tmpDir, { recursive: true });
      const cachePath = join(tmpDir, "statusline-repo-cache.json");

      const freshTs = nowS();
      writeFileSync(cachePath, JSON.stringify({ openPrs: 4, openIssues: 10, ts: freshTs }), "utf8");

      await withFakeGh(() => collectStatuslineRepo({ root, repo: "", remote: "origin" }));

      const cache = JSON.parse(readFileSync(cachePath, "utf8")) as { openPrs: number; openIssues: number; ts: number };
      expect(cache.ts).toBe(freshTs); // ts unchanged → no write
      expect(cache.openPrs).toBe(4);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// collectMonitorInputs — layout discovery (#1029)
// Both sandcastle and legacy layouts put afk.state.json at the same path
// ({workersRoot}/{workerID}/{attemptDir}/afk.state.json) — the difference is
// where the git worktree lives. This suite verifies both layouts are discovered
// by the Worker state reader, satisfying the "no monitor-private globbing" contract.
// ---------------------------------------------------------------------------

describe("collectMonitorInputs — layout discovery (#1029)", () => {
  it("discovers a sandcastle-layout worker (state at attemptDir/afk.state.json, worktree absent pre-heartbeat)", async () => {
    const root = scratch();
    try {
      // Sandcastle layout: state file at the standard path; worktree field not yet
      // set (simulates the pre-heartbeat window where current.worktree = "").
      const attemptDir = join(root, ".red", "tmp", "workers", "wSC", "42-a1");
      mkdirSync(attemptDir, { recursive: true });
      writeFileSync(
        join(attemptDir, "afk.state.json"),
        JSON.stringify({ worker_id: "wSC", pid: 999999, runner: "claude", total: 5, done: 2 }),
      );
      const { workers } = await collectMonitorInputs(root);
      // The worker must appear in the output — sandcastle layout does not hide the
      // state file from the Worker state reader.
      expect(workers).toHaveLength(1);
      expect(workers[0]!.state.worker_id).toBe("wSC");
      expect(workers[0]!.state.done).toBe(2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("discovers a legacy-layout worker (state at attemptDir/afk.state.json, worktree at attemptDir/worktree)", async () => {
    const root = scratch();
    try {
      const attemptDir = join(root, ".red", "tmp", "workers", "wLG", "7-a1");
      mkdirSync(attemptDir, { recursive: true });
      // Legacy layout: current.worktree points to {attemptDir}/worktree (doesn't
      // exist here; git call fails gracefully, diffstat returns 0,0 safely).
      writeFileSync(
        join(attemptDir, "afk.state.json"),
        JSON.stringify({
          worker_id: "wLG",
          pid: 999999,
          runner: "codex",
          total: 3,
          done: 0,
          current: { worktree: join(attemptDir, "worktree") },
        }),
      );
      const { workers } = await collectMonitorInputs(root);
      expect(workers).toHaveLength(1);
      expect(workers[0]!.state.worker_id).toBe("wLG");
      // Diffstat gracefully returns 0,0 when worktree path does not exist — no crash.
      expect(workers[0]!.diffAdded).toBe(0);
      expect(workers[0]!.diffRemoved).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("a live worker under the sandcastle layout renders in the dashboard (not 'workers: none')", async () => {
    const root = scratch();
    try {
      // Use process.pid so isStateLive → true (pid is alive).
      const attemptDir = join(root, ".red", "tmp", "workers", "wLIVE", "99-a1");
      mkdirSync(attemptDir, { recursive: true });
      const stateFile = join(attemptDir, "afk.state.json");
      writeFileSync(
        stateFile,
        JSON.stringify({
          worker_id: "wLIVE",
          pid: process.pid,
          runner: "claude",
          total: 1,
          done: 0,
          current: { number: 99, title: "test issue", stage: "impl", started_at: new Date().toISOString(), loc_added: 5 },
        }),
      );
      const { workers } = await collectMonitorInputs(root);
      // Regression guard: live worker must appear (workers.length > 0), not be hidden.
      expect(workers.length).toBeGreaterThan(0);
      const found = workers.find((w) => w.state.worker_id === "wLIVE");
      expect(found).toBeDefined();
      // pid-live worker is not dead — the liveness verdict must not be "dead".
      expect(found!.liveness).not.toBe("dead");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// collectMonitorInputs — remote facts (TTL cache) (#1029)
// ---------------------------------------------------------------------------

describe("collectMonitorInputs — remote facts (TTL cache) (#1029)", () => {
  it("returns no remote facts when the statusline cache is absent", async () => {
    const root = scratch();
    try {
      const result = await collectMonitorInputs(root);
      expect(result.remoteQueue).toBeUndefined();
      expect(result.remoteHuman).toBeUndefined();
      expect(result.remoteCacheAgeS).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("exposes queue/human from a fresh statusline cache with low age", async () => {
    const root = scratch();
    try {
      const tmpDir = join(root, ".red", "tmp");
      mkdirSync(tmpDir, { recursive: true });
      const freshTs = nowS();
      writeFileSync(join(tmpDir, "statusline-cache.json"), JSON.stringify({ queue: 4, human: 2, ts: freshTs }));
      const result = await collectMonitorInputs(root);
      expect(result.remoteQueue).toBe(4);
      expect(result.remoteHuman).toBe(2);
      expect(result.remoteCacheAgeS).toBeGreaterThanOrEqual(0);
      // Fresh cache age must be below the TTL.
      expect(result.remoteCacheAgeS).toBeLessThan(STATUSLINE_CACHE_TTL_S);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reports a stale age when the cache is older than the TTL", async () => {
    const root = scratch();
    try {
      const tmpDir = join(root, ".red", "tmp");
      mkdirSync(tmpDir, { recursive: true });
      const staleTs = nowS() - STATUSLINE_CACHE_TTL_S - 30;
      writeFileSync(join(tmpDir, "statusline-cache.json"), JSON.stringify({ queue: 7, human: 1, ts: staleTs }));
      const result = await collectMonitorInputs(root);
      expect(result.remoteQueue).toBe(7);
      expect(result.remoteHuman).toBe(1);
      // Age must exceed the TTL so the render can show a stale marker.
      expect(result.remoteCacheAgeS).toBeGreaterThanOrEqual(STATUSLINE_CACHE_TTL_S);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does NOT refresh the cache (monitor is read-only; statusline owns cache lifecycle)", async () => {
    const root = scratch();
    try {
      const tmpDir = join(root, ".red", "tmp");
      mkdirSync(tmpDir, { recursive: true });
      const staleTs = nowS() - STATUSLINE_CACHE_TTL_S - 30;
      const cachePath = join(tmpDir, "statusline-cache.json");
      writeFileSync(cachePath, JSON.stringify({ queue: 9, human: 3, ts: staleTs }));
      await collectMonitorInputs(root);
      // The cache timestamp must NOT have changed — the monitor never refreshes it.
      const after = JSON.parse(readFileSync(cachePath, "utf8")) as { ts: number };
      expect(after.ts).toBe(staleTs);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
