import { LABEL_READY, LABEL_TYPE_SPEC } from "./triage-labels.js";
import { lintExecutableAcceptanceCriteria } from "./executable-acceptance.js";
import type { IssueCandidate } from "./session.js";

type DoctorVerdict = "ok" | "warn" | "error";

export interface ExecutableAcceptanceDoctorFinding {
  issue: number;
  verdict: Exclude<DoctorVerdict, "ok">;
  reason: string;
  remediation: string;
}

export interface ExecutableAcceptanceDoctorReport {
  row: {
    check: "executable-acceptance-criteria";
    verdict: DoctorVerdict;
    evidence: string;
    fixHome: "→ /triage";
  };
  checked: {
    candidates: number;
  };
  findings: ExecutableAcceptanceDoctorFinding[];
}

export function auditExecutableAcceptanceCriteria(
  candidates: readonly IssueCandidate[],
  opts: { transportFailures?: readonly string[] } = {},
): ExecutableAcceptanceDoctorReport {
  const transportFailures = opts.transportFailures ?? [];
  if (transportFailures.length > 0) {
    return {
      row: {
        check: "executable-acceptance-criteria",
        verdict: "error",
        evidence: `candidate-list-unavailable: ${transportFailures.join("; ")}`,
        fixHome: "→ /triage",
      },
      checked: { candidates: 0 },
      findings: [{
        issue: 0,
        verdict: "error",
        reason: `could not list ready-for-agent candidates: ${transportFailures.join("; ")}`,
        remediation: "restore GitHub issue visibility, then re-run /red-doctor",
      }],
    };
  }

  const executableCandidates = candidates
    .filter((candidate) => candidate.labels.includes(LABEL_READY))
    .filter((candidate) => !candidate.labels.includes(LABEL_TYPE_SPEC))
    .slice()
    .sort((a, b) => a.number - b.number);
  const findings: ExecutableAcceptanceDoctorFinding[] = [];
  for (const candidate of executableCandidates) {
    const lint = lintExecutableAcceptanceCriteria(candidate.body);
    if (lint.ok) continue;
    findings.push({
      issue: candidate.number,
      verdict: "warn",
      reason: lint.reason,
      remediation: "refresh ## Acceptance criteria with machine-checkable checklist items, then let /triage re-run readiness",
    });
  }

  return {
    row: {
      check: "executable-acceptance-criteria",
      verdict: findings.length === 0 ? "ok" : "warn",
      evidence: findings.length === 0
        ? `${executableCandidates.length} executable candidates passed acceptance-criteria lint`
        : findings.map((finding) => `#${finding.issue} ${finding.reason}`).join("; "),
      fixHome: "→ /triage",
    },
    checked: { candidates: executableCandidates.length },
    findings,
  };
}
