import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  collectRepairViolations,
  readRepairScanFiles,
  type RepairScanFile,
} from "../src/core/repair-guard.js";
import { REPO_INVARIANT_SUITES } from "../src/core/repo-invariants.js";

const ROOT = join(import.meta.dirname, "..", "..", "..");

function file(path: string, sourceText: string): RepairScanFile {
  return { path, sourceText };
}

describe("every structured castle refusal carries a repair (#3260)", () => {
  it("is green on the live castle refusal surfaces", () => {
    expect(collectRepairViolations(readRepairScanFiles(ROOT))).toEqual([]);
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
