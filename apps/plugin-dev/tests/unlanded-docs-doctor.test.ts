import { decode } from "@reddb-io/toon";
import { describe, expect, it, vi } from "vitest";
import {
  auditUnlandedDocs,
  executeUnlandedDocsFix,
  planUnlandedDocsFix,
  renderUnlandedDocsDoctorToon,
} from "../src/core/unlanded-docs-doctor.js";
import type { DocsSweepFileState } from "../src/core/docs-sweep.js";

function doc(path: string, state: DocsSweepFileState["state"] = "modified"): DocsSweepFileState {
  return {
    path,
    state,
    group: "other",
    ignored: false,
    trackedPrecedent: true,
  };
}

describe("auditUnlandedDocs", () => {
  it("reports a clean scorecard row when the shared detector finds no unlanded docs", () => {
    const report = auditUnlandedDocs({ base: "main", files: [] });

    expect(report.plan.action).toBe("clean");
    expect(report.row).toEqual({
      check: "unlanded-red-docs",
      verdict: "ok",
      evidence: "origin/main has no unlanded .red docs",
      fixHome: "→ ADR 0092 doc-landing lane",
    });
    expect(report.findings).toEqual([]);
  });

  it("reports unlanded .red docs with the origin-first file list", () => {
    const report = auditUnlandedDocs({
      base: "develop",
      files: [
        doc(".red/contexts/dev/CONTEXT.md", "modified"),
        doc(".red/adr/0099-example.md", "untracked"),
        doc("README.md", "modified"),
      ],
    });

    expect(report.plan.action).toBe("land");
    expect(report.row.verdict).toBe("warn");
    expect(report.row.evidence).toBe("untracked:.red/adr/0099-example.md,modified:.red/contexts/dev/CONTEXT.md");
    expect(report.findings).toEqual([
      {
        kind: "unlanded-docs",
        verdict: "warn",
        base: "develop",
        files: "untracked:.red/adr/0099-example.md,modified:.red/contexts/dev/CONTEXT.md",
        reason: ".red docs are not landed on origin/develop",
        remediation: "land .red docs through the ADR 0092 doc-landing lane",
      },
    ]);
  });

  it("surfaces detector halt reasons as blocked landing findings", () => {
    const report = auditUnlandedDocs({
      base: "main",
      originReachable: false,
      files: [doc(".red/CONTEXT-MAP.md", "ahead")],
    });

    expect(report.plan.action).toBe("halt");
    expect(report.row.verdict).toBe("error");
    expect(report.row.evidence).toBe("origin-unreachable: ahead:.red/CONTEXT-MAP.md");
    expect(report.findings[0]?.kind).toBe("landing-blocked");
  });

  it("renders compact TOON for the doctor scorecard", () => {
    const toon = renderUnlandedDocsDoctorToon(
      auditUnlandedDocs({
        base: "main",
        files: [doc(".red/CONTEXT.md", "modified")],
      }),
    );
    const decoded = decode(toon) as {
      scorecard: { check: string; verdict: string; evidence: string; fixHome: string };
      findings: Array<{ kind: string; verdict: string; base: string; files: string }>;
    };

    expect(decoded.scorecard).toEqual({
      check: "unlanded-red-docs",
      verdict: "warn",
      evidence: "modified:.red/CONTEXT.md",
      fixHome: "→ ADR 0092 doc-landing lane",
    });
    expect(decoded.findings).toEqual([
      {
        kind: "unlanded-docs",
        verdict: "warn",
        base: "main",
        files: "modified:.red/CONTEXT.md",
      },
    ]);
    expect(toon).not.toContain("{\n");
  });
});

describe("executeUnlandedDocsFix", () => {
  it("builds a hard-to-reverse ADR 0092 fix plan for docs landing", () => {
    const report = auditUnlandedDocs({ base: "main", files: [doc(".red/adr/0092-docs.md")] });
    const fixPlan = planUnlandedDocsFix(report);

    expect(fixPlan).toMatchObject({
      gate: "confirm-each",
      hardToReverse: true,
      summary: "ADR 0092 doc-landing PR for origin/main: modified:.red/adr/0092-docs.md",
    });
    expect(fixPlan.docsPlan).toBe(report.plan);
  });

  it("does not call the injected lander when the hard-to-reverse gate is declined", async () => {
    const fixPlan = planUnlandedDocsFix(auditUnlandedDocs({ base: "main", files: [doc(".red/CONTEXT.md")] }));
    const confirmHardToReverse = vi.fn(async () => false);
    const landDocs = vi.fn(async () => ({ ok: true as const }));

    await expect(executeUnlandedDocsFix(fixPlan, { confirmHardToReverse, landDocs })).resolves.toEqual({
      status: "declined",
      plan: fixPlan,
    });
    expect(confirmHardToReverse).toHaveBeenCalledWith(fixPlan);
    expect(landDocs).not.toHaveBeenCalled();
  });

  it("lands through the injected ADR 0092 lane only after confirmation", async () => {
    const fixPlan = planUnlandedDocsFix(auditUnlandedDocs({ base: "main", files: [doc(".red/CONTEXT.md")] }));
    const confirmHardToReverse = vi.fn(async () => true);
    const landDocs = vi.fn(async () => ({ ok: true as const }));

    await expect(executeUnlandedDocsFix(fixPlan, { confirmHardToReverse, landDocs })).resolves.toEqual({
      status: "applied",
      plan: fixPlan,
    });
    expect(landDocs).toHaveBeenCalledWith(fixPlan.docsPlan);
  });
});
