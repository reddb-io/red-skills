import { describe, expect, it } from "vitest";
import {
  buildValidationRecord,
  buildFeedbackSubprocessEnv,
  decideBaselineDiffGate,
  nearestPackageScope,
  namedFailures,
  outputSummary,
  relevantScopes,
  runFeedback,
  scopeDir,
  scopeLabel,
  VALIDATION_SCHEMA,
  type Exec,
  type ExecResult,
  type FeedbackCheck,
  type PackageLayout,
  type RunFeedbackResult,
  type ValidationRecord,
} from "../src/core/feedback.js";
import { decideVerdict, emptyEnvironmentLedger } from "../src/core/verdict.js";

function verdictIsEnvironment(result: RunFeedbackResult): boolean {
  if (result.ok) return false;
  return decideVerdict({
    checks: result.checks,
    signature: "test-signature",
    history: { environment: emptyEnvironmentLedger(2), branchBudgetAvailable: true },
    environment: {},
  }).fault.kind !== "branch";
}

describe("buildFeedbackSubprocessEnv resource budget (#1758)", () => {
  it("adds bounded Node heap and Vitest worker env without leaking AFK routing vars", () => {
    const env = buildFeedbackSubprocessEnv(
      {
        PATH: "/bin",
        NODE_OPTIONS: "--trace-warnings",
        RED_AFK_WORKERS_NAMESPACE: "go-workers",
      },
      { nodeMaxOldSpaceMb: 1536, vitestMaxWorkers: 2, turboConcurrency: 4 },
    );

    expect(env.PATH).toBe("/bin");
    expect(env.NODE_OPTIONS).toContain("--max-old-space-size=1536");
    expect(env.VITEST_MAX_WORKERS).toBe("2");
    expect(env.TURBO_CONCURRENCY).toBe("4");
    expect("RED_AFK_WORKERS_NAMESPACE" in env).toBe(false);
  });
});

