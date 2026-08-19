import { describe, expect, it } from "vitest";
import {
  checkQuarantineStaleness,
  quarantineExcludeArgs,
  QuarantineConfigError,
  readQuarantine,
  scopeQuarantineEntries,
  validateQuarantine,
  type IssueStateChecker,
  type QuarantineEntry,
} from "../src/core/quarantine.js";
import {
  runFeedback,
  VALIDATION_SCHEMA,
  type Exec,
  type ExecResult,
  type PackageLayout,
} from "../src/core/feedback.js";
import { parseConfigYaml } from "../src/core/config.js";

// ---------- helpers ----------

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

function fakeClock(step = 5): () => number {
  let t = 1000;
  return () => {
    const v = t;
    t += step;
    return v;
  };
}

const SUPERVISOR_ISSUE = "https://github.com/reddb-io/red-skills/issues/1063";
const BRAIN_ISSUE = "https://github.com/reddb-io/red-skills/issues/1064";

// ---------- readQuarantine ----------

describe("readQuarantine", () => {
  it("returns empty list when no quarantine keys are present", () => {
    const values = parseConfigYaml("afk:\n  default_runner: claude\n");
    expect(readQuarantine(values)).toEqual([]);
  });

  it("reads a single quarantine entry from indexed config keys", () => {
    const yaml = `
afk:
  test:
    quarantine:
      e0:
        pattern: apps/plugin-dev/tests/supervisor.test.ts
        issue: "${SUPERVISOR_ISSUE}"
        since: "2026-07-02"
        reason: "OOM under fleet=2 load"
`.trim();
    const values = parseConfigYaml(yaml);
    expect(readQuarantine(values)).toEqual([
      {
        pattern: "apps/plugin-dev/tests/supervisor.test.ts",
        issue: SUPERVISOR_ISSUE,
        since: "2026-07-02",
        reason: "OOM under fleet=2 load",
      },
    ]);
  });

  it("reads multiple entries in order (e0, e1, e2…)", () => {
    const yaml = `
afk:
  test:
    quarantine:
      e0:
        pattern: apps/plugin-dev/tests/supervisor.test.ts
        issue: "${SUPERVISOR_ISSUE}"
        since: "2026-07-02"
      e1:
        pattern: apps/plugin-brain/tests/dashboard.test.ts
        issue: "${BRAIN_ISSUE}"
        since: "2026-07-02"
`.trim();
    const values = parseConfigYaml(yaml);
    const entries = readQuarantine(values);
    expect(entries).toHaveLength(2);
    expect(entries[0]?.pattern).toBe("apps/plugin-dev/tests/supervisor.test.ts");
    expect(entries[1]?.pattern).toBe("apps/plugin-brain/tests/dashboard.test.ts");
  });

  it("stops at the first gap (e0, e2 → only e0 returned)", () => {
    const yaml = `
afk:
  test:
    quarantine:
      e0:
        pattern: apps/plugin-dev/tests/supervisor.test.ts
        issue: "${SUPERVISOR_ISSUE}"
        since: "2026-07-02"
      e2:
        pattern: apps/plugin-brain/tests/dashboard.test.ts
        issue: "${BRAIN_ISSUE}"
        since: "2026-07-02"
`.trim();
    const values = parseConfigYaml(yaml);
    expect(readQuarantine(values)).toHaveLength(1);
  });

  it("omits the reason field when absent", () => {
    const yaml = `
afk:
  test:
    quarantine:
      e0:
        pattern: apps/plugin-dev/tests/supervisor.test.ts
        issue: "${SUPERVISOR_ISSUE}"
        since: "2026-07-02"
`.trim();
    const values = parseConfigYaml(yaml);
    const entry = readQuarantine(values)[0]!;
    expect(entry.reason).toBeUndefined();
  });
});

// ---------- validateQuarantine ----------

