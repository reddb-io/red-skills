import { encode as encodeToon } from "@reddb-io/toon";
import { configNamespacingProbe } from "./config-namespacing.js";
import { focalBranchProbe } from "./focal-branch.js";
import { httpsRemoteProbe } from "./https-remote.js";
import { queueVisibilityProbe } from "./queue-visibility.js";
import type {
  OperationalProbe,
  OperationalProbeContext,
  OperationalProbeFixDeps,
  OperationalProbeFixResult,
  OperationalProbeReport,
} from "./types.js";

export const OPERATIONAL_PROBES: readonly OperationalProbe[] = [
  httpsRemoteProbe,
  queueVisibilityProbe,
  focalBranchProbe,
  configNamespacingProbe,
];

export async function runOperationalProbes(
  context: OperationalProbeContext,
  probes: readonly OperationalProbe[] = OPERATIONAL_PROBES,
): Promise<OperationalProbeReport> {
  const rows = await Promise.all(probes.map((probe) => probe.run(context)));
  return {
    probes: rows,
    findings: rows.filter((row) => row.verdict === "red"),
  };
}

export async function applyOperationalProbeFixes(
  report: OperationalProbeReport,
  deps: OperationalProbeFixDeps,
  probes: readonly OperationalProbe[] = OPERATIONAL_PROBES,
): Promise<OperationalProbeFixResult[]> {
  const byId = new Map(probes.map((probe) => [probe.id, probe]));
  const results: OperationalProbeFixResult[] = [];
  for (const finding of report.findings) {
    const probe = byId.get(finding.id);
    if (!probe?.applyFix) {
      results.push({ probeId: finding.id, status: "noop", evidence: "probe has no automated fix" });
      continue;
    }
    results.push(await probe.applyFix(finding, deps));
  }
  return results;
}

export function renderOperationalProbeReportToon(report: OperationalProbeReport): string {
  return encodeToon({
    probes: report.probes.map((probe) => ({
      id: probe.id,
      name: probe.name,
      verdict: probe.verdict,
    })),
    findings: report.findings.map((finding) => ({
      id: finding.id,
      name: finding.name,
      verdict: finding.verdict,
      fix: finding.canonicalFix,
    })),
  });
}

export function formatOperationalProbeFinding(finding: OperationalProbeReport["findings"][number]): string {
  return `${finding.name}: ${finding.evidence}; fix: ${finding.canonicalFix}`;
}
