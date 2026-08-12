import { encode as encodeToon } from "@reddb-io/toon";
import type { CatalogToonVersion } from "./toon-version.js";

export type HostBinaryVerdict = "ok" | "error";

export type HostBinaryFindingKind = "missing" | "toolchain-drift";

export interface HostBinaryFacts {
  readonly name: string;
  readonly catalog: CatalogToonVersion;
  /**
   * The repo's recorded pin, when it has one. It is the floor an ADOPTER repo
   * has: `readCatalogToonVersion` only answers inside this workspace, so a repo
   * that installed the plugin carries its floor here or nowhere.
   */
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
  /** Reported so a reader can see it; never a verdict input on its own. */
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
    return `install pinned tq from crates.io with: cargo install reddb-io-tq --version ${catalog.version} --locked --force`;
  }
  return `install pinned ${name} version ${catalog.version}`;
}

/**
 * Compare two `x.y.z` versions. Returns <0, 0, or >0 like a sort comparator.
 *
 * A non-numeric or short segment reads as 0, so a prerelease or a build suffix
 * never makes a host look NEWER than it is — the safe way to be wrong here is
 * to under-count, because under-counting reddens and over-counting hides.
 */
function compareVersions(left: string, right: string): number {
  const parts = (value: string): number[] =>
    value.trim().replace(/^v/, "").split(/[.+-]/).slice(0, 3).map((part) => Number(part) || 0);
  const [a, b] = [parts(left), parts(right)];
  for (let i = 0; i < 3; i += 1) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) - (b[i] ?? 0);
  }
  return 0;
}

/**
 * The catalog version is a FLOOR, not an equality.
 *
 * The danger this check exists for runs one way only: `tq` OLDER than the
 * library cannot read what the library writes, and ADR 0097 §3 removed the jq
 * fallback precisely so that state is loud instead of silently degraded. A `tq`
 * NEWER than the library reads everything — that is how the format ships, new
 * readers over old files.
 *
 * Demanding equality could not tell those two apart: it reddened on an operator
 * whose only sin was running the current release, and its remediation told them
 * to DOWNGRADE to match a catalog the watcher had failed to advance (#3466).
 * A floor makes "keep the toolchain current" the correct behaviour rather than
 * drift, and leaves the one guarantee worth keeping.
 *
 * The recorded config pin stops being a SECOND axis for the same reason. ADR
 * 0097 Amendment 1 §1 says every site is derived from the catalog, so a repo
 * whose recorded pin trails the catalog by one watcher PR is behind on
 * paperwork, not blind to its logs — and the check that reddened on it was
 * reporting the watcher's lateness as the operator's fault. It keeps its real
 * job: in an adopter repo, where `readCatalogToonVersion` cannot answer, the
 * recorded pin IS the floor. Here it is reported and not judged.
 */
function auditHostBinary(facts: HostBinaryFacts): { finding?: HostBinaryFinding; row: HostBinaryRow } {
  const binary = facts.name;
  const catalog = facts.catalog.version;
  const recorded = facts.recordedVersion ?? "missing";
  const observed = facts.observedVersion ?? "missing";
  // The higher of the two known floors: whichever surface is ahead states the
  // format this host must be able to read.
  const floor = facts.recordedVersion !== undefined && compareVersions(facts.recordedVersion, catalog) > 0
    ? facts.recordedVersion
    : catalog;

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

  if (facts.observedVersion === undefined) {
    return {
      finding: finding("missing", `required host binary ${binary} is missing`),
      row: { binary, catalog, recorded, observed, verdict: "error" },
    };
  }

  if (compareVersions(facts.observedVersion, floor) < 0) {
    return {
      finding: finding(
        "toolchain-drift",
        `required host binary ${binary} ${observed} is older than the floor ${floor}, so it cannot read what this workspace writes`,
      ),
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
