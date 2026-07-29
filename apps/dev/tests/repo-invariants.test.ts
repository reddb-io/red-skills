import { describe, expect, it } from "vitest";
import {
  runFeedback,
  type Exec,
  type ExecResult,
  type PackageLayout,
} from "../src/core/feedback.js";
import {
  pendingInvariantSuites,
  REPO_INVARIANT_SUITES,
  scopesCoverInvariantSuite,
} from "../src/core/repo-invariants.js";
import {
  collectToonJsonIoFindingsFromFiles,
  formatToonJsonGuardFailureMessage,
  formatToonJsonGuardViolations,
} from "../src/core/toon-json-guard.js";
import {
  computeValidationScope,
  scopesForValidationScope,
  type WorkspaceGraph,
} from "../src/core/validation-scope.js";

const INVARIANT = REPO_INVARIANT_SUITES[0]!;

/** The live workspace shape the gate sees: apps/rsp is a leaf, apps/dev owns the ratchet. */
const GRAPH: WorkspaceGraph = {
  packages: [
    { dir: "apps/dev", dependsOn: ["packages/shared"] },
    { dir: "apps/rsp", dependsOn: [] },
    { dir: "packages/shared", dependsOn: [] },
  ],
};

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

const clock = (step = 5): (() => number) => {
  let t = 0;
  return () => (t += step);
};

const joined = (calls: string[][]): string[] => calls.map((c) => c.join(" "));

/** The live layout: every package declares the four scripts; apps/dev also owns the invariant script. */
const LIVE_LAYOUT = fakeLayout({
  packages: [".", "apps/dev", "apps/rsp", "packages/shared"],
  scripts: {
    ".": ["test", "typecheck", "lint", "build"],
    "apps/dev": ["test", "typecheck", "build", INVARIANT.script],
    "apps/rsp": ["test", "typecheck", "build"],
    "packages/shared": ["test", "typecheck", "build"],
  },
});

describe("pendingInvariantSuites", () => {
  it("is pending for a cone that excludes the owning package", () => {
    expect(pendingInvariantSuites(["apps/rsp"])).toEqual([INVARIANT]);
  });

  it("is already covered when the cone contains the owning package or the whole workspace", () => {
    expect(scopesCoverInvariantSuite(["apps/dev", "apps/rsp"], INVARIANT)).toBe(true);
    expect(scopesCoverInvariantSuite(["."], INVARIANT)).toBe(true);
    expect(pendingInvariantSuites(["apps/dev"])).toEqual([]);
    expect(pendingInvariantSuites(["."])).toEqual([]);
  });

  it("has nothing to run in a repo with no packages", () => {
    expect(pendingInvariantSuites([])).toEqual([]);
  });

  it("stays silent in a repo that does not carry the owning package", async () => {
    const layout = fakeLayout({
      packages: [".", "src"],
      scripts: { ".": ["test"], src: ["test"] },
    });
    const { exec } = fakeExec();
    const result = await runFeedback(exec, {
      worktree: "/wt",
      scopes: ["src"],
      layout,
      now: clock(),
    });

    expect(result.checks.map((c) => c.name)).not.toContain(INVARIANT.name);
  });
});

