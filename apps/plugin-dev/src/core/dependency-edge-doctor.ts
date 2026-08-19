import { parseReqLabels } from "./boot-sweep.js";
import { LABEL_TYPE_SPEC } from "./triage-labels.js";
import { encode as encodeToon } from "@reddb-io/toon";

/**
 * dependency-edge-doctor.ts — the ADR 0094 consistency guard for the adoption
 * doctor. Native GitHub blocked-by edges are the human surface, while `req:N`
 * labels remain AFK's machine truth. This module compares the two injected
 * surfaces without reading GitHub or mutating tracker state.
 */

export type DependencyEdgeVerdict = "ok" | "warn";

export type DependencyEdgeFindingKind =
  | "native-without-req-label"
  | "req-label-without-native";

export interface DependencyEdgeTicket {
  readonly number: number;
  readonly labels: readonly string[];
  /** Native GitHub blocked-by issue numbers for this open issue. */
  readonly nativeBlockedBy: readonly number[];
}

export interface DependencyEdgeFinding {
  readonly ticket: number;
  readonly blocker: number;
  readonly kind: DependencyEdgeFindingKind;
  readonly verdict: "warn";
  readonly reason: string;
  readonly remediation: string;
}

export interface DependencyEdgeRow {
  readonly ticket: number;
  /** Space-separated blocker ids from `req:N` labels, for compact scorecards. */
  readonly reqLabels: string;
  /** Space-separated blocker ids from native blocked-by edges. */
  readonly nativeBlockedBy: string;
  readonly verdict: DependencyEdgeVerdict;
}

export interface DependencyEdgeReport {
  readonly findings: DependencyEdgeFinding[];
  readonly rows: DependencyEdgeRow[];
}

const REMEDIATION =
  "refresh dependency metadata with /triage so native blocked-by edges and req:N labels match";

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

export function auditDependencyEdges(tickets: readonly DependencyEdgeTicket[]): DependencyEdgeReport {
  const findings: DependencyEdgeFinding[] = [];
  const rows: DependencyEdgeRow[] = [];

  for (const ticket of [...tickets].sort((a, b) => a.number - b.number)) {
    if (ticket.labels.includes(LABEL_TYPE_SPEC)) continue;

    const reqs = parseReqLabels(ticket.labels);
    const native = sortedUnique(ticket.nativeBlockedBy);
    const reqSet = new Set(reqs);
    const nativeSet = new Set(native);

    for (const blocker of setDiff(native, reqSet)) {
      findings.push({
        ticket: ticket.number,
        blocker,
        kind: "native-without-req-label",
        verdict: "warn",
        reason: `#${ticket.number} has native blocked-by #${blocker} but no req:${blocker} label`,
        remediation: REMEDIATION,
      });
    }

    for (const blocker of setDiff(reqs, nativeSet)) {
      findings.push({
        ticket: ticket.number,
        blocker,
        kind: "req-label-without-native",
        verdict: "warn",
        reason: `#${ticket.number} has req:${blocker} label but no native blocked-by #${blocker} edge`,
        remediation: REMEDIATION,
      });
    }

    rows.push({
      ticket: ticket.number,
      reqLabels: cell(reqs),
      nativeBlockedBy: cell(native),
      verdict: reqs.length === native.length && reqs.every((n) => nativeSet.has(n)) ? "ok" : "warn",
    });
  }

  findings.sort((a, b) => a.ticket - b.ticket || a.blocker - b.blocker || a.kind.localeCompare(b.kind));
  return { findings, rows };
}

export function renderDependencyEdgeReportToon(report: DependencyEdgeReport): string {
  return encodeToon({
    tickets: report.rows.map((row) => ({
      ticket: row.ticket,
      reqLabels: row.reqLabels,
      nativeBlockedBy: row.nativeBlockedBy,
      verdict: row.verdict,
    })),
    findings: report.findings.map((finding) => ({
      ticket: finding.ticket,
      blocker: finding.blocker,
      kind: finding.kind,
      verdict: finding.verdict,
    })),
  });
}
