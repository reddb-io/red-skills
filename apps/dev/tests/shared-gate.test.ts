import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
  classifyFinding,
  runSharedGate,
  makeHeadlessSink,
  makeInteractiveSink,
  MECHANICAL_KINDS,
  SENSITIVE_PATH_PATTERNS,
  LIFECYCLE_SCRIPT_NAMES,
  isSensitivePath,
  hasLifecycleScriptInDiff,
  checkSensitivePaths,
  allowlistExternalWidened,
  gateVerdict,
  GATE_STAGE_ORDER,
  type EscalationOutcome,
  type GateFinding,
  type SharedGateDeps,
} from "../src/core/shared-gate.js";
import { FOWLER_REFACTORING_SMELLS } from "../src/core/review-extract.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

// shared-gate — closed mechanical allowlist + context-aware escalation (#931).
//
// Acceptance criteria:
//   1. Mechanical allowlist is closed and auditable — anything not on it is intent.
//   2. Mechanical findings auto-apply + commit.
//   3. Intent findings escalate (never auto-committed).
//   4. Escalation sink switches by context: interactive pause vs headless park.
//   5. Tests cover both sinks and the "default = intent" boundary.

function finding(kind: string, description = "test finding"): GateFinding {
  return { kind, description };
}

function makeDeps(
  applied: GateFinding[] = [],
  escalationOutcome: EscalationOutcome = "approved",
): SharedGateDeps {
  return {
    applyMechanical: vi.fn(async (f) => {
      applied.push(f);
    }),
    escalateIntent: vi.fn(async (): Promise<EscalationOutcome> => escalationOutcome),
  };
}

// ---------- classifyFinding ----------

describe("classifyFinding — closed allowlist", () => {
  it("classifies every enumerated mechanical kind as mechanical", () => {
    for (const kind of MECHANICAL_KINDS) {
      expect(classifyFinding(finding(kind))).toBe("mechanical");
    }
  });

  it("classifies an unknown kind as intent (default = intent)", () => {
    expect(classifyFinding(finding("logic-change"))).toBe("intent");
    expect(classifyFinding(finding("type-error"))).toBe("intent");
    expect(classifyFinding(finding("test-expectation-change"))).toBe("intent");
    expect(classifyFinding(finding("library-upgrade"))).toBe("intent");
  });

  it("treats an empty kind as intent (not mechanical)", () => {
    expect(classifyFinding(finding(""))).toBe("intent");
  });

  it("is case-sensitive — Formatter is not formatter", () => {
    expect(classifyFinding(finding("Formatter"))).toBe("intent");
    expect(classifyFinding(finding("LINT-FIX"))).toBe("intent");
  });

  it("classifies Fowler smell findings as intent, never mechanical auto-applies", () => {
    for (const [smell] of FOWLER_REFACTORING_SMELLS) {
      expect(classifyFinding(finding(smell))).toBe("intent");
    }
  });
});

// ---------- runSharedGate — mechanical path ----------

describe("runSharedGate — mechanical findings", () => {
  it("auto-applies all mechanical findings and passes", async () => {
    const applied: GateFinding[] = [];
    const deps = makeDeps(applied);
    const findings = [finding("formatter"), finding("trailing-whitespace")];

    const result = await runSharedGate(findings, deps);

    expect(result.passed).toBe(true);
    expect(result.mechanicalApplied).toBe(2);
    expect(result.intentEscalated).toBe(0);
    expect(applied).toHaveLength(2);
    expect(result.resolutions[0].applied).toBe(true);
    expect(result.resolutions[1].applied).toBe(true);
  });

  it("calls applyMechanical once per mechanical finding in order", async () => {
    const callOrder: string[] = [];
    const deps: SharedGateDeps = {
      applyMechanical: vi.fn(async (f) => {
        callOrder.push(f.kind);
      }),
      escalateIntent: vi.fn(async (): Promise<EscalationOutcome> => "approved"),
    };

    await runSharedGate(
      [finding("import-organizer"), finding("lint-fix"), finding("comment-typo")],
      deps,
    );

    expect(callOrder).toEqual(["import-organizer", "lint-fix", "comment-typo"]);
  });

  it("never calls escalateIntent for a mechanical finding", async () => {
    const deps = makeDeps();
    await runSharedGate([finding("formatter"), finding("trailing-newline")], deps);
    expect(deps.escalateIntent).not.toHaveBeenCalled();
  });

  it("passes with no findings (empty set)", async () => {
    const deps = makeDeps();
    const result = await runSharedGate([], deps);
    expect(result.passed).toBe(true);
    expect(result.mechanicalApplied).toBe(0);
    expect(result.intentEscalated).toBe(0);
    expect(result.resolutions).toHaveLength(0);
  });
});