describe("validateQuarantine", () => {
  it("accepts a valid list where all entries carry an issue ref", () => {
    const entries: QuarantineEntry[] = [
      { pattern: "apps/plugin-dev/tests/supervisor.test.ts", issue: SUPERVISOR_ISSUE, since: "2026-07-02" },
      { pattern: "apps/plugin-brain/tests/dashboard.test.ts", issue: BRAIN_ISSUE, since: "2026-07-02" },
    ];
    expect(() => validateQuarantine(entries)).not.toThrow();
  });

  it("accepts an empty list", () => {
    expect(() => validateQuarantine([])).not.toThrow();
  });

  it("throws QuarantineConfigError when entry 0 is missing an issue ref", () => {
    const entries: QuarantineEntry[] = [
      { pattern: "apps/plugin-dev/tests/supervisor.test.ts", issue: "", since: "2026-07-02" },
    ];
    expect(() => validateQuarantine(entries)).toThrow(QuarantineConfigError);
  });

  it("throws QuarantineConfigError when entry 1 is missing an issue ref", () => {
    const entries: QuarantineEntry[] = [
      { pattern: "apps/plugin-dev/tests/supervisor.test.ts", issue: SUPERVISOR_ISSUE, since: "2026-07-02" },
      { pattern: "apps/plugin-brain/tests/dashboard.test.ts", issue: "   ", since: "2026-07-02" },
    ];
    expect(() => validateQuarantine(entries)).toThrow(QuarantineConfigError);
  });

  it("error message names the violating pattern", () => {
    const entries: QuarantineEntry[] = [
      { pattern: "apps/plugin-dev/tests/supervisor.test.ts", issue: "", since: "2026-07-02" },
    ];
    let msg = "";
    try {
      validateQuarantine(entries);
    } catch (err) {
      msg = (err as Error).message;
    }
    expect(msg).toContain("apps/plugin-dev/tests/supervisor.test.ts");
    expect(msg).toContain("issue reference");
  });
});

// ---------- quarantineExcludeArgs ----------

describe("quarantineExcludeArgs", () => {
  const entries: QuarantineEntry[] = [
    { pattern: "apps/plugin-dev/tests/supervisor.test.ts", issue: SUPERVISOR_ISSUE, since: "2026-07-02" },
    { pattern: "apps/plugin-brain/tests/dashboard.test.ts", issue: BRAIN_ISSUE, since: "2026-07-02" },
  ];

  it("returns --exclude args relative to the scope for a matching scope", () => {
    expect(quarantineExcludeArgs(entries, "apps/plugin-dev")).toEqual([
      "--exclude",
      "tests/supervisor.test.ts",
    ]);
  });

  it("returns args for all entries under the root scope", () => {
    const args = quarantineExcludeArgs(entries, ".");
    expect(args).toEqual([
      "--exclude",
      "apps/plugin-dev/tests/supervisor.test.ts",
      "--exclude",
      "apps/plugin-brain/tests/dashboard.test.ts",
    ]);
  });

  it("returns empty array when no entry matches the scope", () => {
    expect(quarantineExcludeArgs(entries, "packages/shared")).toEqual([]);
  });

  it("returns empty array for an empty quarantine list", () => {
    expect(quarantineExcludeArgs([], "apps/plugin-dev")).toEqual([]);
  });
});

// ---------- scopeQuarantineEntries ----------

describe("scopeQuarantineEntries", () => {
  const entries: QuarantineEntry[] = [
    { pattern: "apps/plugin-dev/tests/supervisor.test.ts", issue: SUPERVISOR_ISSUE, since: "2026-07-02" },
    { pattern: "apps/plugin-brain/tests/dashboard.test.ts", issue: BRAIN_ISSUE, since: "2026-07-02" },
  ];

  it("returns entries for the matching scope", () => {
    expect(scopeQuarantineEntries(entries, "apps/plugin-dev")).toHaveLength(1);
    expect(scopeQuarantineEntries(entries, "apps/plugin-dev")[0]?.pattern).toBe(
      "apps/plugin-dev/tests/supervisor.test.ts",
    );
  });

  it("returns all entries for root scope", () => {
    expect(scopeQuarantineEntries(entries, ".")).toHaveLength(2);
  });

  it("returns empty for non-matching scope", () => {
    expect(scopeQuarantineEntries(entries, "packages/shared")).toHaveLength(0);
  });
});

// ---------- gate integration: quarantine entries excluded + visible ----------

