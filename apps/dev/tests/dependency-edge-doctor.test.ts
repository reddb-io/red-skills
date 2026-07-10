import { describe, expect, it } from "vitest";
import { decode } from "@reddb-io/toon";
import {
  auditDependencyEdges,
  renderDependencyEdgeReportToon,
  type DependencyEdgeTicket,
} from "../src/core/dependency-edge-doctor.js";

function ticket(overrides: Partial<DependencyEdgeTicket>): DependencyEdgeTicket {
  return {
    number: 1,
    labels: [],
    nativeBlockedBy: [],
    ...overrides,
  };
}

describe("auditDependencyEdges — ADR 0094 redundancy guard", () => {
  it("reports native blocked-by edges without req:N labels", () => {
    const report = auditDependencyEdges([
      ticket({ number: 42, labels: ["blocked:dependency", "req:7"], nativeBlockedBy: [7, 8] }),
    ]);

    expect(report.findings).toEqual([
      {
        ticket: 42,
        blocker: 8,
        kind: "native-without-req-label",
        verdict: "warn",
        reason: "#42 has native blocked-by #8 but no req:8 label",
        remediation: "refresh dependency metadata with /triage so native blocked-by edges and req:N labels match",
      },
    ]);
  });

  it("reports req:N labels without native blocked-by edges", () => {
    const report = auditDependencyEdges([
      ticket({ number: 43, labels: ["blocked:dependency", "req:7", "req:9"], nativeBlockedBy: [7] }),
    ]);

    expect(report.findings.map((f) => f.kind)).toEqual(["req-label-without-native"]);
    expect(report.findings[0]?.reason).toBe("#43 has req:9 label but no native blocked-by #9 edge");
  });

  it("reports both directions per Ticket and keeps deterministic ordering", () => {
    const report = auditDependencyEdges([
      ticket({ number: 10, labels: ["req:4", "req:2", "req:4"], nativeBlockedBy: [2, 3, 5, 3] }),
      ticket({ number: 9, labels: ["req:8"], nativeBlockedBy: [] }),
    ]);

    expect(report.findings.map((f) => `${f.ticket}:${f.blocker}:${f.kind}`)).toEqual([
      "9:8:req-label-without-native",
      "10:3:native-without-req-label",
      "10:4:req-label-without-native",
      "10:5:native-without-req-label",
    ]);
    expect(report.rows).toEqual([
      { ticket: 9, reqLabels: "8", nativeBlockedBy: "", verdict: "warn" },
      { ticket: 10, reqLabels: "2 4", nativeBlockedBy: "2 3 5", verdict: "warn" },
    ]);
  });

  it("ignores parent Specs because the check is scoped to open Tickets", () => {
    const report = auditDependencyEdges([
      ticket({ number: 1286, labels: ["type:spec", "req:1"], nativeBlockedBy: [] }),
      ticket({ number: 1296, labels: ["type:bug", "req:1"], nativeBlockedBy: [1] }),
    ]);

    expect(report.findings).toEqual([]);
    expect(report.rows.map((r) => r.ticket)).toEqual([1296]);
  });
});

describe("renderDependencyEdgeReportToon", () => {
  it("renders a compact doctor scorecard and finding table", () => {
    const toon = renderDependencyEdgeReportToon(
      auditDependencyEdges([ticket({ number: 43, labels: ["req:9"], nativeBlockedBy: [] })]),
    );
    const decoded = decode(toon) as {
      tickets: Array<{ ticket: number; reqLabels: string; nativeBlockedBy: string; verdict: string }>;
      findings: Array<{ ticket: number; blocker: number; kind: string; verdict: string }>;
    };

    expect(toon).toContain("tickets[1]{ticket,reqLabels,nativeBlockedBy,verdict}");
    expect(toon).toContain("findings[1]{ticket,blocker,kind,verdict}");
    expect(decoded.tickets).toEqual([{ ticket: 43, reqLabels: "9", nativeBlockedBy: "", verdict: "warn" }]);
    expect(decoded.findings).toEqual([{ ticket: 43, blocker: 9, kind: "req-label-without-native", verdict: "warn" }]);
    expect(toon).not.toContain("{\n");
  });
});