// ---------- runSharedGate — intent path ----------

describe("runSharedGate — intent findings", () => {
  it("escalates an intent finding and passes when approved", async () => {
    const deps = makeDeps([], "approved");
    const result = await runSharedGate([finding("logic-change")], deps);

    expect(result.passed).toBe(true);
    expect(result.intentEscalated).toBe(1);
    expect(result.mechanicalApplied).toBe(0);
    expect(result.resolutions[0].escalationOutcome).toBe("approved");
  });

  it("fails when an intent finding is parked (headless sink)", async () => {
    const deps = makeDeps([], "parked");
    const result = await runSharedGate([finding("function-rename")], deps);

    expect(result.passed).toBe(false);
    expect(result.intentEscalated).toBe(1);
    expect(result.resolutions[0].escalationOutcome).toBe("parked");
  });

  it("fails when an intent finding is skipped (interactive sink)", async () => {
    const deps = makeDeps([], "skipped");
    const result = await runSharedGate([finding("test-expectation-change")], deps);

    expect(result.passed).toBe(false);
    expect(result.resolutions[0].escalationOutcome).toBe("skipped");
  });

  it("never calls applyMechanical for an intent finding", async () => {
    const deps = makeDeps([], "approved");
    await runSharedGate([finding("library-upgrade")], deps);
    expect(deps.applyMechanical).not.toHaveBeenCalled();
  });
});

// ---------- runSharedGate — mixed findings ----------

describe("runSharedGate — mixed mechanical + intent", () => {
  it("auto-applies mechanical and escalates intent in one pass", async () => {
    const applied: GateFinding[] = [];
    const deps: SharedGateDeps = {
      applyMechanical: vi.fn(async (f) => {
        applied.push(f);
      }),
      escalateIntent: vi.fn(async (): Promise<EscalationOutcome> => "approved"),
    };

    const findings = [
      finding("formatter"),
      finding("logic-change"),
      finding("trailing-whitespace"),
      finding("type-error"),
    ];

    const result = await runSharedGate(findings, deps);

    expect(result.passed).toBe(true);
    expect(result.mechanicalApplied).toBe(2);
    expect(result.intentEscalated).toBe(2);
    expect(applied.map((f) => f.kind)).toEqual(["formatter", "trailing-whitespace"]);
  });

  it("fails when any intent finding blocks even if mechanical ones applied", async () => {
    const deps: SharedGateDeps = {
      applyMechanical: vi.fn(async () => {}),
      escalateIntent: vi.fn(async (): Promise<EscalationOutcome> => "parked"),
    };

    const result = await runSharedGate(
      [finding("formatter"), finding("logic-change")],
      deps,
    );

    expect(result.passed).toBe(false);
    expect(result.mechanicalApplied).toBe(1);
    expect(result.intentEscalated).toBe(1);
  });
});

// ---------- headless sink ----------

describe("makeHeadlessSink — headless escalation", () => {
  it("always returns parked and calls the park callback", async () => {
    const parked: GateFinding[] = [];
    const sink = makeHeadlessSink(async (f) => {
      parked.push(f);
    });

    const f = finding("function-rename");
    const outcome = await sink(f);

    expect(outcome).toBe("parked");
    expect(parked).toHaveLength(1);
    expect(parked[0]).toBe(f);
  });

  it("parks every intent finding in a batch via runSharedGate", async () => {
    const parked: string[] = [];
    const sink = makeHeadlessSink(async (f) => {
      parked.push(f.kind);
    });

    const deps: SharedGateDeps = {
      applyMechanical: vi.fn(async () => {}),
      escalateIntent: sink,
    };

    const result = await runSharedGate(
      [finding("logic-a"), finding("logic-b")],
      deps,
    );

    expect(result.passed).toBe(false);
    expect(parked).toEqual(["logic-a", "logic-b"]);
  });
});

// ---------- interactive sink ----------

