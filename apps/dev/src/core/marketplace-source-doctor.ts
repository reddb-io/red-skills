import { encode as encodeToon } from "@reddb-io/toon";

/**
 * marketplace-source-doctor.ts — is the installed RedSkills marketplace able to
 * see a release published after install day?
 *
 * A host CLI registers a marketplace from a source, and that source is what
 * `marketplace update` re-reads forever. Registered from the installer's local
 * snapshot (`~/.red-skills/versions/<tag>`), the update flow re-reads an
 * unchanging directory: the machine is frozen at its install-day version and
 * every "update" succeeds while advancing nothing. Registered from the GitHub
 * source, the same command pulls origin and sees every future release.
 *
 * Pure and IO-free like the other `core/` doctors: the host CLI transcript is
 * injected, so the audit reads facts and never asks a machine.
 */

/** The marketplace name every RedSkills host registers. */
export const RED_SKILLS_MARKETPLACE = "red-skills";

/** The canonical GitHub source a healthy registration points at. */
export const RED_SKILLS_MARKETPLACE_REPO = "reddb-io/red-skills";

/** Host CLIs that register a RedSkills marketplace. */
export type MarketplaceHost = "claude" | "codex" | "gemini";

export type MarketplaceSourceKind =
  /** Tracks the GitHub repository; `marketplace update` pulls origin. */
  | "github"
  /** Tracks a git remote; `marketplace update` pulls that remote. */
  | "git"
  /** Tracks a local directory — the frozen-snapshot shape. */
  | "directory"
  /** The host lists no such marketplace. */
  | "absent"
  /** The transcript could not be read or did not name a source. */
  | "unknown";

export type MarketplaceSourceVerdict = "ok" | "warn" | "error";

export type MarketplaceSourceFindingKind = "frozen-directory-source" | "source-unknown";

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

/** The exact commands that repoint a frozen registration at the GitHub source. */
export function repointRecipe(host: MarketplaceHost, marketplace = RED_SKILLS_MARKETPLACE): string {
  return (
    `${host} plugin marketplace remove ${marketplace} && ` +
    `${host} plugin marketplace add ${RED_SKILLS_MARKETPLACE_REPO}`
  );
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

  if (facts.kind === "directory") {
    return {
      finding: {
        host,
        marketplace,
        kind: "frozen-directory-source",
        verdict: "error",
        reason:
          `${host} marketplace ${marketplace} is Directory-sourced (${detail}); ` +
          "the update flow re-reads that install-day snapshot and can never advance the plugins",
        remediation: repointRecipe(host, marketplace),
      },
      row: { host, marketplace, source: facts.kind, detail, verdict: "error" },
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

export interface MarketplaceSourceFixOptions {
  readonly fix: boolean;
  readonly approved: boolean;
}

export interface MarketplaceRepointResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface MarketplaceSourceFixDeps {
  /** Removes the marketplace and re-adds it from the GitHub source. */
  readonly repoint: (
    host: MarketplaceHost,
    marketplace: string,
  ) => Promise<MarketplaceRepointResult>;
}

export interface MarketplaceSourceFixReceipt {
  readonly host: MarketplaceHost;
  readonly marketplace: string;
  readonly status: "applied" | "failed" | "skipped";
  readonly reason: string;
}

/**
 * Repoint every frozen registration at the GitHub source, one confirmation each.
 *
 * A `source-unknown` finding is never "fixed": re-registering a marketplace we
 * could not read would discard whatever the operator actually configured.
 */
export async function applyMarketplaceSourceFixes(
  report: MarketplaceSourceReport,
  options: MarketplaceSourceFixOptions,
  deps: MarketplaceSourceFixDeps,
): Promise<MarketplaceSourceFixReceipt[]> {
  if (!options.fix) return [];

  const receipts: MarketplaceSourceFixReceipt[] = [];
  for (const finding of report.findings) {
    const { host, marketplace } = finding;
    if (finding.kind !== "frozen-directory-source") {
      receipts.push({ host, marketplace, status: "skipped", reason: "source could not be read" });
      continue;
    }
    if (!options.approved) {
      receipts.push({ host, marketplace, status: "skipped", reason: "approval required" });
      continue;
    }
    const result = await deps.repoint(host, marketplace);
    receipts.push(
      result.code === 0
        ? {
            host,
            marketplace,
            status: "applied",
            reason: `re-registered from ${RED_SKILLS_MARKETPLACE_REPO}`,
          }
        : { host, marketplace, status: "failed", reason: `repoint exited ${result.code}` },
    );
  }
  return receipts;
}
