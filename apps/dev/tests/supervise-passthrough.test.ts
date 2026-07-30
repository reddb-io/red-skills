import { describe, expect, it } from "vitest";
import {
  PASSTHROUGH_DENYLIST,
  passthroughKeys,
  buildWorkerEnv,
  buildSlotEnv,
  slotFilterArgs,
  formatBootSweepResult,
} from "../src/commands/supervise.js";
import type { BootResult } from "../src/core/boot.js";

describe("buildWorkerEnv / passthroughKeys (gap 4: passthrough denylist)", () => {
  it("forwards operator RED_AFK_* vars but strips internal supervisor knobs", () => {
    const source = {
      PATH: "/usr/bin",
      RED_AFK_SKIP_PERF: "1",
      RED_AFK_SKIP_COMPETITIVE_BASELINE: "1",
      RED_AFK_TRUNK: "develop",
      RED_AFK_TARGET: "4",
      RED_AFK_POLL_S: "15",
      RED_AFK_CIRCUIT_K: "5",
      RED_AFK_STALL_THRESHOLD_S: "600",
    };
    const env = buildWorkerEnv(source, "codex");
    // operator vars survive
    expect(env.RED_AFK_SKIP_PERF).toBe("1");
    expect(env.RED_AFK_SKIP_COMPETITIVE_BASELINE).toBe("1");
    expect(env.RED_AFK_TRUNK).toBe("develop");
    expect(env.PATH).toBe("/usr/bin");
    // every internal knob is stripped
    for (const denied of PASSTHROUGH_DENYLIST) {
      if (denied === "RED_AFK_RUNNER") continue; // re-pinned below
      if (denied === "RED_AFK_SWEEPS_DONE") continue; // re-pinned below (#623)
      expect(env[denied]).toBeUndefined();
    }
    expect(env.RED_AFK_TARGET).toBeUndefined();
    expect(env.RED_AFK_POLL_S).toBeUndefined();
    // runner is re-pinned to the supervisor's runner
    expect(env.RED_AFK_RUNNER).toBe("codex");
    // #623: every supervised worker is marked sweeps-done so it boots
    // bootstrap+claim only (skips the sweeps the supervisor already ran).
    expect(env.RED_AFK_SWEEPS_DONE).toBe("1");
  });

  it("strips per-slot _BASE build-isolation vars (handled per slot, not forwarded)", () => {
    const env = buildWorkerEnv(
      { RED_AFK_CARGO_TARGET_BASE: "/opt/cargo", RED_AFK_GRADLE_USER_HOME_BASE: "/opt/gradle" },
      "claude",
    );
    expect(env.RED_AFK_CARGO_TARGET_BASE).toBeUndefined();
    expect(env.RED_AFK_GRADLE_USER_HOME_BASE).toBeUndefined();
  });

  it("passthroughKeys returns the sorted set of forwarded operator vars", () => {
    const keys = passthroughKeys({
      RED_AFK_SKIP_B: "1",
      RED_AFK_SKIP_A: "1",
      RED_AFK_TARGET: "2",
      RED_AFK_CARGO_TARGET_BASE: "/x",
      NOT_AFK: "x",
    });
    expect(keys).toEqual(["RED_AFK_SKIP_A", "RED_AFK_SKIP_B"]);
  });

  it("re-pins the runner even when RED_AFK_RUNNER was set in the source", () => {
    const env = buildWorkerEnv({ RED_AFK_RUNNER: "claude" }, "codex");
    expect(env.RED_AFK_RUNNER).toBe("codex");
  });
});

describe("buildSlotEnv (per-slot RED_AFK_SLOT injection)", () => {
  it("pins RED_AFK_SLOT to the given slot index", () => {
    const base = buildWorkerEnv({ PATH: "/usr/bin" }, "claude");
    expect(buildSlotEnv(base, 0).RED_AFK_SLOT).toBe("0");
    expect(buildSlotEnv(base, 3).RED_AFK_SLOT).toBe("3");
  });

  it("each slot gets a distinct RED_AFK_SLOT (no shared slot-0 default)", () => {
    const base = buildWorkerEnv({}, "claude");
    const envs = [0, 1, 2].map((s) => buildSlotEnv(base, s));
    expect(envs[0]!.RED_AFK_SLOT).toBe("0");
    expect(envs[1]!.RED_AFK_SLOT).toBe("1");
    expect(envs[2]!.RED_AFK_SLOT).toBe("2");
  });

  it("overrides any pre-existing RED_AFK_SLOT value", () => {
    const env = buildSlotEnv({ RED_AFK_SLOT: "0", PATH: "/x" }, 5);
    expect(env.RED_AFK_SLOT).toBe("5");
  });

  it("preserves all other keys from the base worker env", () => {
    const base = buildWorkerEnv({ PATH: "/usr/bin", RED_AFK_SKIP_PERF: "1" }, "codex");
    const slotted = buildSlotEnv(base, 2);
    expect(slotted.PATH).toBe("/usr/bin");
    expect(slotted.RED_AFK_SKIP_PERF).toBe("1");
    expect(slotted.RED_AFK_RUNNER).toBe("codex");
  });

  it("marks only budget-critical spawns for a one-tier task downgrade", () => {
    const base = buildWorkerEnv({ PATH: "/usr/bin" }, "claude");
    expect(buildSlotEnv(base, 0).RED_AFK_TASK_TIER_DOWNGRADE).toBeUndefined();
    expect(buildSlotEnv(base, 1, { taskTierDowngrade: true }).RED_AFK_TASK_TIER_DOWNGRADE).toBe("1");
  });
});