describe("makeInteractiveSink — interactive escalation", () => {
  it("returns approved when the user approves", async () => {
    const sink = makeInteractiveSink(async () => "approved");
    expect(await sink(finding("type-change"))).toBe("approved");
  });

  it("returns skipped when the user skips", async () => {
    const sink = makeInteractiveSink(async () => "skipped");
    expect(await sink(finding("type-change"))).toBe("skipped");
  });

  it("passes the finding to the prompt callback", async () => {
    let received: GateFinding | undefined;
    const sink = makeInteractiveSink(async (f) => {
      received = f;
      return "approved";
    });

    const f = finding("library-upgrade", "bumped react to v19");
    await sink(f);
    expect(received).toBe(f);
  });

  it("marks gate passed when user approves all intent findings", async () => {
    const sink = makeInteractiveSink(async () => "approved");
    const deps: SharedGateDeps = {
      applyMechanical: vi.fn(async () => {}),
      escalateIntent: sink,
    };

    const result = await runSharedGate(
      [finding("logic-change"), finding("function-rename")],
      deps,
    );

    expect(result.passed).toBe(true);
    expect(result.intentEscalated).toBe(2);
  });

  it("marks gate failed when user skips an intent finding", async () => {
    const sink = makeInteractiveSink(async () => "skipped");
    const deps: SharedGateDeps = {
      applyMechanical: vi.fn(async () => {}),
      escalateIntent: sink,
    };

    const result = await runSharedGate([finding("type-error")], deps);

    expect(result.passed).toBe(false);
    expect(result.resolutions[0].escalationOutcome).toBe("skipped");
  });
});

// ---------- sensitive-path guard (issue #1102) ----------

describe("SENSITIVE_PATH_PATTERNS — closed auditable set", () => {
  it("covers every enumerated category (CI, hooks, .red/)", () => {
    expect(SENSITIVE_PATH_PATTERNS.length).toBeGreaterThan(0);
    // Each pattern is a RegExp instance (not a string).
    for (const p of SENSITIVE_PATH_PATTERNS) {
      expect(p).toBeInstanceOf(RegExp);
    }
  });

  it("LIFECYCLE_SCRIPT_NAMES are non-empty strings", () => {
    for (const name of LIFECYCLE_SCRIPT_NAMES) {
      expect(typeof name).toBe("string");
      expect(name.length).toBeGreaterThan(0);
    }
  });

  it("keeps the .red/tmp worktree literal in lockstep with command-guard.sh", () => {
    const commandGuard = readFileSync(join(REPO_ROOT, "plugins/dev/hooks/command-guard.sh"), "utf8");
    const commandGuardRoot = extractCommandGuardWorktreeRootLiteral(commandGuard);
    const sensitiveRoot = extractSensitivePathTmpRootLiteral(SENSITIVE_PATH_PATTERNS);

    expect(sensitiveRoot).toBe(commandGuardRoot);
  });
});

describe("isSensitivePath — path pattern matching", () => {
  it("flags .github/workflows/* as sensitive", () => {
    expect(isSensitivePath(".github/workflows/ci.yml")).toBe(true);
    expect(isSensitivePath(".github/workflows/red-release.yml")).toBe(true);
  });

  it("flags .git/hooks/* as sensitive", () => {
    expect(isSensitivePath(".git/hooks/pre-commit")).toBe(true);
    expect(isSensitivePath(".git/hooks/commit-msg")).toBe(true);
  });

  it("flags .husky/* as sensitive", () => {
    expect(isSensitivePath(".husky/pre-commit")).toBe(true);
    expect(isSensitivePath(".husky/pre-push")).toBe(true);
  });

  it("flags .githooks/* as sensitive", () => {
    expect(isSensitivePath(".githooks/pre-commit")).toBe(true);
  });

  it("flags any file under .red/ as sensitive", () => {
    expect(isSensitivePath(".red/config.yaml")).toBe(true);
    expect(isSensitivePath(".red/trust/gate.json")).toBe(true);
    expect(isSensitivePath(".red/adr/0001-init.md")).toBe(true);
  });

  it("flags .github/actions/* composite actions as sensitive", () => {
    expect(isSensitivePath(".github/actions/afk-attempt/action.yml")).toBe(true);
    expect(isSensitivePath(".github/actions/install-red-binary/action.yml")).toBe(true);
  });

  it("flags agent plugin hooks as sensitive (any plugin)", () => {
    expect(isSensitivePath("plugins/dev/hooks/command-guard.sh")).toBe(true);
    expect(isSensitivePath("plugins/dev/hooks/claude.hooks.json")).toBe(true);
    expect(isSensitivePath("plugins/memory/hooks/precompact.sh")).toBe(true);
  });

  it("flags agent plugin launcher scripts as sensitive (any plugin)", () => {
    expect(isSensitivePath("plugins/dev/scripts/memory-bridge.sh")).toBe(true);
    expect(isSensitivePath("plugins/brain/scripts/bootstrap.mjs")).toBe(true);
  });

  it("does NOT flag plugin skills or docs as sensitive", () => {
    expect(isSensitivePath("plugins/dev/skills/engineering/afk/SKILL.md")).toBe(false);
    expect(isSensitivePath("plugins/dev/.claude-plugin/plugin.json")).toBe(false);
  });

  it("does NOT flag ordinary source files", () => {
    expect(isSensitivePath("src/index.ts")).toBe(false);
    expect(isSensitivePath("apps/dev/src/core/landing.ts")).toBe(false);
    expect(isSensitivePath("README.md")).toBe(false);
    expect(isSensitivePath("package.json")).toBe(false);
    expect(isSensitivePath("pnpm-lock.yaml")).toBe(false);
  });

  it("does NOT flag a path that merely contains a sensitive segment mid-path", () => {
    // A path like 'src/.github/workflows/test.yml' should still be flagged
    // because the pattern anchors at start of string for .github/workflows.
    // But something like 'docs/red-migration.md' is NOT .red/
    expect(isSensitivePath("docs/red-migration.md")).toBe(false);
    expect(isSensitivePath("apps/red-ui/index.ts")).toBe(false);
  });

  it("flags a nested .git/hooks path", () => {
    // The pattern uses (?:^|\/) so nested paths also match.
    expect(isSensitivePath("sub/.git/hooks/post-commit")).toBe(true);
  });
});

