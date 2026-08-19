import { describe, expect, it, vi } from "vitest";
import { CASTLE_VALIDATION_SCHEMA } from "./gate-constants.js";
import { makeHeadlessGateSink, makeInteractiveGateSink } from "./gate-sink.js";
import { classifyFinding, runCastleGate, validationResourceClass, type RunCastleGateInput } from "./gate-executor.js";

function baseInput(): RunCastleGateInput {
  let tick = 0;
  return {
    worktree: "/repo",
    changedFiles: ["packages/core/src/index.ts"],
    layout: {
      hasPackage(scope) {
        return [".", "packages/core", "apps/plugin-dev"].includes(scope);
      },
      hasScript(scope, script) {
        return scope === "packages/core" && ["test", "typecheck"].includes(script);
      },
    },
    graph: {
      packages: [
        { dir: "packages/core", dependsOn: [] },
        { dir: "apps/plugin-dev", dependsOn: ["packages/core"] },
      ],
    },
    sink: makeInteractiveGateSink({
      askIntent: async () => "approved",
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

  it("runs scoped feedback, skips missing scripts, then runs configured backpressure", async () => {
    const input = baseInput();
    input.backpressureCommands = ["pnpm smoke"];

    const result = await runCastleGate(input);

    expect(result.ok).toBe(true);
    expect(result.validationScope).toEqual({
      type: "cone",
      triggerPackages: ["packages/core"],
      packages: ["apps/plugin-dev", "packages/core"],
    });
    expect(input.feedbackExec).toHaveBeenCalledWith(
      ["pnpm", "-C", "/repo/packages/core", "test"],
      { weight: "light" },
    );
    expect(input.backpressureExec).toHaveBeenCalledWith({
      command: "pnpm smoke",
      cwd: "/repo",
      timeoutMs: 600000,
      weight: "heavy",
    });
    expect(result.checks.map((check) => check.name)).toContain("backpressure:pnpm smoke");
    expect(JSON.parse(result.sidecar[0]!).schema).toBe(CASTLE_VALIDATION_SCHEMA);
  });

  it("classifies only root/workspace test, typecheck and build as heavy", () => {
    expect(validationResourceClass(".", "test")).toBe("heavy");
    expect(validationResourceClass(".", "typecheck")).toBe("heavy");
    expect(validationResourceClass(".", "build")).toBe("heavy");
    expect(validationResourceClass(".", "lint")).toBe("light");
    expect(validationResourceClass("packages/core", "test")).toBe("light");
  });

  it("blocks through the headless sink on intent findings before validation evidence is recorded", async () => {
    const input = baseInput();
    const parkIntent = vi.fn(async () => {});
    input.sink = makeHeadlessGateSink({
      parkIntent,
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

  it("refuses an over-class gate with an explicit verdict before executing commands", async () => {
    const input = baseInput();
    input.hostProfile = {
      machineIdHash: "8cb3eafdcbd2",
      runners: ["codex"],
      maxGateWeight: "light-cone",
      defaultFleetWidth: 1,
    };
    input.gateWeight = "heavy-cone";
    input.backpressureCommands = ["pnpm smoke"];

    const result = await runCastleGate(input);

    expect(result).toMatchObject({
      ok: false,
      admission: {
        admitted: false,
        verdict: "refused-over-class",
        required: "heavy-cone",
        maximum: "light-cone",
      },
      checks: [],
      sidecar: [],
    });
    expect(input.feedbackExec).not.toHaveBeenCalled();
    expect(input.backpressureExec).not.toHaveBeenCalled();
  });

  it("a diff touching .github/workflows/ passes through the gate without blocking", async () => {
    const input = baseInput();
    input.changedFiles = [".github/workflows/ci.yml", "packages/core/src/index.ts"];

    const result = await runCastleGate(input);

    expect(result.ok).toBe(true);
    expect(result.sinkOutcomes).toEqual([]);
  });
});
