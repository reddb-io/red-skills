import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  collectRepairSites,
  collectRepairViolations,
  DECLARED_REPAIR_SITES,
  findRepairDeclarationViolations,
  formatRepairDeclarationFailure,
  readRepairScanFiles,
  type DeclaredRepairSite,
  type RepairScanFile,
} from "../src/core/repair-guard.js";
import { REPO_INVARIANT_SUITES } from "../src/core/repo-invariants.js";

const ROOT = join(import.meta.dirname, "..", "..", "..");

function file(path: string, sourceText: string): RepairScanFile {
  return { path, sourceText };
}

describe("every structured castle refusal carries a repair (#3260)", () => {
  it("is green on the live castle refusal surfaces", () => {
    const files = readRepairScanFiles(ROOT);
    const violations = findRepairDeclarationViolations(
      collectRepairSites(files),
      DECLARED_REPAIR_SITES,
      files,
    );

    expect(violations, formatRepairDeclarationFailure(violations)).toEqual([]);
  });

  it("fails a new refusal that has only prose", () => {
    expect(collectRepairViolations([
      file(
        "packages/red-castle/src/mcp/demo.ts",
        'return { refused: true, reason: "try something else" };',
      ),
    ])).toEqual([
      {
        path: "packages/red-castle/src/mcp/demo.ts",
        line: 1,
        reason: "structured refusal has no repair or argued none",
      },
    ]);
  });

  it("accepts a callable repair and an argued none", () => {
    expect(collectRepairViolations([
      file(
        "packages/red-castle/src/mcp/action.ts",
        'return { refused: true, reason: prose, repair: { tool: "project_start", args: {}, why: "register" } };',
      ),
      file(
        "packages/red-castle/src/mcp/none.ts",
        'return { refused: true, reason: prose, repair: "none", repair_reason: "human decision required" };',
      ),
    ])).toEqual([]);
  });

  it("rejects repair none without its reason", () => {
    expect(collectRepairViolations([
      file(
        "apps/dev/src/mcp-adapter.ts",
        'return { refused: true, reason: prose, repair: "none" };',
      ),
    ])[0]?.reason).toBe("repair none has no repair_reason");
  });

  it("runs in every cone-scoped gate", () => {
    expect(REPO_INVARIANT_SUITES.map((suite) => suite.name))
      .toContain("invariants:structured-repairs");
  });
});

describe("every castle refusal and empty state is declared (#3261)", () => {
  it("fails an undeclared refusal, naming its file and site", () => {
    const files = [
      file(
        "packages/red-castle/src/mcp/demo.ts",
        [
          "export function refuseDemo() {",
          '  return { refused: true, reason: "not available", repair: "none", repair_reason: "demo" };',
          "}",
        ].join("\n"),
      ),
    ];

    const violations = findRepairDeclarationViolations(collectRepairSites(files), [], files);

    expect(violations).toEqual([
      {
        kind: "undeclared",
        path: "packages/red-castle/src/mcp/demo.ts",
        fn: "refuseDemo",
        line: 2,
        surface: "refusal",
      },
    ]);
    const message = formatRepairDeclarationFailure(violations);
    expect(message).toContain("packages/red-castle/src/mcp/demo.ts:2");
    expect(message).toContain("refuseDemo");
  });

  it("fails a declaration whose refusal path is gone", () => {
    const declared: DeclaredRepairSite[] = [
      {
        path: "packages/red-castle/src/mcp/demo.ts",
        fn: "refuseDemo",
        surface: "refusal",
      },
    ];

    const violations = findRepairDeclarationViolations([], declared, []);

    expect(violations).toEqual([
      {
        kind: "stale",
        path: "packages/red-castle/src/mcp/demo.ts",
        fn: "refuseDemo",
        surface: "refusal",
      },
    ]);
    expect(formatRepairDeclarationFailure(violations)).toContain("delete the declaration");
  });

  it("declares the live refusal and empty-state sites by stable function name", () => {
    expect(DECLARED_REPAIR_SITES).toEqual([
      {
        path: "packages/red-castle/src/mcp/posture.ts",
        fn: "refusal",
        surface: "refusal",
      },
      {
        path: "packages/red-castle/src/mcp/worker.ts",
        fn: "workerInputRefusal",
        surface: "refusal",
      },
      {
        path: "packages/red-castle/src/mcp/help.ts",
        fn: "invoke",
        surface: "empty-state",
      },
      {
        path: "apps/dev/src/mcp-adapter.ts",
        fn: "projectStatus",
        surface: "empty-state",
      },
      {
        path: "apps/dev/src/mcp-adapter.ts",
        fn: "cursorRefusal",
        surface: "refusal",
      },
    ]);
  });
});