describe("hasLifecycleScriptInDiff — lifecycle script detection", () => {
  it("detects preinstall added to package.json", () => {
    const diff = `@@ -5,0 +5,1 @@\n+    "preinstall": "node setup.js",`;
    expect(hasLifecycleScriptInDiff(diff)).toBe(true);
  });

  it("detects postinstall added to package.json", () => {
    const diff = `@@ -10,0 +10,1 @@\n+    "postinstall": "patch-package",`;
    expect(hasLifecycleScriptInDiff(diff)).toBe(true);
  });

  it("detects prepare added to package.json", () => {
    const diff = `\n+    "prepare": "husky install",`;
    expect(hasLifecycleScriptInDiff(diff)).toBe(true);
  });

  it("ignores removed lifecycle script lines (- prefix)", () => {
    const diff = `-    "preinstall": "old script",`;
    expect(hasLifecycleScriptInDiff(diff)).toBe(false);
  });

  it("ignores context lines (space prefix) with lifecycle script names", () => {
    const diff = `     "preinstall": "old script",`;
    expect(hasLifecycleScriptInDiff(diff)).toBe(false);
  });

  it("does NOT flag ordinary script additions (start/test/build)", () => {
    const diff = `+    "build": "tsc",\n+    "test": "vitest",\n+    "start": "node dist/index.js",`;
    expect(hasLifecycleScriptInDiff(diff)).toBe(false);
  });

  it("returns false for an empty diff", () => {
    expect(hasLifecycleScriptInDiff("")).toBe(false);
  });

  it("detects prepublishOnly added to package.json", () => {
    const diff = `+    "prepublishOnly": "pnpm run build",`;
    expect(hasLifecycleScriptInDiff(diff)).toBe(true);
  });
});

describe("checkSensitivePaths — integrated guard", () => {
  it("returns empty array when nothing is sensitive", () => {
    const hits = checkSensitivePaths(["src/index.ts", "README.md"], "");
    expect(hits).toHaveLength(0);
  });

  it("flags a CI workflow file", () => {
    const hits = checkSensitivePaths([".github/workflows/ci.yml"], "");
    expect(hits).toHaveLength(1);
    expect(hits[0].path).toBe(".github/workflows/ci.yml");
    expect(hits[0].reason).toMatch(/CI workflow/);
  });

  it("flags a .red/ config file", () => {
    const hits = checkSensitivePaths([".red/config.yaml"], "");
    expect(hits).toHaveLength(1);
    expect(hits[0].reason).toMatch(/trust\/gate/);
  });

  it("flags multiple sensitive paths independently", () => {
    const hits = checkSensitivePaths(
      [".github/workflows/ci.yml", "src/core/ship.ts", ".husky/pre-commit"],
      "",
    );
    expect(hits).toHaveLength(2);
    const paths = hits.map((h) => h.path);
    expect(paths).toContain(".github/workflows/ci.yml");
    expect(paths).toContain(".husky/pre-commit");
  });

  it("flags a lifecycle script change in package.json diff", () => {
    const diff = `+    "preinstall": "node setup.js",`;
    const hits = checkSensitivePaths(["package.json", "src/index.ts"], diff);
    expect(hits.some((h) => h.reason.includes("lifecycle script"))).toBe(true);
  });

  it("does NOT flag a package.json with only non-lifecycle script changes", () => {
    const diff = `+    "build": "tsc",`;
    const hits = checkSensitivePaths(["package.json"], diff);
    expect(hits).toHaveLength(0);
  });

  it("includes the package.json file path in the hit when package.json is in changedFiles", () => {
    const diff = `+    "postinstall": "patch-package",`;
    const hits = checkSensitivePaths(["packages/shared/package.json"], diff);
    const lifecycleHit = hits.find((h) => h.reason.includes("lifecycle script"));
    expect(lifecycleHit).toBeDefined();
    expect(lifecycleHit!.path).toContain("package.json");
  });

  it("clean diff with only regular changes returns no hits", () => {
    const hits = checkSensitivePaths(
      ["apps/dev/src/core/landing.ts", "apps/dev/tests/landing.test.ts"],
      "",
    );
    expect(hits).toHaveLength(0);
  });
});

