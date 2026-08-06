import { encode as encodeToon } from "@reddb-io/toon";

export type RedTaxonomyVerdict = "warn" | "error";

export type RedTaxonomyFindingKind =
  | "loose-tmp-file"
  | "unknown-tmp-lane"
  | "durable-state-in-tmp"
  | "undocumented-red-root";

export interface RedTaxonomyEntry {
  /** Repo-relative path using slash separators, e.g. `.red/tmp/workers`. */
  readonly path: string;
  readonly kind: "file" | "dir";
}

export interface RedTaxonomyFinding {
  readonly path: string;
  readonly kind: RedTaxonomyFindingKind;
  readonly verdict: RedTaxonomyVerdict;
  readonly reason: string;
  /** Canonical lane/tier where this content belongs, or the ADR extension path. */
  readonly target: string;
}

export interface RedTaxonomyReport {
  readonly findings: RedTaxonomyFinding[];
}

const DOCUMENTED_RED_ROOTS = new Set([
  "config.yaml",
  ".gitignore",
  "adr",
  "contexts",
  "agents",
  "contracts",
  "hooks",
  "memory",
  "brain",
  "wiki",
  "state",
  "tmp",
  "researches",
]);

const KNOWN_TMP_LANES = new Set([
  "workers",
  "go-workers",
  "scout-workers",
  "supervisors",
  "monitors",
  "claims",
  "waits",
  "worktrees",
  "scratch",
  "diagnostics",
  // Ephemeral rsp guards (resident wake lock) — registered by the ADR 0098
  // amendment that ended the loose rsp.wake.lock at the tmp root.
  "rsp",
  // Untracked /red-setup files the trunk now tracks, moved aside so the boot
  // fast-forward can land instead of aborting on them forever (#3155).
  "superseded-setup-dirt",
]);

const KNOWN_WORKTREE_LANES = new Set([
  "manual",
  "feedback",
  "landing",
  "rebase",
  "cascade",
  "adopt",
  "docs",
]);

const DURABLE_TMP_TARGETS = new Map<string, { target: string; owner: string }>([
  ["afk-supervisor.state.json", { target: ".red/tmp/supervisors/default/state.toon", owner: "dev/AFK supervisor" }],
  ["afk-supervisor.pid", { target: ".red/tmp/supervisors/default/afk-supervisor.pid", owner: "dev/AFK supervisor" }],
  ["afk-supervisor.stop", { target: ".red/tmp/supervisors/default/afk-supervisor.stop", owner: "dev/AFK supervisor" }],
  ["afk-supervisor.restarts.json", { target: ".red/tmp/supervisors/default/restarts.toon", owner: "dev/AFK supervisor" }],
  ["monitor-log-cursors.json", { target: ".red/tmp/supervisors/default/monitor-log-cursors.toon", owner: "dev/AFK supervisor" }],
  ["runner-circuit", { target: ".red/tmp/supervisors/default/runner-circuit", owner: "dev/AFK supervisor" }],
  ["statusline-cache.json", { target: ".red/state/statusline/statusline-cache.toon", owner: "dev/statusline" }],
  ["statusline-repo-cache.json", { target: ".red/state/statusline/statusline-repo-cache.toon", owner: "dev/statusline" }],
  ["branch-lock.yaml", { target: ".red/state/branch-lock.yaml", owner: "branch lock" }],
  ["red-skills.rdb", { target: ".red/state/red-skills.rdb", owner: "shared Repo store" }],
]);

function normalizePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+$/, "");
}

function relativeRedSegments(path: string): string[] | null {
  const normalized = normalizePath(path);
  if (normalized === ".red") return [];
  if (!normalized.startsWith(".red/")) return null;
  return normalized.slice(".red/".length).split("/").filter(Boolean);
}

function finding(
  path: string,
  kind: RedTaxonomyFindingKind,
  verdict: RedTaxonomyVerdict,
  reason: string,
  target: string,
): RedTaxonomyFinding {
  return { path, kind, verdict, reason, target };
}

export function auditRedTaxonomy(entries: readonly RedTaxonomyEntry[]): RedTaxonomyReport {
  const findings: RedTaxonomyFinding[] = [];

  for (const entry of entries) {
    const path = normalizePath(entry.path);
    const segments = relativeRedSegments(path);
    if (segments === null || segments.length === 0) continue;

    const [top, second, ...rest] = segments;
    if (top === undefined) continue;

    if (segments.length === 1 && entry.kind === "dir" && !DOCUMENTED_RED_ROOTS.has(top)) {
      findings.push(
        finding(
          path,
          "undocumented-red-root",
          "warn",
          `${path} is not documented by the ADR 0098 top-level taxonomy`,
          "extend ADR 0098 or move content into a documented .red tier",
        ),
      );
      continue;
    }

    if (top !== "tmp" || second === undefined) continue;

    if (second === "worktrees" && rest.length === 1 && entry.kind === "dir") {
      if (!KNOWN_WORKTREE_LANES.has(rest[0]!)) {
        findings.push(
          finding(
            path,
            "unknown-tmp-lane",
            "warn",
            `${path} is not a registered .red/tmp/worktrees lane`,
            "registered .red/tmp/worktrees lane (or extend ADR 0098)",
          ),
        );
      }
      continue;
    }

    if (rest.length > 0) continue;

    const durableTarget = DURABLE_TMP_TARGETS.get(second);
    if (durableTarget) {
      findings.push(
        finding(
          path,
          "durable-state-in-tmp",
          "error",
          `${path} is durable ${durableTarget.owner} state in the disposable tmp tier`,
          durableTarget.target,
        ),
      );
      continue;
    }

    if (entry.kind === "file") {
      findings.push(
        finding(
          path,
          "loose-tmp-file",
          "warn",
          `${path} is a loose file at the .red/tmp root`,
          ".red/tmp/scratch/",
        ),
      );
      continue;
    }

    if (!KNOWN_TMP_LANES.has(second)) {
      findings.push(
        finding(
          path,
          "unknown-tmp-lane",
          "warn",
          `${path} is not a registered .red/tmp lane`,
          "registered .red/tmp lane (or extend ADR 0098)",
        ),
      );
    }
  }

  findings.sort((a, b) => a.path.localeCompare(b.path) || a.kind.localeCompare(b.kind));
  return { findings };
}

export function renderRedTaxonomyReportToon(report: RedTaxonomyReport): string {
  return encodeToon({
    findings: report.findings.map((finding) => ({
      path: finding.path,
      kind: finding.kind,
      verdict: finding.verdict,
      target: finding.target,
    })),
  });
}
