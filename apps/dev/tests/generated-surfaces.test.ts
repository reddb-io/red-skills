import { describe, expect, it } from "vitest";
import {
  healGeneratedDrift,
  onlyGeneratedPaths,
  type MechanicalRegenerationSteps,
} from "../src/core/generated-surfaces.js";

describe("generated-surface mechanical cure", () => {
  it("matches repository-relative * and ** globs without admitting mixed drift", () => {
    expect(onlyGeneratedPaths(
      ["packaging/pi/dev/package.json", "plugins/dev/package.json"],
      ["packaging/pi/**", "plugins/*/package.json"],
    )).toBe(true);
    expect(onlyGeneratedPaths(
      ["packaging/pi/dev/package.json", "apps/dev/src/core/verdict.ts"],
      ["packaging/pi/**"],
    )).toBe(false);
    expect(onlyGeneratedPaths([], ["packaging/pi/**"])).toBe(false);
  });

  it("executes merge → command → generated-only commit/publish", async () => {
    const calls: string[] = [];
    const steps: MechanicalRegenerationSteps = {
      mergeBase: async () => { calls.push("merge"); return { ok: true }; },
      runCommand: async (command) => { calls.push(`run:${command}`); return { ok: true }; },
      changedFiles: async () => ["packaging/pi/dev/package.json"],
      commitAndPublish: async (paths) => { calls.push(`commit:${paths.join(",")}`); return { ok: true }; },
    };

    await expect(healGeneratedDrift(steps, {
      paths: ["packaging/pi/**"],
      command: "pnpm pi:packages:build",
    })).resolves.toEqual({ ok: true, evidence: "merge, regeneration, commit, and publish completed" });
    expect(calls).toEqual([
      "merge",
      "run:pnpm pi:packages:build",
      "commit:packaging/pi/dev/package.json",
    ]);
  });

  it("refuses generator output outside the declaration and preserves stage evidence", async () => {
    const steps: MechanicalRegenerationSteps = {
      mergeBase: async () => ({ ok: true }),
      runCommand: async () => ({ ok: true }),
      changedFiles: async () => ["packaging/pi/dev/package.json", "src/intent.ts"],
      commitAndPublish: async () => ({ ok: true }),
    };

    await expect(healGeneratedDrift(steps, {
      paths: ["packaging/pi/**"],
      command: "pnpm pi:packages:build",
    })).resolves.toEqual({
      ok: false,
      evidence: "generator changed undeclared paths: src/intent.ts",
    });
  });
});