// ---------- diff-aware allowlist exemption ----------

const ALLOWLIST_FILE = ".red/contracts/toon-json-file-io-allowlist.json";
const allowlistJson = (entries: { id: string; classification: string; reason?: string }[]) =>
  JSON.stringify({ version: 1, entries }, null, 2);
const mig = (id: string) => ({ id, classification: "migrate" });
const ext = (id: string, reason: string) => ({ id, classification: "external", reason });

describe("checkSensitivePaths — diff-aware allowlist exemption", () => {
  it("does NOT flag a shrink-only allowlist edit (safe exemption)", () => {
    const hits = checkSensitivePaths([ALLOWLIST_FILE, "apps/memory/src/inbox.ts"], "", {
      path: ALLOWLIST_FILE,
      safe: true,
    });
    expect(hits).toHaveLength(0);
  });

  it("flags the allowlist when the exemption is unsafe (external widened)", () => {
    const hits = checkSensitivePaths([ALLOWLIST_FILE], "", { path: ALLOWLIST_FILE, safe: false });
    expect(hits).toHaveLength(1);
    expect(hits[0].path).toBe(ALLOWLIST_FILE);
    expect(hits[0].reason).toMatch(/trust\/gate/);
  });

  it("flags the allowlist with no exemption provided (backwards-compatible default)", () => {
    expect(checkSensitivePaths([ALLOWLIST_FILE], "")).toHaveLength(1);
  });

  it("the exemption covers only its own path — other .red/ files still flag", () => {
    const hits = checkSensitivePaths([ALLOWLIST_FILE, ".red/config.yaml"], "", {
      path: ALLOWLIST_FILE,
      safe: true,
    });
    expect(hits).toHaveLength(1);
    expect(hits[0].path).toBe(".red/config.yaml");
  });
});

describe("allowlistExternalWidened — trust-preserving allowlist diff", () => {
  it("removing a migrate entry is safe (not widened)", () => {
    const oldC = allowlistJson([mig("a#k#1"), mig("b#k#2"), ext("c#k#3", "MCP config")]);
    const newC = allowlistJson([mig("a#k#1"), ext("c#k#3", "MCP config")]);
    expect(allowlistExternalWidened(oldC, newC)).toBe(false);
  });

  it("removing an external entry is safe (shrinking the exception set)", () => {
    const oldC = allowlistJson([ext("c#k#3", "MCP config"), mig("a#k#1")]);
    const newC = allowlistJson([mig("a#k#1")]);
    expect(allowlistExternalWidened(oldC, newC)).toBe(false);
  });

  it("adding a new external entry is widened (unsafe)", () => {
    const oldC = allowlistJson([mig("a#k#1")]);
    const newC = allowlistJson([mig("a#k#1"), ext("new#k#9", "sneaked in")]);
    expect(allowlistExternalWidened(oldC, newC)).toBe(true);
  });

  it("changing an external entry's reason is widened (unsafe)", () => {
    const oldC = allowlistJson([ext("c#k#3", "MCP config")]);
    const newC = allowlistJson([ext("c#k#3", "now something else")]);
    expect(allowlistExternalWidened(oldC, newC)).toBe(true);
  });

  it("flipping a migrate entry to external is widened (unsafe)", () => {
    const oldC = allowlistJson([mig("a#k#1")]);
    const newC = allowlistJson([ext("a#k#1", "reclassified")]);
    expect(allowlistExternalWidened(oldC, newC)).toBe(true);
  });

  it("adding a migrate entry is safe (tracked debt, not a guard bypass)", () => {
    const oldC = allowlistJson([mig("a#k#1")]);
    const newC = allowlistJson([mig("a#k#1"), mig("b#k#2")]);
    expect(allowlistExternalWidened(oldC, newC)).toBe(false);
  });

  it("unparseable new content fails closed (treated as widened)", () => {
    const oldC = allowlistJson([mig("a#k#1")]);
    expect(allowlistExternalWidened(oldC, "{ not json")).toBe(true);
  });

  it("identical content is not widened", () => {
    const c = allowlistJson([mig("a#k#1"), ext("c#k#3", "MCP config")]);
    expect(allowlistExternalWidened(c, c)).toBe(false);
  });
});

