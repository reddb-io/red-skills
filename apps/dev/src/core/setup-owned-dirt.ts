import { encode as encodeToon } from "@reddb-io/toon";

/**
 * setup-owned-dirt.ts — the single owner of "which dirty working-tree paths did
 * `/red-setup` write, and never commit".
 *
 * Two individually-correct rules used to brick every fresh repository (#3106).
 * The setup contract forbids `git add` on the files setup generates, so setup
 * ends by leaving the tree dirty by design; the trunk-freshness guard refuses to
 * fast-forward a dirty primary, because pending WIP is sacred (#1019). Nothing
 * closed the loop, so the first Worker died at boot with a message about git
 * ancestry that never mentioned setup.
 *
 * The reconciliation is a NAMED class, not a widened rule: dirt confined to the
 * paths setup owns is tolerated by the guard (the `--ff-only` merge itself still
 * refuses if the incoming commits would clobber one of them), dirt anywhere else
 * refuses exactly as before, and either way the evidence names the paths.
 */

/** The files `/red-setup` writes and is forbidden to `git add` (WRITE-CONTRACT.md steps 5, 8). */
export const SETUP_OWNED_FILES: readonly string[] = [".red/config.yaml", ".red/.gitignore"];

/** The trees `/red-setup` seeds scripts into, none of them `git add`ed (INTERVIEW.md hooks section). */
export const SETUP_OWNED_PREFIXES: readonly string[] = [".red/hooks/"];

/** The one spelling of the repair, so the guard, the doctor and the skill agree. */
export const SETUP_OWNED_DIRT_REMEDIATION =
  "commit the /red-setup-generated files (git add .red/config.yaml .red/.gitignore .red/hooks && git commit) or ignore them";

/** How many paths an evidence line names before it says how many it dropped. */
const EVIDENCE_PATH_LIMIT = 6;

export type SetupOwnedDirtVerdict = "ok" | "warn";

/** One dirty path, with its porcelain status code and its ownership verdict. */
export interface DirtyPath {
  readonly path: string;
  /** The two-character porcelain XY code (`" M"`, `"??"`, `"R "`, …). */
  readonly status: string;
  readonly setupOwned: boolean;
}

export interface DirtyTreeClassification {
  readonly dirty: readonly DirtyPath[];
  /** Dirty paths `/red-setup` wrote, in porcelain order. */
  readonly setupOwned: readonly string[];
  /** Every other dirty path — the operator's own work, in porcelain order. */
  readonly foreign: readonly string[];
}

export interface SetupOwnedDirtFinding {
  readonly kind: "uncommitted-setup-files";
  readonly verdict: "warn";
  readonly paths: readonly string[];
  readonly reason: string;
  readonly remediation: string;
}

export interface SetupOwnedDirtScorecardRow {
  readonly check: "setup-owned-dirt";
  readonly verdict: SetupOwnedDirtVerdict;
  readonly evidence: string;
  readonly fixHome: string;
}

export interface SetupOwnedDirtReport {
  readonly row: SetupOwnedDirtScorecardRow;
  readonly findings: readonly SetupOwnedDirtFinding[];
}

const FIX_HOME = "→ /red-setup closing report (#3106)";

/** True when `/red-setup` authored this path, so its dirt is our tooling's, not the operator's. */
export function isSetupOwnedPath(path: string): boolean {
  if (SETUP_OWNED_FILES.includes(path)) return true;
  return SETUP_OWNED_PREFIXES.some((prefix) => path.startsWith(prefix));
}

/** Strip git's quoting from a porcelain path. Setup-owned paths are ASCII, so the
 * common escapes are enough — an exotic name simply classifies as foreign dirt. */
