import { encode as encodeToon } from "@reddb-io/toon";
import { LABEL_NEEDS_SLICING } from "./triage-labels.js";

/**
 * Spec sub-issue reconciler — ADR 0094's hierarchy-edge analogue to the
 * dependency-edge doctor. `spec:N` labels remain the machine truth while native
 * GitHub sub-issue edges are the human surface.
 */

export type SpecSubIssueVerdict = "ok" | "warn";

export type SpecSubIssueFindingKind =
  | "label-child-without-native"
  | "native-without-label-child";

export interface SpecSubIssueCandidate {
  readonly number: number;
  readonly labels: readonly string[];
  /** Children carrying `spec:<number>` labels. */
  readonly labelChildren: readonly number[];
  /** Native GitHub sub-issue child numbers for this Spec. */
  readonly nativeSubIssues: readonly number[];
}

export interface SpecSubIssueFinding {
  readonly spec: number;
  readonly child: number;
  readonly kind: SpecSubIssueFindingKind;
  readonly verdict: "warn";
  readonly reason: string;
  readonly remediation: string;
}

export interface SpecSubIssueRow {
  readonly spec: number;
  readonly labelChildren: string;
  readonly nativeSubIssues: string;
  readonly verdict: SpecSubIssueVerdict;
}

export interface SpecSubIssueReport {
  readonly findings: SpecSubIssueFinding[];
  readonly rows: SpecSubIssueRow[];
}

export interface SpecSubIssueReconcileResult {
  readonly attached: Array<{ spec: number; child: number }>;
  readonly needsSlicingRemoved: number[];
}

export interface SpecSubIssueReconcileGh {
  attachSubIssue(parent: number, child: number): Promise<void>;
  editLabels(issue: number, remove: string[], add: string[]): Promise<void>;
}

const REMEDIATION =
  "run the Spec sub-issue reconciler so spec:N labels and native sub-issues match";

function sortedUnique(values: readonly number[]): number[] {
  const seen = new Set<number>();
  for (const value of values) {
    if (Number.isInteger(value) && value > 0) seen.add(value);
  }
  return [...seen].sort((a, b) => a - b);
}

function setDiff(left: readonly number[], right: ReadonlySet<number>): number[] {
  return left.filter((value) => !right.has(value));
}

function cell(values: readonly number[]): string {
  return values.join(" ");
}

export function auditSpecSubIssueEdges(
  specs: readonly SpecSubIssueCandidate[],
): SpecSubIssueReport {
  const findings: SpecSubIssueFinding[] = [];
  const rows: SpecSubIssueRow[] = [];

  for (const spec of [...specs].sort((a, b) => a.number - b.number)) {
    const labelChildren = sortedUnique(spec.labelChildren);
    const nativeChildren = sortedUnique(spec.nativeSubIssues);
    const labelSet = new Set(labelChildren);
    const nativeSet = new Set(nativeChildren);

    for (const child of setDiff(labelChildren, nativeSet)) {
      findings.push({
        spec: spec.number,
        child,
        kind: "label-child-without-native",
        verdict: "warn",
        reason: `#${spec.number} has spec:${spec.number} child #${child} but no native sub-issue edge`,
        remediation: REMEDIATION,
      });
    }

    for (const child of setDiff(nativeChildren, labelSet)) {
      findings.push({
        spec: spec.number,
        child,
        kind: "native-without-label-child",
        verdict: "warn",
        reason: `#${spec.number} has native sub-issue #${child} but no spec:${spec.number} label`,
        remediation: REMEDIATION,
      });
    }

    rows.push({
      spec: spec.number,
      labelChildren: cell(labelChildren),
      nativeSubIssues: cell(nativeChildren),
      verdict:
        labelChildren.length === nativeChildren.length && labelChildren.every((n) => nativeSet.has(n))
          ? "ok"
          : "warn",
    });
  }

  findings.sort((a, b) => a.spec - b.spec || a.child - b.child || a.kind.localeCompare(b.kind));
  return { findings, rows };
}

export async function executeSpecSubIssueReconcile(
  candidates: readonly SpecSubIssueCandidate[],
  gh: SpecSubIssueReconcileGh,
): Promise<SpecSubIssueReconcileResult> {
  const attached: Array<{ spec: number; child: number }> = [];
  const needsSlicingRemoved: number[] = [];

  for (const candidate of [...candidates].sort((a, b) => a.number - b.number)) {
    const labelChildren = sortedUnique(candidate.labelChildren);
    const nativeSet = new Set(sortedUnique(candidate.nativeSubIssues));

    for (const child of labelChildren) {
      if (nativeSet.has(child)) continue;
      try {
        await gh.attachSubIssue(candidate.number, child);
        attached.push({ spec: candidate.number, child });
      } catch {
        // Best-effort: a failed edge write leaves the Spec for the next sweep.
      }
    }

    if (labelChildren.length > 0 && candidate.labels.includes(LABEL_NEEDS_SLICING)) {
      try {
        await gh.editLabels(candidate.number, [LABEL_NEEDS_SLICING], []);
        needsSlicingRemoved.push(candidate.number);
      } catch {
        // Best-effort: stale needs-slicing is harmless and retried next boot.
      }
    }
  }

  return { attached, needsSlicingRemoved };
}

export function renderSpecSubIssueReportToon(report: SpecSubIssueReport): string {
  return encodeToon({
    specs: report.rows.map((row) => ({
      spec: row.spec,
      labelChildren: row.labelChildren,
      nativeSubIssues: row.nativeSubIssues,
      verdict: row.verdict,
    })),
    findings: report.findings.map((finding) => ({
      spec: finding.spec,
      child: finding.child,
      kind: finding.kind,
      verdict: finding.verdict,
    })),
  });
}
