import { describe, expect, it } from "vitest";
import {
  PASSTHROUGH_DENYLIST,
  passthroughKeys,
  buildWorkerEnv,
  buildSlotEnv,
  slotFilterArgs,
} from "../src/commands/supervise.js";

describe("buildWorkerEnv / passthroughKeys (gap 4: passthrough denylist)", () => {
  it("forwards operator RED_AFK_* vars but strips internal supervisor knobs", () => {
    const source = {
      PATH: "/usr/bin",
      RED_AFK_SKIP_PERF: "1",
      RED_AFK_SKIP_COMPETITIVE_BASELINE: "1",
      RED_AFK_TARGET: "4",
      RED_AFK_POLL_S: "15",
      RED_AFK_CIRCUIT_K: "5",
      RED_AFK_STALL_THRESHOLD_S: "600",
    };
    const env = buildWorkerEnv(source, "codex");
    // operator vars survive
    expect(env.RED_AFK_SKIP_PERF).toBe("1");
    expect(env.RED_AFK_SKIP_COMPETITIVE_BASELINE).toBe("1");
    expect(env.PATH).toBe("/usr/bin");
    // every internal knob is stripped
    for (const denied of PASSTHROUGH_DENYLIST) {
      if (denied === "RED_AFK_RUNNER") continue; // re-pinned below
      expect(env[denied]).toBeUndefined();
    }
    expect(env.RED_AFK_TARGET).toBeUndefined();
    expect(env.RED_AFK_POLL_S).toBeUndefined();
    // runner is re-pinned to the supervisor's runner
    expect(env.RED_AFK_RUNNER).toBe("codex");
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
});

describe("slotFilterArgs (gap 5: supervised fleet forwards the filter)", () => {
  it("forwards a --prd filter to each slot", () => {
    expect(slotFilterArgs(["--prd", "42"])).toEqual(["--prd", "42"]);
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

  it("accepts the --flag=value form", () => {
    expect(slotFilterArgs(["--prd=42", "--request=do it"])).toEqual([
      "--prd",
      "42",
      "--request",
      "do it",
    ]);
  });

  it("forwards a full combined filter + policy in order", () => {
    expect(slotFilterArgs(["--prd", "7", "--fallback-runner", "--request", "x"])).toEqual([
      "--prd",
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
