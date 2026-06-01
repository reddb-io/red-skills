import { describe, expect, test } from "vitest";
import {
  DRIFT_GUARD_GLOBS,
  driftGuardActionableLine,
  evaluateDriftGuard,
  filterDriftGuardPaths,
} from "../src/drift-guard.js";

const TRAILER = "Memory-Ingested: 1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b";

describe("drift-guard watched set (#224, ADR 0027 Gap 3)", () => {
  test("watches exactly the four PR-enforced surfaces — wiki is excluded", () => {
    expect([...DRIFT_GUARD_GLOBS]).toEqual([
      ".red/adr/**",
      ".red/CONTEXT.md",
      ".red/CONTEXT-MAP.md",
      ".red/contexts/**",
    ]);
    // The gitignored, auto-generated wiki surface is deliberately NOT enforced.
    expect(filterDriftGuardPaths([".red/wiki/pages/memory.md"])).toEqual([]);
  });

  test.each([
    [".red/adr/0027-closed-loop.md", true],
    [".red/adr/sub/nested/0001.md", true],
    [".red/CONTEXT.md", true],
    [".red/CONTEXT-MAP.md", true],
    [".red/contexts/afk.md", true],
    ["/repo/.red/adr/0001.md", true],
    ["src/widget.ts", false],
    [".red/agents/memory.md", false],
    [".red/CONTEXT.json", false],
  ])("filterDriftGuardPaths includes %s === %s", (path, included) => {
    expect(filterDriftGuardPaths([path]).length > 0).toBe(included);
  });
});

describe("evaluateDriftGuard verdicts", () => {
  test("code-only PR passes silently with no event (AC3)", () => {
    const verdict = evaluateDriftGuard({
      changedFiles: ["src/a.ts", "README.md", "package.json"],
    });
    expect(verdict).toEqual({
      status: "pass",
      reason: "no-watched-paths",
      watchedChanged: [],
    });
  });

  test("watched path with a Memory-Ingested trailer passes (AC5)", () => {
    const verdict = evaluateDriftGuard({
      changedFiles: [".red/adr/0030-new.md"],
      headCommitMessage: `docs(adr): add 0030\n\nRefs #999\n${TRAILER}\n`,
    });
    expect(verdict.status).toBe("pass");
    if (verdict.status === "pass" && verdict.reason === "marker-present") {
      expect(verdict.marker).toMatchObject({ form: "commit-trailer", kind: "ingested" });
    }
  });

  test("watched path with a Memory-NoIngest bypass trailer passes (AC6)", () => {
    const verdict = evaluateDriftGuard({
      changedFiles: [".red/CONTEXT.md"],
      headCommitMessage: "fix(context): typo\n\nMemory-NoIngest: typo fix only\n",
    });
    expect(verdict.status).toBe("pass");
    if (verdict.status === "pass" && verdict.reason === "marker-present") {
      expect(verdict.marker).toMatchObject({ form: "commit-trailer", kind: "noingest" });
    }
  });

  test("watched path with an audit-log entry passes (AC5 — audit-log form)", () => {
    const verdict = evaluateDriftGuard({
      changedFiles: [".red/adr/0031.md"],
      headCommitMessage: "docs(adr): add 0031\n",
      auditLogLines: [
        "# memory audit log",
        "",
        "2026-05-28T12:00:00Z ingest .red/adr/0031.md 1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b",
      ],
    });
    expect(verdict.status).toBe("pass");
    if (verdict.status === "pass" && verdict.reason === "marker-present") {
      expect(verdict.marker.form).toBe("audit-log");
    }
  });

  test("watched path with no marker fails with the documented actionable line (AC4)", () => {
    const verdict = evaluateDriftGuard({
      changedFiles: ["src/a.ts", ".red/adr/0032.md"],
      headCommitMessage: "docs(adr): add 0032 without ingest\n\nRefs #1000\n",
    });
    expect(verdict.status).toBe("fail");
    if (verdict.status === "fail") {
      expect(verdict.watchedChanged).toEqual([".red/adr/0032.md"]);
      expect(verdict.actionableLine).toBe(
        "Run /memory:ingest .red/adr/0032.md and re-push (or add Memory-NoIngest: <reason> trailer).",
      );
    }
  });

  test("multiple watched paths in one PR are handled (AC: multi-path)", () => {
    const verdict = evaluateDriftGuard({
      changedFiles: [".red/adr/0033.md", ".red/CONTEXT.md", ".red/contexts/afk.md"],
      headCommitMessage: "big docs change\n",
    });
    expect(verdict.status).toBe("fail");
    if (verdict.status === "fail") {
      expect(verdict.watchedChanged).toEqual([
        ".red/adr/0033.md",
        ".red/CONTEXT.md",
        ".red/contexts/afk.md",
      ]);
    }
  });

  test("a malformed trailer-like line does not count as a marker", () => {
    const verdict = evaluateDriftGuard({
      changedFiles: [".red/adr/0034.md"],
      headCommitMessage: "Memory-Ingested: not-a-sha\n",
    });
    expect(verdict.status).toBe("fail");
  });
});

describe("driftGuardActionableLine", () => {
  test("substitutes the concrete path and keeps the bypass hint", () => {
    expect(driftGuardActionableLine(".red/adr/0099.md")).toBe(
      "Run /memory:ingest .red/adr/0099.md and re-push (or add Memory-NoIngest: <reason> trailer).",
    );
  });
});