describe("slotFilterArgs (gap 5: supervised fleet forwards the filter)", () => {
  it("forwards a --spec filter to each slot", () => {
    expect(slotFilterArgs(["--spec", "42"])).toEqual(["--spec", "42"]);
  });

  it("forwards a --issues filter", () => {
    expect(slotFilterArgs(["--issues", "1,2,3"])).toEqual(["--issues", "1,2,3"]);
  });

  it("forwards the runner-swap policy booleans", () => {
    expect(slotFilterArgs(["--alternate"])).toEqual(["--alternate"]);
    expect(slotFilterArgs(["--fallback-runner"])).toEqual(["--fallback-runner"]);
  });

  it("forwards --request (and its -r alias) as --request", () => {
    expect(slotFilterArgs(["--request", "go fast"])).toEqual(["--request", "go fast"]);
    expect(slotFilterArgs(["-r", "go fast"])).toEqual(["--request", "go fast"]);
  });

  it("forwards the --tags/--user territory facets in both flag forms", () => {
    expect(slotFilterArgs(["--tags", "backend,infra"])).toEqual(["--tags", "backend,infra"]);
    expect(slotFilterArgs(["--tags=backend"])).toEqual(["--tags", "backend"]);
    expect(slotFilterArgs(["--user", "octocat"])).toEqual(["--user", "octocat"]);
    expect(slotFilterArgs(["--user=@me"])).toEqual(["--user", "@me"]);
  });

  it("accepts the --flag=value form", () => {
    expect(slotFilterArgs(["--spec=42", "--request=do it"])).toEqual([
      "--spec",
      "42",
      "--request",
      "do it",
    ]);
  });

  it("forwards a full combined filter + policy in order", () => {
    expect(slotFilterArgs(["--spec", "7", "--fallback-runner", "--request", "x"])).toEqual([
      "--spec",
      "7",
      "--fallback-runner",
      "--request",
      "x",
    ]);
  });

  it("drops unknown args (only the filter/policy surface is forwarded)", () => {
    expect(slotFilterArgs(["/some/project/root", "--bogus", "stop"])).toEqual([]);
  });

  it("returns [] for an empty arg list", () => {
    expect(slotFilterArgs([])).toEqual([]);
  });
});

describe("formatBootSweepResult — supervisor boot log shape (#623)", () => {
  it("summarises each sweep's counts on a passing precheck", () => {
    const result: BootResult = {
      precheck: { ok: true, warnings: [] },
      bootstrap: { ok: true },
      orphanCleanup: { removed: ["a", "b"], restored: [7], kept: ["c"], legacyWiped: [], claimsReleased: [] },
      attemptCap: { reclaimed: ["x"] },
      branchCleanup: {
        remoteLiveReaped: [],
        localLiveReaped: ["l1", "l2"],
        localSpared: [
          // #2866: the spare is reported, so an operator can see the trunk
          // mirror was kept on purpose rather than missed by accident.
          { branch: "red-trunk", reclaim: false, verdict: "infrastructure", reason: "infrastructure ref" },
        ],
      },
      unblockSweep: { promoted: [9] },
      straggler: { counts: { unlabeled: 2, needsTriage: 1, needsInfo: 0 }, warn: true },
    };
    expect(formatBootSweepResult(result)).toBe(
      "boot sweeps complete: orphans removed=2 restored=1 kept=1 | attempt-cap reclaimed=1 | " +
        "branches remote=0 local=2 spared=1 | tmp-janitor expired=0 workers=0 orphan-runners=0 unknown=0 protected=0 | " +
        "docs-sweep clean files=0 | unblocked=1 | stragglers unlabeled=2 triage=1 info=0",
    );
  });

  it("reports a precheck failure (workers fall back to their own precheck)", () => {
    const result: BootResult = {
      precheck: {
        ok: false,
        failed: "not-on-trunk",
        detail: { current: "main", expected: "feat/x", source: "pin" },
      },
    };
    expect(formatBootSweepResult(result)).toBe(
      "boot sweeps: precheck FAILED (not-on-trunk: current=main expected=feat/x source=pin) — workers will run their own precheck",
    );
  });

  it("logs every janitor removal with its target and liveness verdict", () => {
    const result: BootResult = {
      precheck: { ok: true, warnings: [] },
      tmpJanitor: {
        expiredLanes: [".red/tmp/worktrees/feedback/afk-wDEAD-2450-gate"],
        staleWorkers: [],
        unknownTmpRoots: [],
        orphanTestRunners: [],
        protectedLiveWorkers: [],
        protectedLiveFeedback: [],
        workerWorkspaces: [],
        protectedLiveWorkspaces: [],
        refusedOutsideTmp: [],
        removals: [
          {
            path: ".red/tmp/worktrees/feedback/afk-wDEAD-2450-gate",
            livenessVerdict: "owner-dead",
          },
        ],
      },
    };

    expect(formatBootSweepResult(result)).toContain(
      "remove=.red/tmp/worktrees/feedback/afk-wDEAD-2450-gate liveness=owner-dead",
    );
  });
});
