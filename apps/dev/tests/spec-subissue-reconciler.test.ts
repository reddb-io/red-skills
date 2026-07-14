import { describe, expect, it } from "vitest";
import { decode } from "@reddb-io/toon";
import {
  auditSpecSubIssueEdges,
  executeSpecSubIssueReconcile,
  renderSpecSubIssueReportToon,
  type SpecSubIssueCandidate,
} from "../src/core/spec-subissue-reconciler.js";

function spec(overrides: Partial<SpecSubIssueCandidate>): SpecSubIssueCandidate {
  return {
    number: 1,
    labels: ["type:spec"],
    labelChildren: [],
    nativeSubIssues: [],
    ...overrides,
  };
}

describe("auditSpecSubIssueEdges — Spec sub-issue redundancy guard", () => {
  it("reports spec:N children missing native sub-issue edges", () => {
    const report = auditSpecSubIssueEdges([
      spec({ number: 42, labelChildren: [7, 8], nativeSubIssues: [7] }),
    ]);

    expect(report.findings).toEqual([
      {
        spec: 42,
        child: 8,
        kind: "label-child-without-native",
        verdict: "warn",
        reason: "#42 has spec:42 child #8 but no native sub-issue edge",
        remediation: "run the Spec sub-issue reconciler so spec:N labels and native sub-issues match",
      },
    ]);
  });

  it("reports native sub-issue children missing the spec:N label", () => {
    const report = auditSpecSubIssueEdges([
      spec({ number: 43, labelChildren: [10], nativeSubIssues: [10, 11] }),
    ]);

    expect(report.findings.map((f) => f.kind)).toEqual(["native-without-label-child"]);
    expect(report.findings[0]?.reason).toBe("#43 has native sub-issue #11 but no spec:43 label");
  });

  it("renders a compact doctor scorecard and finding table", () => {
    const toon = renderSpecSubIssueReportToon(
      auditSpecSubIssueEdges([spec({ number: 42, labelChildren: [7, 8], nativeSubIssues: [7] })]),
    );
    const decoded = decode(toon) as {
      specs: Array<{ spec: number; labelChildren: string; nativeSubIssues: string; verdict: string }>;
      findings: Array<{ spec: number; child: number; kind: string; verdict: string }>;
    };

    expect(toon).toContain("specs[1]{spec,labelChildren,nativeSubIssues,verdict}");
    expect(toon).toContain("findings[1]{spec,child,kind,verdict}");
    expect(decoded.specs).toEqual([{ spec: 42, labelChildren: "7 8", nativeSubIssues: "7", verdict: "warn" }]);
    expect(decoded.findings).toEqual([{ spec: 42, child: 8, kind: "label-child-without-native", verdict: "warn" }]);
  });
});

describe("executeSpecSubIssueReconcile", () => {
  it("attaches label-only children and strips stale needs-slicing when slices exist", async () => {
    const attached: Array<{ parent: number; child: number }> = [];
    const edits: Array<{ issue: number; remove: string[]; add: string[] }> = [];

    const healed = await executeSpecSubIssueReconcile(
      [spec({ number: 42, labels: ["type:spec", "needs-slicing"], labelChildren: [7, 8], nativeSubIssues: [7] })],
      {
        async attachSubIssue(parent, child) {
          attached.push({ parent, child });
        },
        async editLabels(issue, remove, add) {
          edits.push({ issue, remove, add });
        },
      },
    );

    expect(healed).toEqual({ attached: [{ spec: 42, child: 8 }], needsSlicingRemoved: [42] });
    expect(attached).toEqual([{ parent: 42, child: 8 }]);
    expect(edits).toEqual([{ issue: 42, remove: ["needs-slicing"], add: [] }]);
  });
});
