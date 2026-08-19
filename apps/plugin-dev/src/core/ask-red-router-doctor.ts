import { encode as encodeToon } from "@reddb-io/toon";

/**
 * ask-red-router-doctor.ts — the pure sync check between the registered dev
 * skill set and the ask-red router coverage list. The adoption doctor injects
 * observed skill names; this module never reads manifests or skill files.
 */

export type AskRedRouterVerdict = "ok" | "warn";

export type AskRedRouterFindingKind = "missing-from-router" | "stale-router-entry";

export interface AskRedRouterCoverageInput {
  readonly registeredSkills: readonly string[];
  readonly routerSkills: readonly string[];
}

export interface AskRedRouterFinding {
  readonly skill: string;
  readonly kind: AskRedRouterFindingKind;
  readonly verdict: "warn";
  readonly reason: string;
  readonly remediation: string;
}

export interface AskRedRouterRow {
  readonly skill: string;
  readonly inRegisteredSet: boolean;
  readonly inRouter: boolean;
  readonly verdict: AskRedRouterVerdict;
}

export interface AskRedRouterCoverageReport {
  readonly findings: AskRedRouterFinding[];
  readonly rows: AskRedRouterRow[];
}

const REMEDIATION = "update ask-red so the router covers the registered skill set";

function normalizeSkillName(name: string): string | null {
  const normalized = name.trim().replace(/^\/+/, "");
  return normalized.length > 0 ? normalized : null;
}

function sortedUniqueSkillNames(values: readonly string[]): string[] {
  const seen = new Set<string>();
  for (const value of values) {
    const normalized = normalizeSkillName(value);
    if (normalized) seen.add(normalized);
  }
  return [...seen].sort((a, b) => a.localeCompare(b));
}

export function auditAskRedRouterCoverage(input: AskRedRouterCoverageInput): AskRedRouterCoverageReport {
  const registered = sortedUniqueSkillNames(input.registeredSkills);
  const router = sortedUniqueSkillNames(input.routerSkills);
  const registeredSet = new Set(registered);
  const routerSet = new Set(router);
  const findings: AskRedRouterFinding[] = [];

  for (const skill of registered) {
    if (!routerSet.has(skill)) {
      findings.push({
        skill,
        kind: "missing-from-router",
        verdict: "warn",
        reason: `registered skill /${skill} is missing from ask-red`,
        remediation: REMEDIATION,
      });
    }
  }

  for (const skill of router) {
    if (!registeredSet.has(skill)) {
      findings.push({
        skill,
        kind: "stale-router-entry",
        verdict: "warn",
        reason: `ask-red routes /${skill} but that skill is not registered`,
        remediation: REMEDIATION,
      });
    }
  }

  const rows = sortedUniqueSkillNames([...registered, ...router]).map((skill) => {
    const inRegisteredSet = registeredSet.has(skill);
    const inRouter = routerSet.has(skill);
    const verdict: AskRedRouterVerdict = inRegisteredSet === inRouter ? "ok" : "warn";
    return {
      skill,
      inRegisteredSet,
      inRouter,
      verdict,
    };
  });

  return { findings, rows };
}

export function renderAskRedRouterCoverageToon(report: AskRedRouterCoverageReport): string {
  return encodeToon({
    skills: report.rows.map((row) => ({
      skill: row.skill,
      inRegisteredSet: row.inRegisteredSet,
      inRouter: row.inRouter,
      verdict: row.verdict,
    })),
    findings: report.findings.map((finding) => ({
      skill: finding.skill,
      kind: finding.kind,
      verdict: finding.verdict,
    })),
  });
}
