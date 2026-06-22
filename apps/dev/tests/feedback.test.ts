import { describe, expect, it } from "vitest";
import {
  buildValidationRecord,
  isInfraFeedbackFailure,
  nearestPackageScope,
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

// AFK runner improvement: `isInfraFeedbackFailure` distinguishes a feedback
// gate failure with an INFRA root cause (worktree add / submodule init / pnpm
// install / OOM / ENOENT — the gate's environment is broken, NOT the worker's
// code) from a SEMANTIC failure (the worker's tests/typecheck/lint/build
// actually failed for a code reason). The detection is substring-based on
// purpose: it has to survive pnpm's error-wrapping, multi-line output, and
// minor message drift.
describe("isInfraFeedbackFailure — INFRA root cause detection", () => {
  function green(): RunFeedbackResult {
    return { ok: true, checks: [], sidecar: [], baselineDowngraded: [] };
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
      baselineDowngraded: [],
    };
  }

  it("a green gate is never INFRA", () => {
    expect(isInfraFeedbackFailure(green())).toBe(false);
  });

  it("a failed check with no infra marker is SEMANTIC (not INFRA)", () => {
    const result = failedCheck("test:apps/dev", "FAIL tests/foo.test.ts > bar\nexpected 1 to equal 2");
    expect(isInfraFeedbackFailure(result)).toBe(false);
  });

  it("matches the worktree-setup failed marker", () => {
    const result = failedCheck("test:apps/dev", "feedback worktree setup failed for afk/wX/123-slug; validation blocked");
    expect(isInfraFeedbackFailure(result)).toBe(true);
  });

  it("matches the submodule-init failed marker", () => {
    const result = failedCheck("test:apps/dev", "feedback worktree submodule init failed for afk/wX/123-slug (exit 1)");
    expect(isInfraFeedbackFailure(result)).toBe(true);
  });

  it("matches the install-failed marker", () => {
    const result = failedCheck("test:apps/dev", "feedback worktree install failed for afk/wX/123-slug (exit 1)");
    expect(isInfraFeedbackFailure(result)).toBe(true);
  });

  it("matches the OOM-killer signature (exit 137 / SIGKILL)", () => {
    const a = failedCheck("test:apps/dev", "vitest worker killed by SIGKILL");
    const b = failedCheck("test:apps/dev", "pnpm: signal SIGKILL");
    const c = failedCheck("test:apps/dev", "ELIFECYCLE  Command failed with exit code 137");
    expect(isInfraFeedbackFailure(a)).toBe(true);
    expect(isInfraFeedbackFailure(b)).toBe(true);
    expect(isInfraFeedbackFailure(c)).toBe(true);
  });

  it("does NOT false-positive on the substring `137` inside a hex string", () => {
    // `\b137\b` requires word boundaries; an arbitrary hex token is a single
    // word and should NOT trip the OOM heuristic.
    const result = failedCheck("test:apps/dev", "hash 0x137abf computed correctly");
    expect(isInfraFeedbackFailure(result)).toBe(false);
  });

  it("matches a maxBuffer capture overflow (green-but-verbose suite, not a test failure)", () => {
    // exec.ts surfaces the literal `maxBuffer length exceeded` for an output
    // overflow. The suite may have passed — only its output was too large — so
    // it is an INFRA/config problem, routed through validation-infra recovery.
    const result = failedCheck(
      "test:apps/dev",
      "command output exceeded the capture ceiling (maxBuffer length exceeded); stdout maxBuffer length exceeded",
    );
    expect(isInfraFeedbackFailure(result)).toBe(true);
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
      baselineDowngraded: [],
    };
    expect(isInfraFeedbackFailure(result)).toBe(false);
  });
});

