import { encode as encodeToon } from "@reddb-io/toon";
import type { CatalogToonVersion } from "./toon-version.js";

export type HostBinaryVerdict = "ok" | "error";

export type HostBinaryFindingKind = "missing" | "toolchain-drift";

export interface HostBinaryFacts {
  readonly name: string;
  readonly catalog: CatalogToonVersion;
  readonly recordedVersion?: string;
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
  readonly catalog: string;
  readonly recorded: string;
  readonly observed: string;
  readonly verdict: HostBinaryVerdict;
}

export interface HostBinaryReport {
  readonly findings: HostBinaryFinding[];
  readonly rows: HostBinaryRow[];
}

function canonicalInstallerFix(name: string, catalog: CatalogToonVersion): string {
  if (name === "tq") {
    return `install pinned tq with: TQ_VERSION=${catalog.tag} curl -fsSL https://raw.githubusercontent.com/reddb-io/toon/${catalog.tag}/install.sh | sh`;
  }
  return `install pinned ${name} version ${catalog.version}`;
}

function auditHostBinary(facts: HostBinaryFacts): { finding?: HostBinaryFinding; row: HostBinaryRow } {
  const binary = facts.name;
  const catalog = facts.catalog.version;
  const recorded = facts.recordedVersion ?? "missing";
  const observed = facts.observedVersion ?? "missing";

  const finding = (
    kind: HostBinaryFindingKind,
    reason: string,
  ): HostBinaryFinding => ({
    binary,
    kind,
    verdict: "error",
    reason,
    remediation: canonicalInstallerFix(binary, facts.catalog),
  });

  if (facts.recordedVersion !== catalog || (facts.observedVersion !== undefined && facts.observedVersion !== catalog)) {
    return {
      finding: finding(
        "toolchain-drift",
        `required host binary ${binary} toolchain drift: catalog pin ${catalog}, config pin ${recorded}, observed ${binary} ${observed}`,
      ),
      row: { binary, catalog, recorded, observed, verdict: "error" },
    };
  }

  if (!facts.observedVersion) {
    return {
      finding: finding("missing", `required host binary ${binary} is missing`),
      row: { binary, catalog, recorded, observed, verdict: "error" },
    };
  }

  return {
    row: { binary, catalog, recorded, observed, verdict: "ok" },
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
      catalog: row.catalog,
      recorded: row.recorded,
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
