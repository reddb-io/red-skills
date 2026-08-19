import { encode as encodeToon } from "@reddb-io/toon";

/**
 * marketplace-source-doctor.ts — who owns this machine's RedSkills marketplace?
 *
 * red-dev acquires RedSkills and wires the host CLIs, and what it registers is a
 * **directory** source pointing at the tree it manages. That is the healthy
 * shape, so this audit never touches one: repointing a directory registration
 * at the GitHub repository — which is what this doctor used to offer, and what
 * `scripts/install.sh` used to do on every re-run — tears out red-dev's wiring
 * and installs a second owner of the same machine (#3978).
 *
 * A `github` or `git` registration is the retired standalone installer's own
 * leftover. It still resolves, so it is reported rather than reded, and its
 * cure is the bootstrap, not another registration this doctor writes.
 *
 * Pure and IO-free like the other `core/` doctors: the host CLI transcript is
 * injected, so the audit reads facts and never asks a machine.
 */

/** The marketplace name every RedSkills host registers. */
export const RED_SKILLS_MARKETPLACE = "red-skills";

/** The pinned mise spec for the bootstrap that owns acquisition and wiring. */
export const RED_DEV_BOOTSTRAP_SPEC = "red-dev@1";

/** Host CLIs that register a RedSkills marketplace. */
export type MarketplaceHost = "claude" | "codex" | "gemini";

export type MarketplaceSourceKind =
  /** Tracks the GitHub repository — the retired standalone installer's shape. */
  | "github"
  /** Tracks a git remote; `marketplace update` pulls that remote. */
  | "git"
  /** Tracks a local directory — what red-dev registers. */
  | "directory"
  /** The host lists no such marketplace. */
  | "absent"
  /** The transcript could not be read or did not name a source. */
  | "unknown";

export type MarketplaceSourceVerdict = "ok" | "warn" | "error";

export type MarketplaceSourceFindingKind = "standalone-source" | "source-unknown";

export interface MarketplaceSourceFacts {
  readonly host: MarketplaceHost;
  /** False when the CLI is not installed on this machine — never a finding. */
  readonly hostPresent: boolean;
  readonly marketplace: string;
  readonly kind: MarketplaceSourceKind;
  /** The path or `owner/repo` the host printed alongside the source. */
  readonly detail?: string;
}

export interface MarketplaceSourceFinding {
  readonly host: MarketplaceHost;
  readonly marketplace: string;
  readonly kind: MarketplaceSourceFindingKind;
  readonly verdict: Exclude<MarketplaceSourceVerdict, "ok">;
  readonly reason: string;
  readonly remediation: string;
}

export interface MarketplaceSourceRow {
  readonly host: MarketplaceHost;
  readonly marketplace: string;
  readonly source: MarketplaceSourceKind;
  readonly detail: string;
  readonly verdict: MarketplaceSourceVerdict;
}

export interface MarketplaceSourceReport {
  readonly findings: MarketplaceSourceFinding[];
  readonly rows: MarketplaceSourceRow[];
}

/**
 * The one recipe: hand the machine to the bootstrap that owns it.
 *
 * Deliberately not a `marketplace add` this doctor could run itself — the
 * registration is red-dev's to write, and a doctor that writes its own is the
 * second owner the whole change removes.
 */
export function bootstrapRecipe(): string {
  return `mise use --global ${RED_DEV_BOOTSTRAP_SPEC} && red-dev install`;
}

function normalizeSourceWord(word: string): MarketplaceSourceKind {
  switch (word.trim().toLowerCase()) {
    case "github":
      return "github";
    case "git":
      return "git";
    case "directory":
    case "local":
    case "path":
      return "directory";
    default:
      return "unknown";
  }
}

export interface ParsedMarketplaceSource {
  readonly kind: MarketplaceSourceKind;
  readonly detail?: string;
}

/**
 * Read one marketplace's source out of a `plugin marketplace list` transcript.
 *
 * The rendered shape is an entry line followed by an indented `Source: <Kind>
 * (<detail>)` line, with a selection marker on the current entry:
 *
 * ```text
 * Configured marketplaces:
 *
 *   ❯ red-skills
 *     Source: Directory (/home/…/.red-skills/current)
 * ```
 */
export function parseMarketplaceSource(
  output: string | undefined,
  marketplace: string,
): ParsedMarketplaceSource {
  // A command that could not run says nothing about the registration; that is
  // `unknown` (reported), never `absent` (a clean answer we did not earn).
  if (output === undefined) return { kind: "unknown" };

  let inEntry = false;
  for (const raw of output.split(/\r?\n/)) {
    const line = raw.replace(/^[\s❯>*•-]+/u, "").trimEnd();
    if (line.length === 0) continue;

    const source = /^Source:\s*([A-Za-z]+)\s*(?:\(([^)]*)\))?/.exec(line);
    if (source) {
      if (!inEntry) continue;
      const kind = normalizeSourceWord(source[1]!);
      const detail = source[2]?.trim();
      return detail ? { kind, detail } : { kind };
    }

    inEntry = line === marketplace;
  }

  return { kind: "absent" };
}

function auditOne(facts: MarketplaceSourceFacts): {
  finding?: MarketplaceSourceFinding;
  row: MarketplaceSourceRow;
} {
  const { host, marketplace } = facts;
  const detail = facts.detail ?? "—";

  // An uninstalled host has no registration to freeze.
  if (!facts.hostPresent) {
    return { row: { host, marketplace, source: "absent", detail: "host not installed", verdict: "ok" } };
  }

  // A directory registration is red-dev's, and red-dev is the owner. Reporting
  // it is the whole job; changing it is the defect.
  if (facts.kind === "directory") {
    return { row: { host, marketplace, source: facts.kind, detail, verdict: "ok" } };
  }

  if (facts.kind === "github" || facts.kind === "git") {
    return {
      finding: {
        host,
        marketplace,
        kind: "standalone-source",
        verdict: "warn",
        reason:
          `${host} marketplace ${marketplace} is ${facts.kind}-sourced (${detail}); ` +
          "the retired standalone installer registered it, and red-dev owns RedSkills acquisition and wiring now",
        remediation: bootstrapRecipe(),
      },
      row: { host, marketplace, source: facts.kind, detail, verdict: "warn" },
    };
  }

  if (facts.kind === "unknown") {
    return {
      finding: {
        host,
        marketplace,
        kind: "source-unknown",
        verdict: "warn",
        reason: `${host} marketplace ${marketplace} source could not be read`,
        remediation: `${host} plugin marketplace list`,
      },
      row: { host, marketplace, source: facts.kind, detail, verdict: "warn" },
    };
  }

  return { row: { host, marketplace, source: facts.kind, detail, verdict: "ok" } };
}

export function auditMarketplaceSources(
  facts: readonly MarketplaceSourceFacts[],
): MarketplaceSourceReport {
  const findings: MarketplaceSourceFinding[] = [];
  const rows: MarketplaceSourceRow[] = [];

  for (const fact of facts) {
    const result = auditOne(fact);
    rows.push(result.row);
    if (result.finding) findings.push(result.finding);
  }

  return { findings, rows };
}

export function renderMarketplaceSourceReportToon(report: MarketplaceSourceReport): string {
  return encodeToon({
    marketplaces: report.rows.map((row) => ({
      host: row.host,
      marketplace: row.marketplace,
      source: row.source,
      detail: row.detail,
      verdict: row.verdict,
    })),
    findings: report.findings.map((finding) => ({
      host: finding.host,
      marketplace: finding.marketplace,
      kind: finding.kind,
      verdict: finding.verdict,
      remediation: finding.remediation,
    })),
  });
}