// AFK runner improvement: when `runFeedback` is called with a `baselineWorktree`
// and the gate fails, the failing checks are re-run against the baseline and
// any check that also fails there is downgraded from `failed` to
// `skipped (pre-existing failure on baseline)`. The happy path is unchanged
// (the probe is gated on the gate failing). This is the cause of the
// #791/#792/#793/#794 false-positive `blocked:validation` cases: a pre-existing
// test failure on main that the worker's branch had nothing to do with.
describe("runFeedback — baseline probe downgrades pre-existing failures", () => {
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
    expect(Object.values(counts).reduce((a, b) => a + b, 0)).toBe(5);
  });

  it("a failing check is downgraded when the baseline also fails (pre-existing flake)", async () => {
    // The test runner does typecheck=0, test=1, etc. The worker's branch fails
    // test on apps/dev; the baseline also fails test on apps/dev → downgraded.
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
      now: () => 0,
      baselineWorktree: "main",
    });
    // test:apps/dev failed on worker AND on baseline → downgraded; gate passes.
    expect(result.ok).toBe(true);
    expect(result.baselineDowngraded).toEqual(["test:apps/dev"]);
    const testCheck = result.checks.find((c) => c.name === "test:apps/dev")!;
    expect(testCheck.status).toBe("skipped");
    expect(testCheck.record.summary).toBe("pre-existing failure on baseline");
  });

  it("a failing check that does NOT also fail on the baseline stays `failed` (real worker bug)", async () => {
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
      now: () => 0,
      baselineWorktree: "main",
    });
    expect(result.ok).toBe(false);
    expect(result.baselineDowngraded).toEqual([]);
    const testCheck = result.checks.find((c) => c.name === "test:apps/dev")!;
    expect(testCheck.status).toBe("failed");
  });

  it("a mix: one baseline-failing, one worker-only-failing → only the second blocks the gate", async () => {
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
      now: () => 0,
      baselineWorktree: "main",
    });
    expect(result.ok).toBe(false);
    expect(result.baselineDowngraded).toEqual(["test:apps/dev"]);
    const testCheck = result.checks.find((c) => c.name === "test:apps/dev")!;
    expect(testCheck.status).toBe("skipped");
    const typecheckCheck = result.checks.find((c) => c.name === "typecheck:apps/dev")!;
    expect(typecheckCheck.status).toBe("failed");
  });

  it("without `baselineWorktree`, the gate behaves exactly as before (no probe, no downgrades)", async () => {
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
    expect(result.baselineDowngraded).toEqual([]);
    // 4 scripts × 1 scope + 1 workspace typecheck = 5 invocations, no probe.
    expect(calls.length).toBe(5);
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

  it("downgrades workspace typecheck failure when baseline also fails (pre-existing break)", async () => {
    const exec: Exec = async (args) => {
      const dir = args[args.indexOf("-C") + 1] ?? "";
      const script = args[args.length - 1] ?? "";
      // typecheck fails everywhere (worker AND baseline) — pre-existing.
      if (script === "typecheck") return { code: 1, stdout: "tsc: error TS2304", stderr: "" };
      return { code: 0, stdout: "ok", stderr: "" };
    };
    const result = await runFeedback(exec, {
      worktree: "afk/wX/123-slug",
      scopes: ["apps/dev"],
      layout: workspaceLayout(),
      now: () => 0,
      baselineWorktree: "main",
    });

    // typecheck:apps/dev and typecheck:workspace both fail on worker AND baseline.
    expect(result.ok).toBe(true);
    expect(result.baselineDowngraded).toContain("typecheck:workspace");
    const ws = result.checks.find((c) => c.name === "typecheck:workspace")!;
    expect(ws.status).toBe("skipped");
    expect(ws.record.summary).toBe("pre-existing failure on baseline");
  });

  it("does NOT downgrade workspace typecheck when only the worker's branch fails it", async () => {
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
      now: () => 0,
      baselineWorktree: "main",
    });

    expect(result.ok).toBe(false);
    expect(result.baselineDowngraded).not.toContain("typecheck:workspace");
    const ws = result.checks.find((c) => c.name === "typecheck:workspace")!;
    expect(ws.status).toBe("failed");
  });
});