describe("cone-scoped gate runs the repo-wide invariant suites (#2762)", () => {
  it("runs the ratchet for a single-package cone that does not include apps/dev", async () => {
    const scope = computeValidationScope(["apps/rsp/src/proxy.ts"], LIVE_LAYOUT, GRAPH);
    const scopes = scopesForValidationScope(scope);
    expect(scopes).toEqual(["apps/rsp"]); // the cone genuinely excludes apps/dev

    const { exec, calls } = fakeExec();
    const result = await runFeedback(exec, {
      worktree: "/wt",
      scopes,
      layout: LIVE_LAYOUT,
      now: clock(),
    });

    expect(joined(calls)).toContain(`pnpm -C /wt/${INVARIANT.scope} ${INVARIANT.script}`);
    expect(result.checks.map((c) => c.name)).toContain(INVARIANT.name);
    expect(result.ok).toBe(true);
  });

  it("does not run the invariant script twice when the cone already covers its package", async () => {
    const { exec, calls } = fakeExec();
    await runFeedback(exec, {
      worktree: "/wt",
      scopes: ["apps/dev"],
      layout: LIVE_LAYOUT,
      now: clock(),
    });

    expect(joined(calls)).not.toContain(`pnpm -C /wt/${INVARIANT.scope} ${INVARIANT.script}`);
  });

  it("records a visible skip — never a silent drop — when the invariant script is missing", async () => {
    const layout = fakeLayout({
      packages: [".", "apps/dev", "apps/rsp"],
      scripts: { ".": ["typecheck"], "apps/dev": ["test"], "apps/rsp": ["test"] },
    });
    const { exec } = fakeExec();
    const result = await runFeedback(exec, {
      worktree: "/wt",
      scopes: ["apps/rsp"],
      layout,
      now: clock(),
    });

    const check = result.checks.find((c) => c.name === INVARIANT.name);
    expect(check?.status).toBe("skipped");
    expect(check?.record.summary).toContain(INVARIANT.script);
  });
});

describe("the failing shape reaches the worker's own gate, not just root CI (#2762)", () => {
  it("fails a cone-scoped apps/rsp gate on a new `.toon` write built with JSON.stringify", async () => {
    // The real guard, on the real shape: a `.toon` path written with
    // JSON.stringify. The runtime decoder sniffs JSON-or-TOON and accepts it,
    // so nothing in apps/rsp's own suite would ever notice.
    const source = `
      import { writeFileSync } from "node:fs";
      import { join } from "node:path";

      export function persistLedger(root: string, ledger: unknown) {
        writeFileSync(join(root, "overhead.toon"), JSON.stringify(ledger), "utf8");
      }
    `;
    const findings = collectToonJsonIoFindingsFromFiles([
      { relativePath: "apps/rsp/src/overhead-ledger.ts", sourceText: source },
    ]);
    const guardOutput = formatToonJsonGuardFailureMessage(
      formatToonJsonGuardViolations({ findings, allowlist: [] }),
    );
    expect(guardOutput).toContain("apps/rsp/src/overhead-ledger.ts");

    const scopes = scopesForValidationScope(
      computeValidationScope(["apps/rsp/src/overhead-ledger.ts"], LIVE_LAYOUT, GRAPH),
    );
    const { exec } = fakeExec([
      {
        // Only the invariant suite is red — apps/rsp's own suite is green, which
        // is exactly the state that shipped the same failure to CI three times.
        match: (argv) => argv.includes(INVARIANT.script),
        result: { code: 1, stdout: `FAIL tests/toon-json-guard.test.ts\n${guardOutput}` },
      },
    ]);

    const result = await runFeedback(exec, {
      worktree: "/wt",
      scopes,
      layout: LIVE_LAYOUT,
      now: clock(),
    });

    expect(result.ok).toBe(false);
    const check = result.checks.find((c) => c.name === INVARIANT.name);
    expect(check?.status).toBe("failed");
    // The park/sidecar summary names the offending path and the allowlist file.
    expect(check?.record.summary).toContain("repo-wide invariant");
    expect(check?.record.summary).toContain("apps/rsp/src/overhead-ledger.ts");
  });

  it("re-runs the invariant script — not the owning package's full suite — on the baseline probe", async () => {
    const scopes = ["apps/rsp"];
    const { exec, calls } = fakeExec([
      { match: (argv) => argv.includes(INVARIANT.script), result: { code: 1, stdout: "violation" } },
    ]);

    await runFeedback(exec, {
      worktree: "/wt",
      scopes,
      layout: LIVE_LAYOUT,
      now: clock(),
      baselineWorktree: "/base",
    });

    expect(joined(calls)).toContain(`pnpm -C /base/${INVARIANT.scope} ${INVARIANT.script}`);
    expect(joined(calls)).not.toContain(`pnpm -C /base/${INVARIANT.scope} test`);
  });
});
