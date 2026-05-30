import { describe, expect, it } from "vitest";
import {
  buildValidationRecord,
  nearestPackageScope,
  outputSummary,
  relevantScopes,
  runFeedback,
  scopeDir,
  scopeLabel,
  VALIDATION_SCHEMA,
  type Exec,
  type ExecResult,
  type PackageLayout,
  type ValidationRecord,
} from "../src/core/feedback.js";

/**
 * Fake package layout: `packages` is the set of dirs that carry a package.json
 * (the root is `"."`), `scripts` maps each scope to the scripts it declares.
 * Pure — the test states the worktree shape directly instead of touching disk.
 */
function fakeLayout(input: {
  packages: readonly string[];
  scripts?: Record<string, readonly string[]>;
}): PackageLayout {
  const packages = new Set(input.packages);
  const scripts = input.scripts ?? {};
  return {
    hasPackage: (scope) => packages.has(scope),
    hasScript: (scope, script) => (scripts[scope] ?? []).includes(script),
  };
}

/**
 * Fake Exec recording every argv and replying from a per-call matcher. Default
 * reply is success with empty output, so a test only overrides the calls whose
 * exit code drives a failure.
 */
function fakeExec(
  rules: Array<{ match: (argv: string[]) => boolean; result: Partial<ExecResult> }> = [],
): { exec: Exec; calls: string[][] } {
  const calls: string[][] = [];
  const exec: Exec = async (argv) => {
    calls.push(argv);
    for (const rule of rules) {
      if (rule.match(argv)) return { code: 0, stdout: "", stderr: "", ...rule.result };
    }
    return { code: 0, stdout: "", stderr: "" };
  };
  return { exec, calls };
}

const joined = (calls: string[][]): string[] => calls.map((c) => c.join(" "));

/** A monotonic injected clock that ticks 5ms per read. */
function fakeClock(step = 5): () => number {
  let t = 1000;
  return () => {
    const v = t;
    t += step;
    return v;
  };
}

describe("scope resolution", () => {
  it("resolves a single touched package to its nearest scope", () => {
    const layout = fakeLayout({ packages: ["plugins/memory"] });
    expect(relevantScopes(layout, ["plugins/memory/src/index.ts"])).toEqual(["plugins/memory"]);
  });

  it("dedupes and sorts multiple touched packages", () => {
    const layout = fakeLayout({ packages: ["plugins/memory", "packages/afk"] });
    const scopes = relevantScopes(layout, [
      "plugins/memory/src/a.ts",
      "packages/afk/src/b.ts",
      "plugins/memory/src/c.ts",
    ]);
    expect(scopes).toEqual(["packages/afk", "plugins/memory"]);
  });

  it("falls back to the root package for a root-only repo", () => {
    const layout = fakeLayout({ packages: ["."] });
    expect(relevantScopes(layout, ["src/index.js"])).toEqual(["."]);
  });

  it("picks the nearest package.json, not an ancestor", () => {
    const layout = fakeLayout({ packages: [".", "plugins/memory"] });
    // A file under plugins/memory resolves to plugins/memory, not root.
    expect(nearestPackageScope(layout, "plugins/memory/src/deep/x.ts")).toBe("plugins/memory");
    // A root-level file with no nearer package resolves to root.
    expect(nearestPackageScope(layout, "README.md")).toBe(".");
  });

  it("returns no scopes when nothing maps and there is no root package", () => {
    const layout = fakeLayout({ packages: ["plugins/memory"] });
    // Touched file lives outside any package, no root package → empty.
    expect(relevantScopes(layout, ["docs/guide.md"])).toEqual([]);
    expect(nearestPackageScope(layout, "docs/guide.md")).toBeUndefined();
  });

  it("derives scope labels and dirs", () => {
    expect(scopeLabel(".")).toBe("root");
    expect(scopeLabel("plugins/memory")).toBe("plugins/memory");
    expect(scopeDir("/wt", ".")).toBe("/wt");
    expect(scopeDir("/wt", "plugins/memory")).toBe("/wt/plugins/memory");
  });
});