describe("validation host-resource classification (#3802)", () => {
  it("marks only root/workspace test, typecheck and build as heavy", async () => {
    const calls: Array<{ argv: string[]; weight: string | undefined }> = [];
    const exec: Exec = async (argv, options) => {
      calls.push({ argv, weight: options?.weight });
      return { code: 0, stdout: "", stderr: "" };
    };
    const layout = fakeLayout({
      packages: [".", "apps/dev"],
      scripts: {
        ".": ["test", "typecheck", "lint", "build"],
        "apps/dev": ["test", "typecheck", "lint", "build"],
      },
    });

    await runFeedback(exec, {
      worktree: "/repo",
      scopes: ["apps/dev"],
      layout,
      now: fakeClock(),
      root: "/repo",
      worktreeKind: "checkout",
      dirExists: () => true,
    });
    await runFeedback(exec, {
      worktree: "/repo",
      scopes: ["."],
      layout,
      now: fakeClock(),
      root: "/repo",
      worktreeKind: "checkout",
      dirExists: () => true,
    });

    const classified = new Map(calls.map((call) => [call.argv.join(" "), call.weight]));
    expect(classified.get("pnpm -C /repo/apps/dev test")).toBe("light");
    expect(classified.get("pnpm -C /repo/apps/dev build")).toBe("light");
    expect(classified.get("pnpm -C /repo typecheck")).toBe("heavy");
    expect(classified.get("pnpm -C /repo test")).toBe("heavy");
    expect(classified.get("pnpm -C /repo build")).toBe("heavy");
    expect(classified.get("pnpm -C /repo lint")).toBe("light");
  });
});

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
  it("runs only operator-declared feedback commands when the discovered harness is replaced (#3276)", async () => {
    const layout = fakeLayout({
      packages: [".", "apps/dev"],
      scripts: { ".": ["test", "typecheck", "lint", "build"], "apps/dev": ["test"] },
    });
    const { exec, calls } = fakeExec();
    const shellCalls: Array<{ command: string; cwd: string }> = [];

    const result = await runFeedback(exec, {
      worktree: "/wt",
      scopes: ["apps/dev"],
      layout,
      now: fakeClock(),
      commands: ["pnpm -C apps/dev exec tsc --noEmit"],
      commandExec: async ({ command, cwd }) => {
        shellCalls.push({ command, cwd });
        return { code: 0, stdout: "", stderr: "" };
      },
    });

    expect(result.ok).toBe(true);
    expect(calls).toEqual([]);
    expect(shellCalls).toEqual([
      { command: "pnpm -C apps/dev exec tsc --noEmit", cwd: "/wt" },
    ]);
    expect(result.checks.map((check) => check.name)).toEqual([
      "feedback:pnpm -C apps/dev exec tsc --noEmit",
    ]);
  });

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
    // The fake clock advances 5ms per read, so this failure is sub-second and
    // carries the #3041 suspect-infra prefix — the captured output survives it.
    expect(test?.record.summary).toContain("boom failed here");
    expect(test?.record.suspectInfra).toBe(true);
  });

  it("records a reaped CPU-idle child as stall infra evidence, not a branch verdict (#3280)", async () => {
    const layout = fakeLayout({
      packages: ["apps/dev"],
      scripts: { "apps/dev": ["test"] },
    });
    const { exec, calls } = fakeExec([
      {
        match: (a) => a.includes("test"),
        result: {
          code: 124,
          stderr: "validation child stalled: 0ms CPU over 30000ms while wall time reached 1200000ms",
          infraEvidence: {
            kind: "stall",
            wallTimeMs: 1_200_000,
            sampleWindowMs: 30_000,
            cpuDeltaMs: 0,
          },
        },
      },
    ]);
    const result = await runFeedback(exec, {
      worktree: "afk/3280-stalled-suite",
      worktreeKind: "branch",
      scopes: ["apps/dev"],
      layout,
      now: fakeClock(1_200_000),
      baselineWorktree: "origin/main",
    });

    const check = result.checks.find((entry) => entry.name === "test:apps/dev");
    expect(check?.record.infra).toBe("stall");
    expect(check?.record.suspectInfra).toBeUndefined();
    expect(check?.record.summary).toContain("validation child stalled");
    expect(verdictIsEnvironment(result)).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it("records heavy admission timeout as infrastructure and never branch fault", async () => {
    const result = await runFeedback(async () => ({
      code: 1,
      stdout: "",
      stderr: "host heavy-validation admission timed out",
      infraEvidence: { kind: "admission-timeout", wallTimeMs: 60_000 },
    }), {
      worktree: "/repo",
      scopes: ["."],
      layout: fakeLayout({ packages: ["."], scripts: { ".": ["test"] } }),
      now: fakeClock(),
      root: "/repo",
      worktreeKind: "checkout",
      dirExists: () => true,
    });

    expect(result.checks[0]?.record.infra).toBe("admission-timeout");
    expect(verdictIsEnvironment(result)).toBe(true);
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
      exitCode: 0,
      durationMs: 1234,
      summary: "command exited 0",
    };
    expect(test?.record).toEqual(expected);
    // Sidecar line is the compact JSON of the record, schema-first.
    expect(result.sidecar).toContain(JSON.stringify(expected));
  });

  it("refuses a DECLARED checkout whose directory is gone, as infra, running nothing (#3041)", async () => {
    const layout = fakeLayout({
      packages: ["apps/dev"],
      scripts: { "apps/dev": ["test", "typecheck"] },
    });
    const { exec, calls } = fakeExec();
    const result = await runFeedback(exec, {
      worktree: "afk/3027-dispatch-survives-the-dispatcher-workers",
      worktreeKind: "checkout",
      root: "/repo",
      dirExists: () => false,
      scopes: ["apps/dev"],
      layout,
      now: fakeClock(),
    });

    expect(result.ok).toBe(false);
    // Not one command was composed, let alone run — an unrunnable gate judged
    // nothing, so it may not spend a re-seed round or park the branch.
    expect(calls).toEqual([]);
    expect(result.checks.map((ch) => ch.name)).toEqual(["validation:worktree-missing"]);
    // The routing that matters: INFRA, so the lifecycle takes the bounded
    // recovery path instead of `blocked:validation`.
    expect(verdictIsEnvironment(result)).toBe(true);
    expect(result.checks[0]?.record.summary).toContain(
      "validation worktree directory is missing",
    );
  });

  it("records the ABSOLUTE directory the executor ran in, not the branch token (#3041)", async () => {
    const layout = fakeLayout({
      packages: ["apps/dev"],
      scripts: { "apps/dev": ["typecheck"] },
    });
    // The AFK executor materialises the branch and reports back where it ran.
    const exec: Exec = async () => ({
      code: 0,
      stdout: "",
      stderr: "",
      commandDir: "/repo/.red/tmp/feedback/afk-3027-dispatch/apps/dev",
    });
    const result = await runFeedback(exec, {
      worktree: "afk/3027-dispatch",
      worktreeKind: "branch",
      scopes: ["apps/dev"],
      layout,
      now: fakeClock(),
    });

    const check = result.checks.find((ch) => ch.name === "typecheck:apps/dev");
    expect(check?.record.command).toBe(
      "pnpm -C /repo/.red/tmp/feedback/afk-3027-dispatch/apps/dev typecheck",
    );
  });

  it("records when compatibility setup skipped lifecycle scripts (#3268)", async () => {
    const layout = fakeLayout({
      packages: ["apps/dev"],
      scripts: { "apps/dev": ["test"] },
    });
    const exec: Exec = async () => ({
      code: 0,
      stdout: "",
      stderr: "",
      setup:
        "pnpm install --frozen-lockfile --ignore-scripts (fallback after custom core.hooksPath refusal; lifecycle scripts skipped)",
    });
    const result = await runFeedback(exec, {
      worktree: "afk/3268-setup-record",
      worktreeKind: "branch",
      scopes: ["apps/dev"],
      layout,
      now: fakeClock(),
    });

    const check = result.checks.find((entry) => entry.name === "test:apps/dev");
    expect(check?.record.setup).toContain("--ignore-scripts");
    expect(JSON.parse(result.sidecar.find((line) => line.includes('"test:apps/dev"'))!).setup).toContain(
      "lifecycle scripts skipped",
    );
  });

  it("flags a sub-second suite failure as suspect-infra in the record (#3041)", async () => {
    const layout = fakeLayout({
      packages: ["apps/dev"],
      scripts: { "apps/dev": ["typecheck"] },
    });
    const { exec } = fakeExec([
      { match: (a) => a.includes("typecheck"), result: { code: 1, stdout: "", stderr: "" } },
    ]);
    const result = await runFeedback(exec, {
      worktree: "afk/3027-dispatch",
      worktreeKind: "branch",
      scopes: ["apps/dev"],
      layout,
      // 1ms — the #3027 signature: a verdict reported before pnpm could start.
      now: fakeClock(1),
    });

    const check = result.checks.find((ch) => ch.name === "typecheck:apps/dev");
    expect(check?.record.durationMs).toBe(1);
    expect(check?.record.suspectInfra).toBe(true);
    expect(check?.record.summary).toContain("suspect-infra");
  });

  it("records a turbo-cached compiler diagnostic as a branch fault (#3773)", async () => {
    const layout = fakeLayout({
      packages: ["apps/dev"],
      scripts: { "apps/dev": ["typecheck"] },
    });
    const { exec } = fakeExec([
      {
        match: (a) => a.includes("typecheck"),
        result: {
          code: 2,
          stdout: "apps/dev/src/runtime/wire/boot.ts(649,21): error TS2345: Argument is not assignable",
        },
      },
    ]);
    const result = await runFeedback(exec, {
      worktree: "afk/3773-validation-evidence",
      worktreeKind: "branch",
      scopes: ["apps/dev"],
      layout,
      now: fakeClock(26),
    });

    const check = result.checks.find((ch) => ch.name === "typecheck:apps/dev");
    expect(check?.record.durationMs).toBe(26);
    expect(check?.record.exitCode).toBe(2);
    expect(check?.record.suspectInfra).toBeUndefined();
    expect(verdictIsEnvironment(result)).toBe(false);
  });

  it("leaves a plausibly-timed failure unflagged (#3041)", async () => {
    const layout = fakeLayout({
      packages: ["apps/dev"],
      scripts: { "apps/dev": ["typecheck"] },
    });
    const { exec } = fakeExec([
      { match: (a) => a.includes("typecheck"), result: { code: 1, stdout: "3 errors\n" } },
    ]);
    const result = await runFeedback(exec, {
      worktree: "afk/3027-dispatch",
      worktreeKind: "branch",
      scopes: ["apps/dev"],
      layout,
      now: fakeClock(9000),
    });

    const check = result.checks.find((ch) => ch.name === "typecheck:apps/dev");
    expect(check?.record.suspectInfra).toBeUndefined();
    expect(check?.record.summary).toBe("3 errors");
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

  it("runs validation subprocesses under a hermetic env contract so lane env cannot flip the verdict", async () => {
    const prevNamespace = process.env.RED_AFK_WORKERS_NAMESPACE;
    const prevWorkerId = process.env.RED_AFK_WORKER_ID;
    const prevIterDir = process.env.RED_AFK_ITER_DIR;
    const prevFlip = process.env.RED_AFK_GATE_TEST_FLIP_RESULT;
    process.env.RED_AFK_WORKERS_NAMESPACE = "scout-workers";
    process.env.RED_AFK_WORKER_ID = "scout-lane-worker";
    process.env.RED_AFK_ITER_DIR = "/tmp/scout-workers/scout-lane-worker/1234-a1";
    process.env.RED_AFK_GATE_TEST_FLIP_RESULT = "fail-if-inherited";
    try {
      const layout = fakeLayout({
        packages: ["apps/dev"],
        scripts: { "apps/dev": ["test"] },
      });
      const seen: NodeJS.ProcessEnv[] = [];
      const exec: Exec = async (_args, opts) => {
        if (!opts?.env) {
          return { code: 67, stdout: "", stderr: "validation subprocess env was implicit" };
        }
        const env = opts?.env ?? {};
        seen.push(env);
        if (
          env.RED_AFK_WORKERS_NAMESPACE ||
          env.RED_AFK_WORKER_ID ||
          env.RED_AFK_ITER_DIR ||
          env.RED_AFK_GATE_TEST_FLIP_RESULT
        ) {
          return { code: 66, stdout: "", stderr: "lane env leaked into validation subprocess" };
        }
        return { code: 0, stdout: "ok", stderr: "" };
      };

      const result = await runFeedback(exec, {
        worktree: "/wt",
        scopes: ["apps/dev"],
        layout,
        now: fakeClock(),
      });

      expect(result.ok).toBe(true);
      expect(seen).toHaveLength(1);
      expect(seen[0]).toBeDefined();
      expect(seen[0]?.RED_AFK_WORKERS_NAMESPACE).toBeUndefined();
      expect(seen[0]?.RED_AFK_WORKER_ID).toBeUndefined();
      expect(seen[0]?.RED_AFK_ITER_DIR).toBeUndefined();
      expect(seen[0]?.RED_AFK_GATE_TEST_FLIP_RESULT).toBeUndefined();
    } finally {
      if (prevNamespace === undefined) delete process.env.RED_AFK_WORKERS_NAMESPACE;
      else process.env.RED_AFK_WORKERS_NAMESPACE = prevNamespace;
      if (prevWorkerId === undefined) delete process.env.RED_AFK_WORKER_ID;
      else process.env.RED_AFK_WORKER_ID = prevWorkerId;
      if (prevIterDir === undefined) delete process.env.RED_AFK_ITER_DIR;
      else process.env.RED_AFK_ITER_DIR = prevIterDir;
      if (prevFlip === undefined) delete process.env.RED_AFK_GATE_TEST_FLIP_RESULT;
      else process.env.RED_AFK_GATE_TEST_FLIP_RESULT = prevFlip;
    }
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

  it("carries secret-free resource evidence on the validation record", () => {
    const resources = {
      source: "cgroup-v2" as const,
      sampled_before: "2026-08-13T00:00:00.000Z",
      sampled_after: "2026-08-13T00:01:00.000Z",
      memory_current_before_bytes: 100,
      memory_current_after_bytes: 150,
      memory_peak_bytes: 200,
      memory_max_bytes: 1_000,
      cpu_usage_delta_usec: 50,
      cpu_throttled_delta_usec: 10,
      pids_peak: 4,
      memory_events_delta: { max: 1 },
      pids_events_delta: {},
    };
    expect(buildValidationRecord({ name: "typecheck:root", status: "passed", resources })).toMatchObject({
      schema: "red.afk.validation.v1",
      resources,
    });
  });

  it("summarizes pass and fail output", () => {
    expect(outputSummary("passed", "anything")).toBe("command exited 0");
    expect(outputSummary("failed", "")).toBe("command exited non-zero");
    expect(outputSummary("failed", "line a\nline b\n")).toBe("line a line b");
    const long = `${"x".repeat(2000)}\n`;
    expect(outputSummary("failed", long).length).toBe(1000);
  });

  it("names the failing test instead of only reporting how many failed", () => {
    // Verbatim shape of the vitest output that parked #1919: the identities sit
    // far above the counters, so the pre-#1929 tail-only summary reported
    // "2 failed" and dropped both names. The gate had this in hand all along.
    const vitest = [
      " FAIL  tests/monitor.test.ts > monitor — compact dashboard > renders one worker",
      "AssertionError: expected '1 workers · proving…' to be '1 workers · +10…'",
      ...Array.from({ length: 30 }, (_, i) => `noise line ${i}`),
      " Test Files  1 failed | 215 passed (216)",
      "      Tests  2 failed | 3750 passed (3752)",
    ].join("\n");
    const summary = outputSummary("failed", vitest);
    expect(summary).toContain("tests/monitor.test.ts");
    expect(summary).toContain("renders one worker");
    expect(summary.startsWith("failing: ")).toBe(true);
  });

  it("matches failure identities through ANSI colour codes", () => {
    const coloured = "[31m FAIL [39m tests/a.test.ts > boom\nTests 1 failed";
    expect(namedFailures(coloured)).toEqual(["FAIL tests/a.test.ts > boom"]);
  });

  it("names cargo failures too, deduped and capped", () => {
    const cargo = [
      "test net::sends ... FAILED",
      "test net::sends ... FAILED",
      ...Array.from({ length: 8 }, (_, i) => `test x::case_${i} ... FAILED`),
      "test result: FAILED. 9 passed; 9 failed",
    ].join("\n");
    const named = namedFailures(cargo);
    expect(named[0]).toBe("test net::sends ... FAILED");
    expect(named.length).toBe(5);
    expect(new Set(named).size).toBe(named.length);
  });

  it("falls back to the tail when the runner names nothing recognisable", () => {
    // No invented identity: an unrecognised runner keeps the old honest behaviour.
    expect(outputSummary("failed", "segfault\ncore dumped")).toBe("segfault core dumped");
    expect(namedFailures("segfault\ncore dumped")).toEqual([]);
  });
});

describe("decideBaselineDiffGate", () => {
  it("a branch-only failure is BRANCH-FAULT", () => {
    expect(decideBaselineDiffGate(["test:apps/dev"], [])).toEqual({
      verdict: "branch-fault",
      shouldBlock: true,
      blockingFailures: ["test:apps/dev"],
      inconclusiveFailures: [],
    });
  });

  it("a failure reproduced on the baseline is INCONCLUSIVE — and still blocks the branch (#2380)", () => {
    expect(decideBaselineDiffGate(["test:apps/dev"], ["test:apps/dev"])).toEqual({
      verdict: "inconclusive",
      shouldBlock: true,
      blockingFailures: [],
      inconclusiveFailures: ["test:apps/dev"],
    });
  });

  it("a mix is BRANCH-FAULT: one real new failure outranks any number of inconclusive ones", () => {
    expect(
      decideBaselineDiffGate(
        ["test:apps/dev", "typecheck:apps/dev", "test:apps/dev"],
        ["test:apps/dev", "lint:apps/dev"],
      ),
    ).toEqual({
      verdict: "branch-fault",
      shouldBlock: true,
      blockingFailures: ["typecheck:apps/dev"],
      inconclusiveFailures: ["test:apps/dev"],
    });
  });

  it("no branch failures at all is CLEAN — the probe never invents a block", () => {
    expect(decideBaselineDiffGate([], ["test:apps/dev"])).toEqual({
      verdict: "clean",
      shouldBlock: false,
      blockingFailures: [],
      inconclusiveFailures: [],
    });
  });
});

// AFK runner improvement: `verdictIsEnvironment` distinguishes a feedback
// gate failure with an INFRA root cause (worktree add / submodule init / pnpm
// install / OOM / ENOENT — the gate's environment is broken, NOT the worker's
// code) from a SEMANTIC failure (the worker's tests/typecheck/lint/build
// actually failed for a code reason). The detection is substring-based on
// purpose: it has to survive pnpm's error-wrapping, multi-line output, and
// minor message drift.
describe("verdictIsEnvironment — INFRA root cause detection", () => {
  function green(): RunFeedbackResult {
    return { ok: true, checks: [], sidecar: [], baselineInconclusive: [], quarantined: [] };
  }
  function failedCheck(
    name: string,
    summary: string,
    command = "pnpm -C apps/dev test",
  ): RunFeedbackResult {
    const record = buildValidationRecord({ name, status: "failed", command, summary });
    const check: FeedbackCheck = { name, script: "test", label: "apps/dev", scope: "apps/dev", status: "failed", record };
    return {
      ok: false,
      checks: [check],
      sidecar: [JSON.stringify(record)],
      baselineInconclusive: [],
      quarantined: [],
    };
  }

  it("a green gate is never INFRA", () => {
    expect(verdictIsEnvironment(green())).toBe(false);
  });

  it("a failed check with no infra marker is SEMANTIC (not INFRA)", () => {
    const result = failedCheck("test:apps/dev", "FAIL tests/foo.test.ts > bar\nexpected 1 to equal 2");
    expect(verdictIsEnvironment(result)).toBe(false);
  });

  it("matches the worktree-setup failed marker", () => {
    const result = failedCheck("test:apps/dev", "feedback worktree setup failed for afk/wX/123-slug; validation blocked");
    expect(verdictIsEnvironment(result)).toBe(true);
  });

  it("matches the submodule-init failed marker", () => {
    const result = failedCheck("test:apps/dev", "feedback worktree submodule init failed for afk/wX/123-slug (exit 1)");
    expect(verdictIsEnvironment(result)).toBe(true);
  });

  it("matches the install-failed marker", () => {
    const result = failedCheck("test:apps/dev", "feedback worktree install failed for afk/wX/123-slug (exit 1)");
    expect(verdictIsEnvironment(result)).toBe(true);
  });

  it("classifies dependency files vanishing mid-gate as INFRA", () => {
    const missingModule = failedCheck(
      "test:apps/dev",
      "Error [ERR_MODULE_NOT_FOUND]: Cannot find module '/repo/node_modules/.pnpm/tinypool@1.1.1/node_modules/tinypool/dist/entry/process.js' imported from /repo/node_modules/.pnpm/vitest@2.1.9/node_modules/vitest/dist/chunks/resolveConfig.js",
    );
    const missingFile = failedCheck(
      "test:apps/dev",
      "Error: ENOENT: no such file or directory, open '/repo/node_modules/.pnpm/tinypool@1.1.1/node_modules/tinypool/dist/entry/process.js'",
    );

    expect(verdictIsEnvironment(missingModule)).toBe(true);
    expect(verdictIsEnvironment(missingFile)).toBe(true);
  });

  it("matches the OOM-killer signature (exit 137 / SIGKILL)", () => {
    const a = failedCheck("test:apps/dev", "vitest worker killed by SIGKILL");
    const b = failedCheck("test:apps/dev", "pnpm: signal SIGKILL");
    const c = failedCheck("test:apps/dev", "ELIFECYCLE  Command failed with exit code 137");
    expect(verdictIsEnvironment(a)).toBe(true);
    expect(verdictIsEnvironment(b)).toBe(true);
    expect(verdictIsEnvironment(c)).toBe(true);
  });

  it("does NOT false-positive on the substring `137` inside a hex string", () => {
    // `\b137\b` requires word boundaries; an arbitrary hex token is a single
    // word and should NOT trip the OOM heuristic.
    const result = failedCheck("test:apps/dev", "hash 0x137abf computed correctly");
    expect(verdictIsEnvironment(result)).toBe(false);
  });

  it("matches a maxBuffer capture overflow (green-but-verbose suite, not a test failure)", () => {
    // exec.ts surfaces the literal `maxBuffer length exceeded` for an output
    // overflow. The suite may have passed — only its output was too large — so
    // Verdict reads it as an environment/config cause, never branch fault.
    const result = failedCheck(
      "test:apps/dev",
      "command output exceeded the capture ceiling (maxBuffer length exceeded); stdout maxBuffer length exceeded",
    );
    expect(verdictIsEnvironment(result)).toBe(true);
  });

  it("trusts a clean structured exit over misleading infra-looking text", () => {
    const record = buildValidationRecord({
      name: "test:apps/dev",
      status: "failed",
      command: "pnpm -C apps/dev test",
      exitCode: 0,
      summary: "stderr mentioned feedback worktree install failed, but the runner reported a clean exit",
    });
    const result: RunFeedbackResult = {
      ok: false,
      checks: [
        { name: "test:apps/dev", script: "test", label: "apps/dev", scope: "apps/dev", status: "failed", record },
      ],
      sidecar: [JSON.stringify(record)],
      baselineInconclusive: [],
      quarantined: [],
    };

    expect(verdictIsEnvironment(result)).toBe(false);
  });

  it("preserves keyword fallback when no structured exit evidence exists", () => {
    const result = failedCheck("test:apps/dev", "feedback worktree install failed for afk/wX/123-slug (exit 1)");
    expect(verdictIsEnvironment(result)).toBe(true);
  });

  it("only inspects FAILED checks (passed checks carry no verdict)", () => {
    // A passing `test:root` and a failing `test:apps/dev` with a SEMANTIC error —
    // should NOT be INFRA just because the green check exists.
    const passRecord = buildValidationRecord({
      name: "test:root",
      status: "passed",
      command: "pnpm -C . test",
      summary: "command exited 0",
    });
    const failRecord = buildValidationRecord({
      name: "test:apps/dev",
      status: "failed",
      command: "pnpm -C apps/dev test",
      summary: "expected 1 to equal 2",
    });
    const result: RunFeedbackResult = {
      ok: false,
      checks: [
        { name: "test:root", script: "test", label: "root", scope: ".", status: "passed", record: passRecord },
        { name: "test:apps/dev", script: "test", label: "apps/dev", scope: "apps/dev", status: "failed", record: failRecord },
      ],
      sidecar: [JSON.stringify(passRecord), JSON.stringify(failRecord)],
      baselineInconclusive: [],
      quarantined: [],
    };
    expect(verdictIsEnvironment(result)).toBe(false);
  });
});

// Baseline COMPARISON only (#2380). When `runFeedback` is called with a
// `baselineWorktree` and the gate fails, the failing checks are re-run against
// the baseline SOLELY to classify the branch verdict: `branch-fault` when a
// failure is green on the baseline, `inconclusive` when every failure also
// reproduces there. Both block THIS branch and nothing else — the probe files
// no repair issue, downgrades no check, and never gates anyone else's landing.
describe("runFeedback — baseline comparison classifies the branch verdict", () => {
  function makeLayout(): PackageLayout {
    return {
      hasPackage: (scope) => scope === "." || scope === "apps/dev",
      hasScript: (scope) => scope === "." || scope === "apps/dev",
    };
  }
  function recorder(): { exec: Exec; calls: string[] } {
    const calls: string[] = [];
    const exec: Exec = async (args) => {
      calls.push(args.slice(1).join(" "));
      // The exec executor signature is `pnpm -C <dir> <script>`; route by
      // whether the args contain "main" (the baseline worktree path) or the
      // worker branch path. For the test we use a fixed branch name.
      const joined = calls[calls.length - 1]!;
      // First call: worker's branch → always fail test on apps/dev.
      // Second call (baseline probe): if test on apps/dev → also fail (baseline-fail).
      //                         if typecheck on apps/dev → pass.
      // We achieve this with a simple state machine keyed on call order.
      if (joined.includes("typecheck")) {
        return { code: 0, stdout: "ok", stderr: "" };
      }
      // All test invocations fail.
      return { code: 1, stdout: "FAIL", stderr: "expected 1 to equal 2" };
    };
    return { exec, calls };
  }
  function counter(): { exec: Exec; counts: Record<string, number> } {
    const counts: Record<string, number> = {};
    const exec: Exec = async (args) => {
      const joined = args.slice(1).join(" ");
      const key = joined.replace(/\/main\b|\/afk\/.+$/, "/<branch>");
      counts[key] = (counts[key] ?? 0) + 1;
      return { code: 0, stdout: "", stderr: "" };
    };
    return { exec, counts };
  }

  it("the happy path is unchanged: a green gate skips the baseline probe entirely", async () => {
    const counts: Record<string, number> = {};
    const exec: Exec = async (args) => {
      const dir = args[args.indexOf("-C") + 1] ?? "";
      const script = args[args.length - 1] ?? "";
      const key = `${dir}::${script}`;
      counts[key] = (counts[key] ?? 0) + 1;
      return { code: 0, stdout: "ok", stderr: "" };
    };
    const result = await runFeedback(exec, {
      worktree: "afk/wX/123-slug",
      scopes: ["apps/dev"],
      layout: makeLayout(),
      now: () => 0,
      baselineWorktree: "main",
    });
    expect(result.ok).toBe(true);
    // 4 scripts × 1 scope + 1 workspace typecheck = 5 worker invocations;
    // ZERO baseline probes (the gate was green, no reason to probe).
    const baselineCalls = Object.entries(counts).filter(([k]) => k.includes("main"));
    expect(baselineCalls).toEqual([]);
    expect(result.baselineProbeRan).toBeUndefined();
    expect(result.baselineVerdict).toBeUndefined();
    expect(Object.values(counts).reduce((a, b) => a + b, 0)).toBe(5);
  });

  it("a failing check that ALSO fails on the baseline is INCONCLUSIVE — it still blocks the branch, it is never downgraded", async () => {
    // The test runner does typecheck=0, test=1, etc. The worker's branch fails
    // test on apps/dev; the baseline also fails test on apps/dev → inconclusive.
    const calls: Array<{ dir: string; script: string; code: number }> = [];
    const exec: Exec = async (args) => {
      const cIdx = args.indexOf("-C");
      const dir = cIdx >= 0 ? args[cIdx + 1] ?? "" : "";
      const script = args[args.length - 1] ?? "";
      calls.push({ dir, script, code: 0 });
      // Simulate: typecheck passes everywhere; test fails on both worker + baseline.
      if (script === "test") return { code: 1, stdout: "FAIL", stderr: "expected 1 to equal 2" };
      return { code: 0, stdout: "ok", stderr: "" };
    };
    const result = await runFeedback(exec, {
      worktree: "afk/wX/123-slug",
      scopes: ["apps/dev"],
      layout: makeLayout(),
      now: fakeClock(1000),
      baselineWorktree: "main",
    });
    // test:apps/dev failed on worker AND on baseline → inconclusive; the gate
    // still FAILS so the branch parks `blocked:validation` with the evidence.
    expect(result.ok).toBe(false);
    expect(result.baselineVerdict).toBe("inconclusive");
    expect(result.baselineInconclusive).toEqual(["test:apps/dev"]);
    expect(result.baselineProbeRan).toBe(true);
    const testCheck = result.checks.find((c) => c.name === "test:apps/dev")!;
    expect(testCheck.status).toBe("failed");
    // The comparison evidence rides on the sidecar summary — that IS the park's
    // explanation; nothing is filed anywhere else.
    expect(testCheck.record.summary).toBe(
      "inconclusive: also fails on the baseline — FAIL expected 1 to equal 2",
    );
  });

  it("a failing check that does NOT also fail on the baseline is BRANCH-FAULT (real worker bug)", async () => {
    const exec: Exec = async (args) => {
      const script = args[args.length - 1] ?? "";
      const dir = args[args.indexOf("-C") + 1] ?? "";
      // Baseline test passes; worker's test fails.
      if (script === "test" && !dir.includes("main")) return { code: 1, stdout: "FAIL", stderr: "bad code" };
      return { code: 0, stdout: "ok", stderr: "" };
    };
    const result = await runFeedback(exec, {
      worktree: "afk/wX/123-slug",
      scopes: ["apps/dev"],
      layout: makeLayout(),
      now: fakeClock(1000),
      baselineWorktree: "main",
    });
    expect(result.ok).toBe(false);
    expect(result.baselineVerdict).toBe("branch-fault");
    expect(result.baselineInconclusive).toEqual([]);
    expect(result.baselineProbeRan).toBe(true);
    const testCheck = result.checks.find((c) => c.name === "test:apps/dev")!;
    expect(testCheck.status).toBe("failed");
  });

  it("makes a baseline OOM an inconclusive environment round, never branch fault", async () => {
    const exec: Exec = async (args) => {
      const script = args[args.length - 1] ?? "";
      const dir = args[args.indexOf("-C") + 1] ?? "";
      const isBaseline = dir.includes("main");
      // The worker's test fails with a clean assertion; the SAME test OOMs on the
      // baseline (SIGKILL 137 + a V8 heap-exhaustion signature) — the exact
      // resource-constrained-host false-positive #2300 hit.
      if (script === "test" && !isBaseline) return { code: 1, stdout: "FAIL", stderr: "expected 1 to equal 2" };
      if (script === "test" && isBaseline)
        return {
          code: 137,
          stdout: "",
          stderr: "<--- Last few GCs --->\nFATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory",
        };
      return { code: 0, stdout: "ok", stderr: "" };
    };
    const result = await runFeedback(exec, {
      worktree: "afk/wX/123-slug",
      scopes: ["apps/dev"],
      layout: makeLayout(),
      now: fakeClock(1000),
      baselineWorktree: "main",
    });
    expect(result.baselineProbeRan).toBe(true);
    expect(result.baselineVerdict).toBe("inconclusive");
    expect(result.baselineInconclusive).toEqual(["test:apps/dev"]);
    expect(result.ok).toBe(false);
    expect(verdictIsEnvironment(result)).toBe(true);
    const testCheck = result.checks.find((c) => c.name === "test:apps/dev")!;
    expect(testCheck.status).toBe("failed");
    expect(testCheck.record.summary).toContain("baseline environment failure");
    expect(testCheck.record.summary).not.toContain("also fails on the baseline");
  });

  it("a mix: one reproduced on the baseline, one worker-only → verdict is BRANCH-FAULT (a real new failure outranks an inconclusive one)", async () => {
    const exec: Exec = async (args) => {
      const script = args[args.length - 1] ?? "";
      const dir = args[args.indexOf("-C") + 1] ?? "";
      // test on apps/dev: fails on BOTH (pre-existing).
      if (script === "test" && dir.endsWith("apps/dev")) return { code: 1, stdout: "FAIL", stderr: "pre-existing" };
      // typecheck on apps/dev: fails ONLY on worker branch (real bug).
      if (script === "typecheck" && !dir.includes("main")) return { code: 1, stdout: "FAIL", stderr: "tsc error" };
      return { code: 0, stdout: "ok", stderr: "" };
    };
    const result = await runFeedback(exec, {
      worktree: "afk/wX/123-slug",
      scopes: ["apps/dev"],
      layout: makeLayout(),
      now: fakeClock(1000),
      baselineWorktree: "main",
    });
    expect(result.ok).toBe(false);
    expect(result.baselineVerdict).toBe("branch-fault");
    expect(result.baselineInconclusive).toEqual(["test:apps/dev"]);
    const testCheck = result.checks.find((c) => c.name === "test:apps/dev")!;
    expect(testCheck.status).toBe("failed");
    const typecheckCheck = result.checks.find((c) => c.name === "typecheck:apps/dev")!;
    expect(typecheckCheck.status).toBe("failed");
  });

  it("without `baselineWorktree`, the gate behaves exactly as before (no probe, no comparison)", async () => {
    const calls: string[] = [];
    const exec: Exec = async (args) => {
      calls.push(args.slice(1).join(" "));
      return { code: 1, stdout: "FAIL", stderr: "expected 1 to equal 2" };
    };
    const result = await runFeedback(exec, {
      worktree: "afk/wX/123-slug",
      scopes: ["apps/dev"],
      layout: makeLayout(),
      now: () => 0,
      // no baselineWorktree
    });
    expect(result.ok).toBe(false);
    expect(result.baselineInconclusive).toEqual([]);
    expect(result.baselineVerdict).toBeUndefined();
    // 4 scripts × 1 scope + 1 workspace typecheck = 5 invocations, no probe.
    expect(calls.length).toBe(5);
  });

  it("makes a baseline worktree setup failure an inconclusive environment round", async () => {
    const exec: Exec = async (args) => {
      const script = args[args.length - 1] ?? "";
      const dir = args[args.indexOf("-C") + 1] ?? "";
      const isBaseline = dir.includes("main");
      if (script === "test" && !isBaseline) {
        return { code: 1, stdout: "FAIL", stderr: "expected 1 to equal 2" };
      }
      if (isBaseline) {
        // The baseline executor returns the sentinel when worktree setup failed.
        return {
          code: 1,
          stdout: "",
          stderr:
            "feedback worktree setup failed for main; validation blocked " +
            "(worktree add failed: fatal: transient fetch failure)",
        };
      }
      return { code: 0, stdout: "ok", stderr: "" };
    };
    const result = await runFeedback(exec, {
      worktree: "afk/wX/123-slug",
      scopes: ["apps/dev"],
      layout: makeLayout(),
      now: fakeClock(1000),
      baselineWorktree: "main",
    });
    expect(result.ok).toBe(false);
    expect(result.baselineProbeRan).toBe(true);
    expect(result.baselineVerdict).toBe("inconclusive");
    expect(result.baselineInconclusive).toEqual(["test:apps/dev"]);
    expect(verdictIsEnvironment(result)).toBe(true);
    const testCheck = result.checks.find((c) => c.name === "test:apps/dev")!;
    expect(testCheck.status).toBe("failed");
    expect(testCheck.record.summary).toContain("the baseline could not be built");
    expect(testCheck.record.summary).toContain("transient fetch failure");
    expect(testCheck.record.summary).not.toContain("also fails on the baseline");
  });
});

// Workspace typecheck: a whole-workspace `typecheck` runs once after the
// scoped checks, regardless of which packages were touched. This catches
// cross-package type breaks where a slice touches only package A but breaks
// package B's typecheck (the concrete incident from 2026-06-22: #822 broke
// apps/dev typecheck; #825/#826 only touched apps/memory and passed their
// scoped gate, landing on a red main).
describe("runFeedback — workspace typecheck", () => {
  function workspaceLayout(): PackageLayout {
    return fakeLayout({
      packages: [".", "apps/dev"],
      scripts: { ".": ["typecheck"], "apps/dev": ["test", "typecheck"] },
    });
  }

  it("runs workspace typecheck after scoped checks when root is not in scopes", async () => {
    const { exec, calls } = fakeExec();
    const result = await runFeedback(exec, {
      worktree: "/wt",
      scopes: ["apps/dev"],
      layout: workspaceLayout(),
      now: fakeClock(),
    });

    expect(result.ok).toBe(true);
    const c = joined(calls);
    // Scoped: test + typecheck for apps/dev (lint/build not declared → skipped).
    expect(c).toContain("pnpm -C /wt/apps/dev test");
    expect(c).toContain("pnpm -C /wt/apps/dev typecheck");
    // Workspace-wide typecheck at root runs once.
    expect(c.filter((x) => x === "pnpm -C /wt typecheck").length).toBe(1);
    // Exactly one typecheck:workspace check in the result.
    const ws = result.checks.find((ch) => ch.name === "typecheck:workspace");
    expect(ws?.status).toBe("passed");
    expect(ws?.record.command).toBe("pnpm -C /wt typecheck");
  });

  it("skips workspace typecheck when root is already a touched scope", async () => {
    const { exec, calls } = fakeExec();
    await runFeedback(exec, {
      worktree: "/wt",
      scopes: [".", "apps/dev"],
      layout: workspaceLayout(),
      now: fakeClock(),
    });

    const c = joined(calls);
    // Root typecheck runs once (from the scoped loop as typecheck:root).
    expect(c.filter((x) => x === "pnpm -C /wt typecheck").length).toBe(1);
    // No extra typecheck:workspace check.
    expect(c.some((x) => x === "pnpm -C /wt typecheck")).toBe(true); // only the scoped one
  });

  it("blocks the merge when workspace typecheck fails", async () => {
    const { exec } = fakeExec([
      {
        match: (a) => a.includes("typecheck") && !a.includes("apps/dev"),
        result: { code: 1, stdout: "src/core/supervisor.ts: error TS2304: Cannot find name 'recoveryDecision'\n" },
      },
    ]);
    const result = await runFeedback(exec, {
      worktree: "/wt",
      scopes: ["apps/memory"],
      layout: fakeLayout({
        packages: [".", "apps/memory"],
        scripts: { ".": ["typecheck"], "apps/memory": ["typecheck"] },
      }),
      now: fakeClock(),
    });

    expect(result.ok).toBe(false);
    const ws = result.checks.find((ch) => ch.name === "typecheck:workspace");
    expect(ws?.status).toBe("failed");
    expect(ws?.record.command).toBe("pnpm -C /wt typecheck");
    expect(ws?.record.summary).toContain("recoveryDecision");
  });

  it("scoped test/lint/build stay per-touched-package (only typecheck goes workspace)", async () => {
    const { exec, calls } = fakeExec();
    const layout = fakeLayout({
      packages: [".", "apps/dev"],
      scripts: { ".": ["typecheck", "test", "lint", "build"], "apps/dev": ["test", "lint"] },
    });
    await runFeedback(exec, {
      worktree: "/wt",
      scopes: ["apps/dev"],
      layout,
      now: fakeClock(),
    });

    const c = joined(calls);
    // Scoped scripts run only for apps/dev.
    expect(c).toContain("pnpm -C /wt/apps/dev test");
    expect(c).toContain("pnpm -C /wt/apps/dev lint");
    // test/lint/build do NOT run at root for the workspace check — only typecheck.
    expect(c.some((x) => x === "pnpm -C /wt test")).toBe(false);
    expect(c.some((x) => x === "pnpm -C /wt lint")).toBe(false);
    expect(c.some((x) => x === "pnpm -C /wt build")).toBe(false);
    // Only the workspace typecheck fires at root.
    expect(c).toContain("pnpm -C /wt typecheck");
  });

  it("skips workspace typecheck when root has no typecheck script", async () => {
    const layout = fakeLayout({
      packages: [".", "apps/dev"],
      scripts: { ".": ["build"], "apps/dev": ["test"] },
    });
    const { exec, calls } = fakeExec();
    await runFeedback(exec, {
      worktree: "/wt",
      scopes: ["apps/dev"],
      layout,
      now: fakeClock(),
    });

    const c = joined(calls);
    expect(c.some((x) => x.includes("/wt typecheck"))).toBe(false);
  });

  it("skips workspace typecheck when there are no scopes (no-package repo)", async () => {
    const { exec, calls } = fakeExec();
    await runFeedback(exec, {
      worktree: "/wt",
      scopes: [],
      layout: fakeLayout({ packages: [] }),
      now: fakeClock(),
    });

    expect(calls).toEqual([]);
  });

  it("marks workspace typecheck INCONCLUSIVE when the baseline also fails — and still fails the gate", async () => {
    const exec: Exec = async (args) => {
      const dir = args[args.indexOf("-C") + 1] ?? "";
      const script = args[args.length - 1] ?? "";
      // typecheck fails everywhere (worker AND baseline) — inconclusive.
      if (script === "typecheck") return { code: 1, stdout: "tsc: error TS2304", stderr: "" };
      return { code: 0, stdout: "ok", stderr: "" };
    };
    const result = await runFeedback(exec, {
      worktree: "afk/wX/123-slug",
      scopes: ["apps/dev"],
      layout: workspaceLayout(),
      now: fakeClock(1000),
      baselineWorktree: "main",
    });

    // typecheck:apps/dev and typecheck:workspace both fail on worker AND baseline.
    expect(result.ok).toBe(false);
    expect(result.baselineVerdict).toBe("inconclusive");
    expect(result.baselineInconclusive).toContain("typecheck:workspace");
    const ws = result.checks.find((c) => c.name === "typecheck:workspace")!;
    expect(ws.status).toBe("failed");
    expect(ws.record.summary).toContain("inconclusive: also fails on the baseline");
  });

  it("attributes workspace typecheck to the BRANCH when only the worker's branch fails it", async () => {
    const exec: Exec = async (args) => {
      const dir = args[args.indexOf("-C") + 1] ?? "";
      const script = args[args.length - 1] ?? "";
      // Workspace typecheck fails on worker branch only; passes on baseline.
      if (script === "typecheck" && !dir.includes("main")) return { code: 1, stdout: "tsc error", stderr: "" };
      return { code: 0, stdout: "ok", stderr: "" };
    };
    const result = await runFeedback(exec, {
      worktree: "afk/wX/123-slug",
      scopes: ["apps/dev"],
      layout: workspaceLayout(),
      now: fakeClock(1000),
      baselineWorktree: "main",
    });

    expect(result.ok).toBe(false);
    expect(result.baselineVerdict).toBe("branch-fault");
    expect(result.baselineInconclusive).not.toContain("typecheck:workspace");
    const ws = result.checks.find((c) => c.name === "typecheck:workspace")!;
    expect(ws.status).toBe("failed");
  });
});