describe("runFeedback quarantine integration", () => {
  const layout = fakeLayout({
    packages: ["apps/plugin-dev"],
    scripts: { "apps/plugin-dev": ["test"] },
  });

  const quarantine: QuarantineEntry[] = [
    {
      pattern: "apps/plugin-dev/tests/supervisor.test.ts",
      issue: SUPERVISOR_ISSUE,
      since: "2026-07-02",
      reason: "OOM under fleet=2",
    },
  ];

  it("passes --exclude args to the test exec for quarantined patterns", async () => {
    const { exec, calls } = fakeExec();
    await runFeedback(exec, {
      worktree: "/wt",
      scopes: ["apps/plugin-dev"],
      layout,
      now: fakeClock(),
      quarantine,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual(["pnpm", "-C", "/wt/apps/plugin-dev", "test", "--", "--exclude", "tests/supervisor.test.ts"]);
  });

  it("emits a visible skipped sidecar record for each quarantined test", async () => {
    const { exec } = fakeExec();
    const result = await runFeedback(exec, {
      worktree: "/wt",
      scopes: ["apps/plugin-dev"],
      layout,
      now: fakeClock(),
      quarantine,
    });

    const qRecord = result.checks.find((c) => c.name === "quarantined:apps/plugin-dev/tests/supervisor.test.ts");
    expect(qRecord).toBeDefined();
    expect(qRecord?.status).toBe("skipped");
    expect(qRecord?.record.summary).toContain(SUPERVISOR_ISSUE);
    expect(qRecord?.record.summary).toContain("2026-07-02");
  });

  it("quarantine record appears in sidecar as valid JSONL with correct schema", async () => {
    const { exec } = fakeExec();
    const result = await runFeedback(exec, {
      worktree: "/wt",
      scopes: ["apps/plugin-dev"],
      layout,
      now: fakeClock(),
      quarantine,
    });

    const qLine = result.sidecar.find((l) => l.includes("quarantined:"));
    expect(qLine).toBeDefined();
    const parsed = JSON.parse(qLine!);
    expect(parsed.schema).toBe(VALIDATION_SCHEMA);
    expect(parsed.status).toBe("skipped");
  });

  it("gate still passes when the test suite passes (quarantine does not affect ok)", async () => {
    const { exec } = fakeExec();
    const result = await runFeedback(exec, {
      worktree: "/wt",
      scopes: ["apps/plugin-dev"],
      layout,
      now: fakeClock(),
      quarantine,
    });

    expect(result.ok).toBe(true);
  });

  it("command string in the test record includes the --exclude args", async () => {
    const { exec } = fakeExec();
    const result = await runFeedback(exec, {
      worktree: "/wt",
      scopes: ["apps/plugin-dev"],
      layout,
      now: fakeClock(),
      quarantine,
    });

    const testCheck = result.checks.find((c) => c.name === "test:apps/plugin-dev");
    expect(testCheck?.record.command).toContain("--exclude");
    expect(testCheck?.record.command).toContain("tests/supervisor.test.ts");
  });

  it("does not add --exclude to non-test scripts (typecheck, lint, build)", async () => {
    const multiLayout = fakeLayout({
      packages: ["apps/plugin-dev"],
      scripts: { "apps/plugin-dev": ["test", "typecheck", "lint", "build"] },
    });
    const { exec, calls } = fakeExec();
    await runFeedback(exec, {
      worktree: "/wt",
      scopes: ["apps/plugin-dev"],
      layout: multiLayout,
      now: fakeClock(),
      quarantine,
    });

    const typecheckCall = calls.find((c) => c.includes("typecheck"));
    expect(typecheckCall).not.toContain("--exclude");
    const lintCall = calls.find((c) => c.includes("lint"));
    expect(lintCall).not.toContain("--exclude");
  });

  it("does not modify exec call when no quarantine entries match the scope", async () => {
    const { exec, calls } = fakeExec();
    await runFeedback(exec, {
      worktree: "/wt",
      scopes: ["apps/plugin-dev"],
      layout,
      now: fakeClock(),
      quarantine: [{ pattern: "apps/plugin-brain/tests/dashboard.test.ts", issue: BRAIN_ISSUE, since: "2026-07-02" }],
    });

    expect(calls[0]).toEqual(["pnpm", "-C", "/wt/apps/plugin-dev", "test"]);
  });

  it("surfaces the quarantined list on the result for envelope builders", async () => {
    const { exec } = fakeExec();
    const result = await runFeedback(exec, {
      worktree: "/wt",
      scopes: ["apps/plugin-dev"],
      layout,
      now: fakeClock(),
      quarantine,
    });

    expect(result.quarantined).toHaveLength(1);
    expect(result.quarantined[0]?.issue).toBe(SUPERVISOR_ISSUE);
  });

  it("quarantined is empty when no quarantine is configured", async () => {
    const { exec } = fakeExec();
    const result = await runFeedback(exec, {
      worktree: "/wt",
      scopes: ["apps/plugin-dev"],
      layout,
      now: fakeClock(),
    });

    expect(result.quarantined).toEqual([]);
  });
});

// ---------- gate integration: missing issue ref → loud gate failure ----------

describe("runFeedback quarantine config-error", () => {
  const layout = fakeLayout({
    packages: ["apps/plugin-dev"],
    scripts: { "apps/plugin-dev": ["test"] },
  });

  it("fails the gate (ok:false) when an entry is missing an issue ref", async () => {
    const { exec } = fakeExec();
    const result = await runFeedback(exec, {
      worktree: "/wt",
      scopes: ["apps/plugin-dev"],
      layout,
      now: fakeClock(),
      quarantine: [{ pattern: "apps/plugin-dev/tests/supervisor.test.ts", issue: "", since: "2026-07-02" }],
    });

    expect(result.ok).toBe(false);
  });

  it("emits a quarantine:config-error failed sidecar record", async () => {
    const { exec } = fakeExec();
    const result = await runFeedback(exec, {
      worktree: "/wt",
      scopes: ["apps/plugin-dev"],
      layout,
      now: fakeClock(),
      quarantine: [{ pattern: "apps/plugin-dev/tests/supervisor.test.ts", issue: "", since: "2026-07-02" }],
    });

    expect(result.checks).toHaveLength(1);
    expect(result.checks[0]?.name).toBe("quarantine:config-error");
    expect(result.checks[0]?.status).toBe("failed");
    expect(result.checks[0]?.record.summary).toContain("issue reference");
  });

  it("does not run any tests when quarantine config is invalid", async () => {
    const { exec, calls } = fakeExec();
    await runFeedback(exec, {
      worktree: "/wt",
      scopes: ["apps/plugin-dev"],
      layout,
      now: fakeClock(),
      quarantine: [{ pattern: "apps/plugin-dev/tests/supervisor.test.ts", issue: "", since: "2026-07-02" }],
    });

    expect(calls).toHaveLength(0);
  });
});

// ---------- staleness warning ----------

describe("checkQuarantineStaleness", () => {
  const entries: QuarantineEntry[] = [
    { pattern: "apps/plugin-dev/tests/supervisor.test.ts", issue: SUPERVISOR_ISSUE, since: "2026-07-02" },
    { pattern: "apps/plugin-brain/tests/dashboard.test.ts", issue: BRAIN_ISSUE, since: "2026-07-02" },
  ];

  it("returns empty staleEntries when all issues are open", async () => {
    const checker: IssueStateChecker = async () => "open";
    const result = await checkQuarantineStaleness(entries, checker);
    expect(result.staleEntries).toHaveLength(0);
  });

  it("returns a stale entry when the referenced issue is closed", async () => {
    const checker: IssueStateChecker = async (url) =>
      url === SUPERVISOR_ISSUE ? "closed" : "open";
    const result = await checkQuarantineStaleness(entries, checker);
    expect(result.staleEntries).toHaveLength(1);
    expect(result.staleEntries[0]?.entry.pattern).toBe("apps/plugin-dev/tests/supervisor.test.ts");
    expect(result.staleEntries[0]?.warning).toContain(SUPERVISOR_ISSUE);
  });

  it("returns all stale entries when all issues are closed", async () => {
    const checker: IssueStateChecker = async () => "closed";
    const result = await checkQuarantineStaleness(entries, checker);
    expect(result.staleEntries).toHaveLength(2);
  });

  it("ignores entries where the checker returns unknown", async () => {
    const checker: IssueStateChecker = async () => "unknown";
    const result = await checkQuarantineStaleness(entries, checker);
    expect(result.staleEntries).toHaveLength(0);
  });

  it("skips entries with empty issue ref (should not have passed validateQuarantine)", async () => {
    const bad: QuarantineEntry[] = [{ pattern: "foo.test.ts", issue: "", since: "2026-07-02" }];
    const checker: IssueStateChecker = async () => "closed";
    const result = await checkQuarantineStaleness(bad, checker);
    expect(result.staleEntries).toHaveLength(0);
  });

  it("warning message names the pattern and the closed issue URL", async () => {
    const checker: IssueStateChecker = async () => "closed";
    const result = await checkQuarantineStaleness(
      [{ pattern: "apps/plugin-dev/tests/supervisor.test.ts", issue: SUPERVISOR_ISSUE, since: "2026-07-02" }],
      checker,
    );
    const warning = result.staleEntries[0]?.warning ?? "";
    expect(warning).toContain("apps/plugin-dev/tests/supervisor.test.ts");
    expect(warning).toContain(SUPERVISOR_ISSUE);
    expect(warning).toContain("closed");
  });
});