describe("runFeedback", () => {
  it("runs declared scripts via the exact pnpm -C argv and passes", async () => {
    const layout = fakeLayout({
      packages: ["plugins/memory"],
      scripts: { "plugins/memory": ["test", "typecheck", "build"] },
    });
    const { exec, calls } = fakeExec();
    const result = await runFeedback(exec, {
      worktree: "/wt",
      scopes: ["plugins/memory"],
      layout,
      now: fakeClock(),
    });

    expect(result.ok).toBe(true);
    const c = joined(calls);
    // Exact pnpm -C argv for each declared script.
    expect(c).toContain("pnpm -C /wt/plugins/memory test");
    expect(c).toContain("pnpm -C /wt/plugins/memory typecheck");
    expect(c).toContain("pnpm -C /wt/plugins/memory build");
    // lint is not declared → no pnpm call for it.
    expect(c.some((x) => x.includes("lint"))).toBe(false);
  });

  it("emits an explicit skip record for a missing script", async () => {
    const layout = fakeLayout({
      packages: ["plugins/memory"],
      scripts: { "plugins/memory": ["test"] },
    });
    const { exec, calls } = fakeExec();
    const result = await runFeedback(exec, {
      worktree: "/wt",
      scopes: ["plugins/memory"],
      layout,
      now: fakeClock(),
    });

    expect(result.ok).toBe(true);
    // Only test ran; the other three skipped, never invoking pnpm.
    expect(joined(calls)).toEqual(["pnpm -C /wt/plugins/memory test"]);

    const lint = result.checks.find((ch) => ch.name === "lint:plugins/memory");
    expect(lint?.status).toBe("skipped");
    expect(lint?.record).toEqual({
      schema: VALIDATION_SCHEMA,
      name: "lint:plugins/memory",
      status: "skipped",
      summary: "script missing",
    });
    // Skip records carry no command / durationMs.
    expect(lint?.record.command).toBeUndefined();
    expect(lint?.record.durationMs).toBeUndefined();
  });

  it("blocks the merge (ok:false) when any check fails", async () => {
    const layout = fakeLayout({
      packages: ["plugins/memory"],
      scripts: { "plugins/memory": ["test"] },
    });
    const { exec } = fakeExec([
      { match: (a) => a.includes("test"), result: { code: 42, stdout: "boom\nfailed here\n" } },
    ]);
    const result = await runFeedback(exec, {
      worktree: "/wt",
      scopes: ["plugins/memory"],
      layout,
      now: fakeClock(),
    });

    expect(result.ok).toBe(false);
    const test = result.checks.find((ch) => ch.name === "test:plugins/memory");
    expect(test?.status).toBe("failed");
    expect(test?.record.summary).toBe("boom failed here");
  });

  it("produces the exact red.afk.validation.v1 sidecar record shape", async () => {
    const layout = fakeLayout({
      packages: ["plugins/memory"],
      scripts: { "plugins/memory": ["test"] },
    });
    const { exec } = fakeExec();
    const result = await runFeedback(exec, {
      worktree: "/repo/plugins/memory".replace("/plugins/memory", ""),
      scopes: ["plugins/memory"],
      layout,
      // start=1000, end=2234 → durationMs 1234, matching the SKILL example.
      now: (() => {
        const seq = [1000, 2234];
        let i = 0;
        return () => seq[i++] ?? 0;
      })(),
    });

    const test = result.checks.find((ch) => ch.name === "test:plugins/memory");
    const expected: ValidationRecord = {
      schema: "red.afk.validation.v1",
      name: "test:plugins/memory",
      status: "passed",
      command: "pnpm -C /repo/plugins/memory test",
      durationMs: 1234,
      summary: "command exited 0",
    };
    expect(test?.record).toEqual(expected);
    // Sidecar line is the compact JSON of the record, schema-first.
    expect(result.sidecar).toContain(JSON.stringify(expected));
  });

  it("emits per-script no-package skips when the repo has no package", async () => {
    const layout = fakeLayout({ packages: [] });
    const { exec, calls } = fakeExec();
    const result = await runFeedback(exec, {
      worktree: "/wt",
      scopes: [],
      layout,
      now: fakeClock(),
    });

    expect(result.ok).toBe(true);
    expect(calls).toEqual([]);
    expect(result.checks.map((ch) => ch.name)).toEqual([
      "test:no-package",
      "typecheck:no-package",
      "lint:no-package",
      "build:no-package",
    ]);
    expect(result.checks.every((ch) => ch.status === "skipped")).toBe(true);
    expect(result.checks[0]?.record).toEqual({
      schema: VALIDATION_SCHEMA,
      name: "test:no-package",
      status: "skipped",
      summary: "no package.json",
    });
  });

  it("runs each script across every touched scope (script × scope order)", async () => {
    const layout = fakeLayout({
      packages: ["packages/afk", "plugins/memory"],
      scripts: { "packages/afk": ["test"], "plugins/memory": ["test"] },
    });
    const { exec, calls } = fakeExec();
    await runFeedback(exec, {
      worktree: "/wt",
      scopes: ["packages/afk", "plugins/memory"],
      layout,
      now: fakeClock(),
    });
    // test runs for both scopes; later scripts skip (not declared) → no pnpm.
    expect(joined(calls)).toEqual([
      "pnpm -C /wt/packages/afk test",
      "pnpm -C /wt/plugins/memory test",
    ]);
  });
});

describe("pure shaping helpers", () => {
  it("omits optional fields like the bash jq builder", () => {
    expect(buildValidationRecord({ name: "x:root", status: "skipped", summary: "" })).toEqual({
      schema: VALIDATION_SCHEMA,
      name: "x:root",
      status: "skipped",
    });
    expect(
      buildValidationRecord({ name: "x:root", status: "passed", command: "", durationMs: 7 }),
    ).toEqual({
      schema: VALIDATION_SCHEMA,
      name: "x:root",
      status: "passed",
      durationMs: 7,
    });
  });

  it("summarizes pass and fail output", () => {
    expect(outputSummary("passed", "anything")).toBe("command exited 0");
    expect(outputSummary("failed", "")).toBe("command exited non-zero");
    expect(outputSummary("failed", "line a\nline b\n")).toBe("line a line b");
    const long = `${"x".repeat(2000)}\n`;
    expect(outputSummary("failed", long).length).toBe(1000);
  });
});