// ---------- "default = intent" boundary ----------

describe("default = intent boundary", () => {
  it("a near-miss kind (e.g. 'format' vs 'formatter') is intent", () => {
    expect(classifyFinding(finding("format"))).toBe("intent");
    expect(classifyFinding(finding("lint"))).toBe("intent");
    expect(classifyFinding(finding("whitespace"))).toBe("intent");
  });

  it("a kind that is a prefix of a mechanical kind is still intent", () => {
    expect(classifyFinding(finding("trailing"))).toBe("intent");
    expect(classifyFinding(finding("import"))).toBe("intent");
  });

  it("a concatenated kind that contains a mechanical substring is intent", () => {
    expect(classifyFinding(finding("formatter-plus-logic"))).toBe("intent");
    expect(classifyFinding(finding("custom-lint-fix"))).toBe("intent");
  });

  it("MECHANICAL_KINDS are all lowercase (no hidden casing exceptions)", () => {
    for (const kind of MECHANICAL_KINDS) {
      expect(kind).toBe(kind.toLowerCase());
    }
  });
});

function extractCommandGuardWorktreeRootLiteral(source: string): string {
  const match = source.match(/allowed_root="\$\(canonical_path "\$REPO_ROOT" "([^"]+)"\)"/);
  expect(match).not.toBeNull();
  return `${match![1].replace(/\/+$/, "")}/`;
}

function extractSensitivePathTmpRootLiteral(patterns: readonly RegExp[]): string {
  const pattern = patterns.find((p) => p.source.startsWith("^\\.red\\/tmp\\/"));
  expect(pattern).toBeDefined();
  return pattern!.source
    .replace(/^\^/, "")
    .replace(/\\\//g, "/")
    .replace(/\\\./g, ".");
}

// ---------- ordered gate verdict (ADR 0119, issue #2245) ----------

describe("gateVerdict — one verdict, cheap stage first", () => {
  it("orders the stages cheap → expensive", () => {
    expect(GATE_STAGE_ORDER).toEqual(["trust", "feedback", "backpressure"]);
  });

  it("is green when every stage passed", () => {
    expect(
      gateVerdict([
        { stage: "trust", ok: true },
        { stage: "feedback", ok: true },
        { stage: "backpressure", ok: true },
      ]),
    ).toEqual({ ok: true });
  });

  it("reports the EARLIEST blocking stage, not the first one evaluated", () => {
    const verdict = gateVerdict([
      { stage: "backpressure", ok: false },
      { stage: "feedback", ok: false },
      { stage: "trust", ok: false, sensitivePaths: [{ path: ".github/workflows/ci.yml", reason: "CI workflow file" }] },
    ]);
    expect(verdict.ok).toBe(false);
    expect(verdict.failedStage).toBe("trust");
    expect(verdict.sensitivePaths).toHaveLength(1);
  });

  it("carries the hits only for a failed trust stage", () => {
    const verdict = gateVerdict([
      { stage: "trust", ok: true, sensitivePaths: [] },
      { stage: "feedback", ok: false },
    ]);
    expect(verdict).toEqual({ ok: false, failedStage: "feedback" });
  });

  it("a skipped stage never blocks", () => {
    expect(
      gateVerdict([
        { stage: "trust", ok: true },
        { stage: "feedback", ok: true },
        { stage: "backpressure", ok: false, skipped: true },
      ]),
    ).toEqual({ ok: true });
  });

  it("folds the stages run so far — a partial gate is still one verdict", () => {
    expect(gateVerdict([{ stage: "trust", ok: true }])).toEqual({ ok: true });
    expect(gateVerdict([]).ok).toBe(true);
  });
});
