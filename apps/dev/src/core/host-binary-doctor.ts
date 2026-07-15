import { encode as encodeToon } from "@reddb-io/toon";

export type HostBinaryVerdict = "ok" | "error";

export type HostBinaryFindingKind = "missing" | "version-drift";

export interface HostBinaryFacts {
  readonly name: string;
  readonly requiredVersion: string;
  readonly observedVersion?: string;
}

export interface HostBinaryFinding {
  readonly binary: string;
  readonly kind: HostBinaryFindingKind;
  readonly verdict: "error";
  readonly reason: string;
  readonly remediation: string;
}

export interface HostBinaryRow {
  readonly binary: string;
  readonly required: string;
  readonly observed: string;
  readonly verdict: HostBinaryVerdict;
}

export interface HostBinaryReport {
  readonly findings: HostBinaryFinding[];
  readonly rows: HostBinaryRow[];
}

function canonicalInstallerFix(name: string, version: string): string {
  if (name === "tq") {
    return `install pinned tq with: TQ_VERSION=v${version} curl -fsSL https://raw.githubusercontent.com/reddb-io/toon/v${version}/install.sh | sh`;
  }
  return `install pinned ${name} version ${version}`;
}

function auditHostBinary(facts: HostBinaryFacts): { finding?: HostBinaryFinding; row: HostBinaryRow } {
  const binary = facts.name;
  const required = facts.requiredVersion;
  const observed = facts.observedVersion ?? "missing";

  const finding = (
    kind: HostBinaryFindingKind,
    reason: string,
  ): HostBinaryFinding => ({
    binary,
    kind,
    verdict: "error",
    reason,
    remediation: canonicalInstallerFix(binary, required),
  });

  if (!facts.observedVersion) {
    return {
      finding: finding("missing", `required host binary ${binary} is missing`),
      row: { binary, required, observed, verdict: "error" },
    };
  }

  if (facts.observedVersion !== required) {
    return {
      finding: finding(
        "version-drift",
        `required host binary ${binary} is ${facts.observedVersion}, expected ${required}`,
      ),
      row: { binary, required, observed, verdict: "error" },
    };
  }

  return {
    row: { binary, required, observed, verdict: "ok" },
  };
}

export function auditHostBinaries(facts: readonly HostBinaryFacts[]): HostBinaryReport {
  const findings: HostBinaryFinding[] = [];
  const rows: HostBinaryRow[] = [];

  for (const fact of facts) {
    const result = auditHostBinary(fact);
    rows.push(result.row);
    if (result.finding) findings.push(result.finding);
  }

  return { findings, rows };
}

export function renderHostBinaryReportToon(report: HostBinaryReport): string {
  return encodeToon({
    binaries: report.rows.map((row) => ({
      binary: row.binary,
      required: row.required,
      observed: row.observed,
      verdict: row.verdict,
    })),
    findings: report.findings.map((finding) => ({
      binary: finding.binary,
      kind: finding.kind,
      verdict: finding.verdict,
    })),
  });
}
