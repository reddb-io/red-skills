import { describe, expect, it, vi } from "vitest";
import { CASTLE_VALIDATION_SCHEMA } from "./gate-constants.js";
import { makeHeadlessGateSink, makeInteractiveGateSink } from "./gate-sink.js";
import { checkSensitivePaths, classifyFinding, runCastleGate, type RunCastleGateInput } from "./gate-executor.js";

function baseInput(): RunCastleGateInput {
  let tick = 0;
  return {
    worktree: "/repo",
    changedFiles: ["packages/core/src/index.ts"],
    layout: {
      hasPackage(scope) {
        return [".", "packages/core", "apps/dev"].includes(scope);
      },
      hasScript(scope, script) {
        return scope === "packages/core" && ["test", "typecheck"].includes(script);
      },
    },
    graph: {
      packages: [
        { dir: "packages/core", dependsOn: [] },
        { dir: "apps/dev", dependsOn: ["packages/core"] },
      ],
    },
    sink: makeInteractiveGateSink({
      askIntent: async () => "approved",
      askSensitivePath: async () => "approved",
    }),
    feedbackExec: vi.fn(async () => ({ code: 0, stdout: "ok", stderr: "" })),
    backpressureExec: vi.fn(async () => ({ code: 0, stdout: "ok", stderr: "" })),
    applyMechanical: vi.fn(async () => {}),
    now: () => ++tick,
  };
}

describe("castle gate executor", () => {
  it("classifies only versioned mechanical kinds as mechanical", () => {
    expect(classifyFinding({ kind: "formatter", description: "format" })).toBe("mechanical");
    expect(classifyFinding({ kind: "refactor", description: "logic changed" })).toBe("intent");
  });

  it("detects sensitive paths and package lifecycle script changes", () => {
    expect(checkSensitivePaths([".github/workflows/ci.yml"], "")).toEqual([
      { path: ".github/workflows/ci.yml", reason: "CI workflow file" },
    ]);
    expect(checkSensitivePaths(["packages/core/package.json"], '+    "postinstall": "node build.js",')).toEqual([
      { path: "packages/core/package.json", reason: "lifecycle script added or altered in package.json" },
    ]);
  });

  it("runs scoped feedback, skips missing scripts, then runs configured backpressure", async () => {
    const input = baseInput();
    input.backpressureCommands = ["pnpm smoke"];

    const result = await runCastleGate(input);

    expect(result.ok).toBe(true);
    expect(result.validationScope).toEqual({
      type: "cone",
      triggerPackages: ["packages/core"],
      packages: ["apps/dev", "packages/core"],
    });
    expect(input.feedbackExec).toHaveBeenCalledWith(["pnpm", "-C", "/repo/packages/core", "test"]);
    expect(input.backpressureExec).toHaveBeenCalledWith({
      command: "pnpm smoke",
      cwd: "/repo",
      timeoutMs: 600000,
    });
    expect(result.checks.map((check) => check.name)).toContain("backpressure:pnpm smoke");
    expect(JSON.parse(result.sidecar[0]!).schema).toBe(CASTLE_VALIDATION_SCHEMA);
  });

  it("blocks through the headless sink on intent findings before validation evidence is recorded", async () => {
    const input = baseInput();
    const parkIntent = vi.fn(async () => {});
    input.sink = makeHeadlessGateSink({
      parkIntent,
      parkSensitivePath: async () => {},
    });
    input.findings = [{ kind: "behavior", description: "changes semantics" }];

    const result = await runCastleGate(input);

    expect(result.ok).toBe(false);
    expect(result.sinkOutcomes).toEqual(["parked"]);
    expect(parkIntent).toHaveBeenCalledTimes(1);
  });

  it("does not run backpressure when feedback fails", async () => {
    const input = baseInput();
    input.feedbackExec = vi.fn(async () => ({ code: 1, stdout: "", stderr: "failed" }));
    input.backpressureCommands = ["pnpm smoke"];

    const result = await runCastleGate(input);

    expect(result.ok).toBe(false);
    expect(input.backpressureExec).not.toHaveBeenCalled();
  });
});
