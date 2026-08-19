import { encode as encodeToon } from "@reddb-io/toon";
import {
  planDocsSweep,
  renderDocsSweepFileList,
  type DocsSweepInput,
  type DocsSweepPlan,
} from "./docs-sweep.js";

/**
 * unlanded-docs-doctor.ts — the adoption-doctor view over the shared Docs Sweep
 * detector. The runtime injects already-collected docs facts and the ADR 0092
 * lander; this module never shells out, fetches, pushes, or talks to GitHub.
 */

export type UnlandedDocsVerdict = "ok" | "warn" | "error";

export type UnlandedDocsFindingKind = "unlanded-docs" | "landing-blocked";

export type UnlandedDocsFixGate = "none" | "confirm-each";

export type UnlandedDocsFixStatus = "noop" | "declined" | "applied" | "failed";

export interface UnlandedDocsFinding {
  kind: UnlandedDocsFindingKind;
  verdict: Exclude<UnlandedDocsVerdict, "ok">;
  base: string;
  files: string;
  reason: string;
  remediation: string;
}

export interface UnlandedDocsScorecardRow {
  check: "unlanded-red-docs";
  verdict: UnlandedDocsVerdict;
  evidence: string;
  fixHome: string;
}

export interface UnlandedDocsDoctorReport {
  plan: DocsSweepPlan;
  row: UnlandedDocsScorecardRow;
  findings: UnlandedDocsFinding[];
}

export interface UnlandedDocsFixPlan {
  gate: UnlandedDocsFixGate;
  hardToReverse: boolean;
  docsPlan: DocsSweepPlan;
  summary: string;
}

export interface UnlandedDocsFixDeps {
  confirmHardToReverse(plan: UnlandedDocsFixPlan): Promise<boolean> | boolean;
  landDocs(plan: DocsSweepPlan): Promise<{ ok: true } | { ok: false; reason: string }>;
}

export interface UnlandedDocsFixResult {
  status: UnlandedDocsFixStatus;
  plan: UnlandedDocsFixPlan;
  reason?: string;
}

const REMEDIATION = "land .red docs through the ADR 0092 doc-landing lane";
const FIX_HOME = "→ ADR 0092 doc-landing lane";

export function auditUnlandedDocs(input: DocsSweepInput): UnlandedDocsDoctorReport {
  const plan = planDocsSweep(input);
  const files = renderDocsSweepFileList(plan.files);

  if (plan.action === "clean") {
    return {
      plan,
      row: {
        check: "unlanded-red-docs",
        verdict: "ok",
        evidence: `origin/${plan.base} has no unlanded .red docs`,
        fixHome: FIX_HOME,
      },
      findings: [],
    };
  }

  if (plan.action === "halt") {
    const reason = plan.haltReason ?? "unknown";
    return {
      plan,
      row: {
        check: "unlanded-red-docs",
        verdict: "error",
        evidence: `${reason}: ${files}`,
        fixHome: FIX_HOME,
      },
      findings: [
        {
          kind: "landing-blocked",
          verdict: "error",
          base: plan.base,
          files,
          reason: `Docs landing is blocked: ${reason}`,
          remediation: REMEDIATION,
        },
      ],
    };
  }

  return {
    plan,
    row: {
      check: "unlanded-red-docs",
      verdict: "warn",
      evidence: files,
      fixHome: FIX_HOME,
    },
    findings: [
      {
        kind: "unlanded-docs",
        verdict: "warn",
        base: plan.base,
        files,
        reason: `.red docs are not landed on origin/${plan.base}`,
        remediation: REMEDIATION,
      },
    ],
  };
}

export function planUnlandedDocsFix(report: UnlandedDocsDoctorReport): UnlandedDocsFixPlan {
  const files = renderDocsSweepFileList(report.plan.files);
  if (report.plan.action !== "land") {
    return {
      gate: "none",
      hardToReverse: false,
      docsPlan: report.plan,
      summary: report.plan.action === "clean" ? "no unlanded .red docs" : `cannot land .red docs: ${report.plan.haltReason ?? "unknown"}`,
    };
  }

  return {
    gate: "confirm-each",
    hardToReverse: true,
    docsPlan: report.plan,
    summary: `ADR 0092 doc-landing PR for origin/${report.plan.base}: ${files}`,
  };
}

export async function executeUnlandedDocsFix(
  fixPlan: UnlandedDocsFixPlan,
  deps: UnlandedDocsFixDeps,
): Promise<UnlandedDocsFixResult> {
  if (fixPlan.docsPlan.action !== "land") {
    return { status: "noop", plan: fixPlan };
  }

  const confirmed = await deps.confirmHardToReverse(fixPlan);
  if (!confirmed) return { status: "declined", plan: fixPlan };

  const landed = await deps.landDocs(fixPlan.docsPlan);
  if (!landed.ok) return { status: "failed", plan: fixPlan, reason: landed.reason };
  return { status: "applied", plan: fixPlan };
}

export function renderUnlandedDocsDoctorToon(report: UnlandedDocsDoctorReport): string {
  return encodeToon({
    scorecard: {
      check: report.row.check,
      verdict: report.row.verdict,
      evidence: report.row.evidence,
      fixHome: report.row.fixHome,
    },
    findings: report.findings.map((finding) => ({
      kind: finding.kind,
      verdict: finding.verdict,
      base: finding.base,
      files: finding.files,
    })),
  });
}
