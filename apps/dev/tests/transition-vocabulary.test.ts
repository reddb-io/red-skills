import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  BLOCKED_LABELS,
  MECHANICAL_BLOCKER_KINDS,
  blockedKindOf,
  blockedLabelsIn,
} from "../src/core/state-transition.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, "..", "src");

function* sourceFiles(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) yield* sourceFiles(path);
    else if (path.endsWith(".ts")) yield path;
  }
}

describe("ADR 0136 transition vocabulary", () => {
  it("owns the complete blocked-label census and mechanical kinds once", () => {
    expect(BLOCKED_LABELS).toEqual([
      "blocked:validation",
      "blocked:validation-infra",
      "blocked:stalled",
      "blocked:wall-clock-capped",
      "blocked:crashed",
      "blocked:signal-killed",
      "blocked:dependency",
      "blocked:spec",
      "blocked:quota",
      "blocked:runner-transient",
      "blocked:host-config",
      "blocked:merge-conflict",
      "blocked:ci",
      "blocked:policy",
      "blocked:infra",
      "blocked:trunk-diverged",
      "blocked:base-stale",
      "blocked:budget",
    ]);
    expect([...MECHANICAL_BLOCKER_KINDS]).toEqual([
      "stalled",
      "crashed",
      "merge-conflict",
    ]);

    const declarations = [...sourceFiles(SRC)].flatMap((path) => {
      const source = readFileSync(path, "utf8");
      return ["BLOCKED_LABELS", "MECHANICAL_BLOCKER_KINDS"]
        .filter((name) => new RegExp(`(?:export\\s+)?const\\s+${name}\\b`).test(source))
        .map((name) => `${relative(SRC, path)}:${name}`);
    });
    expect(declarations).toEqual([
      "core/state-transition.ts:BLOCKED_LABELS",
      "core/state-transition.ts:MECHANICAL_BLOCKER_KINDS",
    ]);
  });

  it("answers blocked-label questions through the planner vocabulary", () => {
    expect(blockedLabelsIn(["bug", "blocked:validation", "blocked:push-failed"]))
      .toEqual(["blocked:validation", "blocked:push-failed"]);
    expect(blockedKindOf("blocked:push-failed")).toBe("push-failed");
    expect(blockedKindOf("ready-for-human")).toBeNull();

    for (const path of sourceFiles(SRC)) {
      if (path.endsWith("core/state-transition.ts")) continue;
      const source = readFileSync(path, "utf8");
      expect(source, relative(SRC, path)).not.toMatch(/\.startsWith\(["']blocked:/);
      expect(source, relative(SRC, path)).not.toMatch(/\.slice\(["']blocked:["']\.length\)/);
      expect(source, relative(SRC, path)).not.toMatch(/\/\^blocked:\|ready-for-human/);
    }
  });

  it("has no second lifecycle validator or unrelated BlockerState type", () => {
    for (const path of sourceFiles(SRC)) {
      const source = readFileSync(path, "utf8");
      expect(source, relative(SRC, path)).not.toContain("validateIssueLifecycleTransition");
    }
    const bootSweep = readFileSync(join(SRC, "core", "boot-sweep.ts"), "utf8");
    expect(bootSweep).not.toMatch(/\bBlockerState(?:Lookup)?\b/);
  });
});