function unquote(raw: string): string {
  if (!(raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"'))) return raw;
  return raw
    .slice(1, -1)
    .replace(/\\([\\"])/g, "$1")
    .replace(/\\n/g, "\n")
    .replace(/\\t/g, "\t");
}

/** Split one `git status --porcelain` transcript into setup-owned and foreign dirt. */
export function classifyDirtyTree(porcelain: string): DirtyTreeClassification {
  const dirty: DirtyPath[] = [];
  for (const line of porcelain.split("\n")) {
    if (line.trim() === "") continue;
    const status = line.slice(0, 2);
    let path = line.slice(3);
    // A rename reports `old -> new`; the dirt lives at the destination.
    const arrow = path.indexOf(" -> ");
    if (arrow !== -1) path = path.slice(arrow + 4);
    path = unquote(path.trim());
    if (path === "") continue;
    dirty.push({ path, status, setupOwned: isSetupOwnedPath(path) });
  }
  return {
    dirty,
    setupOwned: dirty.filter((entry) => entry.setupOwned).map((entry) => entry.path),
    foreign: dirty.filter((entry) => !entry.setupOwned).map((entry) => entry.path),
  };
}

/** Name up to {@link EVIDENCE_PATH_LIMIT} paths, then say how many were dropped —
 * a silent cap reads as "that was all of them" when it was not. */
export function renderDirtyPathList(paths: readonly string[], limit = EVIDENCE_PATH_LIMIT): string {
  if (paths.length === 0) return "none";
  const shown = paths.slice(0, limit);
  const dropped = paths.length - shown.length;
  return dropped > 0 ? `${shown.join(", ")}, +${dropped} more` : shown.join(", ");
}

/** True when the whole tree's dirt is `/red-setup`'s own uncommitted output. */
export function isSetupOwnedDirtOnly(tree: DirtyTreeClassification): boolean {
  return tree.dirty.length > 0 && tree.foreign.length === 0;
}

/**
 * The clean-tree refusal, spelled so the reader learns the cause from the line.
 * `clean-tree (3 dirty path(s))` sent an operator to git history for a state our
 * own setup authored; this names the paths and flags the ones setup wrote.
 */
export function describeCleanTreeRefusal(tree: DirtyTreeClassification): string {
  const head = `condition failed: clean-tree (${tree.dirty.length} dirty path(s): ${renderDirtyPathList(tree.dirty.map((entry) => entry.path))})`;
  if (tree.setupOwned.length === 0) return head;
  return `${head}; ${tree.setupOwned.length} written by /red-setup and never committed (${renderDirtyPathList(tree.setupOwned)}) — ${SETUP_OWNED_DIRT_REMEDIATION}`;
}

/** The evidence for a guard that PASSED over tolerated setup-owned dirt. */
export function describeToleratedSetupDirt(tree: DirtyTreeClassification): string {
  return `tolerated ${tree.setupOwned.length} /red-setup-owned dirty path(s) (${renderDirtyPathList(tree.setupOwned)})`;
}

/**
 * The red-doctor view: a fresh repo whose setup output is still uncommitted is a
 * warn, not an error — the guard now tolerates it, so nothing is broken, but the
 * operator is one `git commit` away from a tree that no longer needs the
 * tolerance at all.
 */
export function auditSetupOwnedDirt(tree: DirtyTreeClassification): SetupOwnedDirtReport {
  if (tree.setupOwned.length === 0) {
    return {
      row: {
        check: "setup-owned-dirt",
        verdict: "ok",
        evidence: "no uncommitted /red-setup output in the working tree",
        fixHome: FIX_HOME,
      },
      findings: [],
    };
  }

  return {
    row: {
      check: "setup-owned-dirt",
      verdict: "warn",
      evidence: `${tree.setupOwned.length} uncommitted /red-setup file(s): ${renderDirtyPathList(tree.setupOwned)}`,
      fixHome: FIX_HOME,
    },
    findings: [
      {
        kind: "uncommitted-setup-files",
        verdict: "warn",
        paths: tree.setupOwned,
        reason: "/red-setup wrote these files and never commits them, so the tree it leaves is dirty by contract",
        remediation: SETUP_OWNED_DIRT_REMEDIATION,
      },
    ],
  };
}

export function renderSetupOwnedDirtToon(report: SetupOwnedDirtReport): string {
  return encodeToon({
    scorecard: {
      check: report.row.check,
      verdict: report.row.verdict,
      evidence: report.row.evidence,
      fixHome: report.row.fixHome,
    },
    findings: report.findings.map((finding) => ({
      kind: finding.kind,
      verdict: finding.verdict,
      paths: finding.paths.join(" "),
    })),
  });
}
