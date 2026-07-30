// extinct-source-guard — the ratchet that keeps the Fleet and the Attempt extinct
// (issue #2795, Spec #2772, ADR 0130).
//
// ADR 0130 extinguished two nouns. The Fleet lost its reason to exist once the
// budget went host-wide and each project got exactly one demand producer; the
// Attempt was already a synonym of the Worker, so its lane, contract and
// retention rule recorded no additional fact. Deleting the code is the crossing.
// Keeping it deleted is a different job: nothing in the tree fails when a later
// slice reads a fleet profile again "just to attribute a worker", and the noun
// comes back one convenience at a time.
//
// **A READER OF AN EXTINCT SOURCE IS A REGRESSION, NOT A STYLE PREFERENCE.**
// Every entry in `EXTINCT_SOURCES` names an artifact ADR 0130 removed, what it
// used to answer, and where a reader goes instead — so the failure teaches the
// route rather than only refusing the reference.
//
// This is the crossing-ratchet pattern of ADR 0125, one step further along:
//
//  1. FINDINGS ONLY DECREASE. `EXTINCT_SOURCE_BASELINE` declares the locations a
//     crossing has not cleared yet, with a count. A slice may clear a location;
//     a slice that adds a reference beyond the declared count fails, so the
//     inventory can never be rewritten to hide a reintroduction.
//  2. AN EMPTY BASELINE MEANS PROMOTED. While the crossing ran, the baseline
//     carried the retained locations and the check stayed outside the normal
//     set. The last source cleared, so the baseline is empty and the invariant
//     is declared in `REPO_INVARIANT_SUITES` — it runs in EVERY gate run,
//     including a cone-scoped one that touched a single unrelated package.
//  3. PROSE IS NOT A READER. Comments explaining what was removed — including
//     this one — are the migration's own documentation, so comments are stripped
//     before matching. A reference in code or in a path/tool-name literal counts.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

/** The noun an extinct source belonged to. */
export type ExtinctNoun = "fleet" | "attempt";

/** One artifact ADR 0130 removed, with the route that replaced it. */
export interface ExtinctSource {
  /** Stable slug — half of a baseline key, and the name the failure carries. */
  id: string;
  noun: ExtinctNoun;
  /** What a reader used to obtain here, in one noun phrase. */
  what: string;
  /** Where a reader goes instead, named concretely enough to act on. */
  replacement: string;
  /** The reference that makes a file a reader of this source. */
  pattern: RegExp;
}

/**
 * The declared extinction inventory. Each pattern names REMOVED identifiers,
 * module specifiers, lane filenames and tool names — never the surviving
 * vocabulary that merely reads similar (`CastleAttemptStatus` is a live envelope
 * attribute; `RED_AFK_FLEET_SCOPE` is the placement kill-switch of #2697; the
 * work selector outlived the fleet that owned it).
 */
export const EXTINCT_SOURCES: readonly ExtinctSource[] = [
  {
    id: "fleet-registry",
    noun: "fleet",
    what: "the named-fleet profile registry",
    replacement:
      "one demand producer per project — `project_start` / `project_status` / `project_resize` / `project_stop`, scoped by `--selector`",
    pattern:
      /\bfleet-registry(?:\.js)?\b|\b(?:FleetProfile|FleetConfigOverrides|FleetRegistryValidationError|readFleetProfile|readFleetProfiles|upsertFleetProfile|removeFleetProfile|validateFleetProfile|fleetRegistryPath|resolveFleetName|isValidFleetName|DEFAULT_FLEET_NAME)\b/,
  },
  {
    id: "fleet-registry-lane",
    noun: "fleet",
    what: "the registry lane `.red/state/castle/fleets.toonl`",
    replacement: "the project's supervisor lane (`PROJECT_SUPERVISOR_LANE`), which needs no registry to be addressed",
    pattern: /\bfleets\.toonl?\b|\bcastleFleets\b/,
  },
  {
    id: "fleet-name",
    noun: "fleet",
    what: "the fleet name — the `--fleet` flag, its `RED_AFK_FLEET` env and the lane it selected",
    replacement:
      "the single project lane; a stale argv is answered by `refuseRemovedFleetFlag` / `refuseFleetNaming`, never silently rescoped",
    pattern: /\bfleet-name(?:\.js)?\b|\b(?:FLEET_NAME_ENV|parseFleetFlag|resolveFleetFromArgs)\b|["']RED_AFK_FLEET["']/,
  },
  {
    id: "fleet-hooks",
    noun: "fleet",
    what: "the fleet-scoped hook class",
    replacement: "the castle lifecycle hooks, which scope to the project rather than to a fleet",
    pattern:
      /\bfleet-hook-(?:config|dispatcher)(?:\.js)?\b|\bFLEET_HOOK_[A-Z_]+\b|\bFleetHook[A-Za-z]*\b|\b(?:isFleetHookName|resolveFleetHooks|dispatchFleetHook|deriveFleetHookEnv)\b/,
  },
  {
    id: "fleet-mcp-tools",
    noun: "fleet",
    what: "the `fleet_*` MCP tool domain",
    replacement: "the `project_*` tools that took its slot (`packages/red-castle/src/mcp/project.ts`)",
    pattern: /\bcreateFleetTools\b|\bmcp\/fleet(?:\.js)?["']|\bfleet_(?:create|edit|register|list|stop|status)\b/,
  },
  {
    id: "federated-fleet-view",
    noun: "fleet",
    what: "the cross-host aggregate, modelled on fleet heartbeats and fleet slots",
    replacement: "the daemon's host-scoped statusline payload, which aggregates across projects on one host",
    pattern:
      /\bfederated-fleet(?:-view)?(?:\.js)?\b|\bfederated_fleet_view\b|\b(?:aggregateFederatedFleetView|createFederatedFleetTools|FederatedFleetViewOutput|FederatedFleetViewOptions|FederatedFleetDependencies|HostFleetView|HostFleetWorker|HostFleetSlots|FLEET_HEARTBEAT_KIND)\b/,
  },
  {
    id: "attempt-record",
    noun: "attempt",
    what: "the attempt record — the fold of one worker × ticket × try",
    replacement:
      "the Worker itself: liveness through `runtime/liveness-anchor.ts` (the daemon owns process death), narrative through the history ledger and the tracker",
    pattern:
      /\battempt-record(?:\.js)?\b|\bCastleAttempt(?!Status\b)[A-Za-z]*\b|\bCASTLE_ATTEMPT_[A-Z_]+\b|\b(?:castleAttemptId|foldCastleAttemptRecords|readCastleAttemptEntries|readCastleAttemptRecords|createCastleAttemptRecorder|validateCastleAttemptEntry)\b/,
  },
  {
    id: "attempt-retention",
    noun: "attempt",
    what: "the attempt-keyed retention tier and reclaim plan",
    replacement: "the janitor's reclaim rule re-anchored onto the daemon's process truth (issue #2790)",
    pattern:
      /\battempt-retention(?:\.js)?\b|\bCastleReclaim[A-Za-z]*\b|\bCASTLE_RECLAIM_[A-Z_]+\b|\bCASTLE_(?:WORKSPACE|EVIDENCE|POINTER)_ARTIFACT_KINDS\b|\b(?:planCastleReclaim|castleRetentionTier|castleAttemptIsLive|classifyCastleArtifact|CastleRetentionTier|CastleArtifactClass|CastleArtifactVerdict|CastleRetainedPointers)\b/,
  },
  {
    id: "attempt-lane",
    noun: "attempt",
    what: "the attempt lane `.red/state/castle/attempts.toonl`",
    replacement: "the append-only history ledger plus the daemon's host event lane",
    pattern: /\battempts\.toonl?\b|\bcastleAttempts\b/,
  },
  {
    id: "attempt-contract",
    noun: "attempt",
    what: "the published attempt contract `red.castle.attempt.v1`",
    replacement: "the envelope and history contracts, which describe the Worker directly",
    pattern: /red\.castle\.attempt\.v1/,
  },
];

/** One reference to an extinct source, at the location that carries it. */
export interface ExtinctSourceFinding {
  /** `<source id>:<repo-relative path>` — the key the baseline declares. */
  locationKey: string;
  sourceId: string;
  noun: ExtinctNoun;
  relativePath: string;
  line: number;
  column: number;
  /** The matched text, and the line it sits on, bounded for a gate summary. */
  match: string;
  snippet: string;
}

/** A location the crossing has not cleared yet, and how much of it remains. */
export interface ExtinctSourceBaselineEntry {
  /** `<source id>:<repo-relative path>`, matching `ExtinctSourceFinding.locationKey`. */
  id: string;
  /** References tolerated at that location. One more than this is a regression. */
  count: number;
  /** One line: why it is still here and which slice clears it. */
  reason: string;
}

/**
 * The retained locations, declared. **EMPTY: the last source cleared**, which is
 * what promoted this invariant into the normal check set (see the header). An
 * entry may only ever be REMOVED or have its `count` LOWERED — raising a count
 * to admit a new reference is the regression the ratchet exists to refuse, and a
 * review that sees a count go up is reading a reintroduction.
 */
export const EXTINCT_SOURCE_BASELINE: readonly ExtinctSourceBaselineEntry[] = [];

/** Where a human edits the baseline, named in the failure message. */
export const EXTINCT_SOURCE_BASELINE_DECLARATION =
  "apps/dev/src/core/extinct-source-guard.ts (EXTINCT_SOURCE_BASELINE)";

export interface ExtinctSourceGuardReport {
  findings: readonly ExtinctSourceFinding[];
  baseline: readonly ExtinctSourceBaselineEntry[];
}

export interface ExtinctSourceFile {
  relativePath: string;
  sourceText: string;
}

const SOURCE_EXTENSIONS = new Set([".js", ".cjs", ".mjs", ".ts", ".cts", ".mts", ".tsx"]);
const SKIP_DIRS = new Set([
  ".git",
  ".red",
  ".turbo",
  "coverage",
  "dist",
  "docs",
  "generated",
  "node_modules",
  "test",
  "tests",
  "__tests__",
  "fixtures",
]);
/**
 * The inventory is the declaration of what is extinct, not a reader of it. It is
 * the ONLY self-exemption: every other file in `apps/` and `packages/` is
 * scanned, so the exemption cannot be widened by moving code into a friend.
 */
const GUARD_SELF_PATH = "apps/dev/src/core/extinct-source-guard.ts";
const SNIPPET_LIMIT = 160;

export function collectExtinctSourceReport(root: string): ExtinctSourceGuardReport {
  return { findings: collectExtinctSourceFindings(root), baseline: EXTINCT_SOURCE_BASELINE };
}

export function collectExtinctSourceFindings(root: string): ExtinctSourceFinding[] {
  return collectExtinctSourceFindingsFromFiles(readExtinctSourceFiles(root));
}

export function collectExtinctSourceFindingsFromFiles(
  files: readonly ExtinctSourceFile[],
  sources: readonly ExtinctSource[] = EXTINCT_SOURCES,
): ExtinctSourceFinding[] {
  return files
    .filter((file) => file.relativePath !== GUARD_SELF_PATH)
    .flatMap((file) => collectFileFindings(file, sources))
    .sort((a, b) => a.locationKey.localeCompare(b.locationKey) || a.line - b.line || a.column - b.column);
}

/**
 * Every violation in the report, one string per unresolved reference plus one per
 * malformed baseline entry. A finding at a location the baseline declares is
 * tolerated up to its count; the surplus is named with its file, line, column,
 * the extinct source and the route that replaced it. PURE.
 */
export function formatExtinctSourceViolations(report: ExtinctSourceGuardReport): string[] {
  const violations: string[] = [];
  const remaining = new Map<string, number>();
  const seen = new Set<string>();

  for (const entry of report.baseline) {
    if (seen.has(entry.id)) violations.push(`duplicate baseline id ${entry.id}`);
    seen.add(entry.id);
    if (!Number.isInteger(entry.count) || entry.count < 1) {
      violations.push(`baseline id ${entry.id} must declare a positive integer count`);
    }
    if (!entry.reason?.trim()) violations.push(`baseline id ${entry.id} must include a one-line reason`);
    remaining.set(entry.id, (remaining.get(entry.id) ?? 0) + Math.max(0, entry.count));
  }

  for (const finding of report.findings) {
    // A declared location absorbs its declared count and no more. Findings are
    // sorted, so the surplus named is deterministic across runs.
    const available = remaining.get(finding.locationKey) ?? 0;
    if (available > 0) {
      remaining.set(finding.locationKey, available - 1);
      continue;
    }
    violations.push(
      `${finding.noun} source ${finding.sourceId} read at ${finding.relativePath}:${finding.line}:${finding.column}` +
        ` — \`${finding.match}\` (${finding.snippet})`,
    );
  }

  // A baseline entry with no finding left is the GOAL, never a violation: the
  // crossing cleared that location. Leftover ids are cruft a slice prunes.
  return violations;
}

/**
 * The failure message the ratchet assertion carries. A bare array diff names
 * neither the offending location nor the route that replaced the source, so a
 * worker reading its own gate output would learn only that something broke. PURE.
 */
export function formatExtinctSourceFailureMessage(
  violations: readonly string[],
  sources: readonly ExtinctSource[] = EXTINCT_SOURCES,
): string {
  if (violations.length === 0) return "";
  const plural = violations.length === 1 ? "reference" : "references";
  const routes = sources
    .filter((source) => violations.some((violation) => violation.includes(source.id)))
    .map((source) => `  ${source.id} — ${source.what} → ${source.replacement}`);
  return [
    `extinction ratchet (ADR 0130): ${violations.length} reintroduced ${plural} to an extinct Fleet or Attempt source.`,
    ...violations.map((violation) => `  - ${violation}`),
    ...(routes.length > 0 ? ["Routes:", ...routes] : []),
    `Read the replacement instead. The baseline in ${EXTINCT_SOURCE_BASELINE_DECLARATION} only ever shrinks —` +
      " raising a count to admit a new reference is the regression this refuses.",
  ].join("\n");
}

/**
 * True when the crossing is over: no location is still declared, so the ratchet
 * is green on an empty tolerance and belongs in the normal check set. PURE.
 */
export function extinctSourceCrossingComplete(
  baseline: readonly ExtinctSourceBaselineEntry[] = EXTINCT_SOURCE_BASELINE,
): boolean {
  return baseline.length === 0;
}

// ---------------------------------------------------------------------------
// scanning
// ---------------------------------------------------------------------------

function collectFileFindings(
  file: ExtinctSourceFile,
  sources: readonly ExtinctSource[],
): ExtinctSourceFinding[] {
  const code = stripComments(file.sourceText);
  const lines = code.split("\n");
  const findings: ExtinctSourceFinding[] = [];

  for (const source of sources) {
    const pattern = new RegExp(source.pattern.source, `${source.pattern.flags.replace("g", "")}g`);
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index]!;
      pattern.lastIndex = 0;
      for (let match = pattern.exec(line); match !== null; match = pattern.exec(line)) {
        findings.push({
          locationKey: `${source.id}:${file.relativePath}`,
          sourceId: source.id,
          noun: source.noun,
          relativePath: file.relativePath,
          line: index + 1,
          column: match.index + 1,
          match: match[0],
          snippet: bound(line.trim()),
        });
        // A zero-width match would spin; a pattern can only match text.
        if (match[0].length === 0) break;
      }
    }
  }
  return findings;
}

function bound(text: string): string {
  return text.length <= SNIPPET_LIMIT ? text : `${text.slice(0, SNIPPET_LIMIT)}…`;
}

/**
 * Blank every comment, preserving each byte's line and column so a finding still
 * points at the real position. Prose describing the extinction — the ADR
 * reference in a header, the "what replaced it" note above a refusal — is the
 * migration's documentation and must never read as a reader of the source.
 * String and template contents are KEPT: a lane filename or a tool name lives
 * in a literal, and that is exactly a source being read.
 */
export function stripComments(text: string): string {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const char = text[i]!;
    const next = text[i + 1];
    if (char === "/" && next === "/") {
      while (i < text.length && text[i] !== "\n") {
        out += " ";
        i += 1;
      }
      continue;
    }
    if (char === "/" && next === "*") {
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) {
        out += text[i] === "\n" ? "\n" : " ";
        i += 1;
      }
      out += i < text.length ? "  " : "";
      i += 2;
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      out += char;
      i += 1;
      while (i < text.length) {
        const inner = text[i]!;
        out += inner;
        i += 1;
        if (inner === "\\") {
          if (i < text.length) {
            out += text[i];
            i += 1;
          }
          continue;
        }
        if (inner === char) break;
        // An unterminated single-quoted string ends at the newline rather than
        // swallowing the rest of the file.
        if (inner === "\n" && char !== "`") break;
      }
      continue;
    }
    out += char;
    i += 1;
  }
  return out;
}

/**
 * Every `apps/` and `packages/` source file the ratchet scans. Exported so the
 * suite can assert the scan is non-empty: a walker that reaches nothing is green
 * for the wrong reason, which is the failure mode that makes a ratchet decorative.
 */
export function readExtinctSourceFiles(root: string): ExtinctSourceFile[] {
  const files: ExtinctSourceFile[] = [];
  for (const sourceRoot of ["apps", "packages"]) {
    const absoluteRoot = join(root, sourceRoot);
    if (existsSync(absoluteRoot)) collectSourceFiles(root, absoluteRoot, files);
  }
  return files;
}

function collectSourceFiles(root: string, dir: string, out: ExtinctSourceFile[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) collectSourceFiles(root, join(dir, entry.name), out);
      continue;
    }
    if (!entry.isFile()) continue;
    const absolutePath = join(dir, entry.name);
    const relativePath = normalizePath(relative(root, absolutePath));
    if (!isGuardedSourceFile(relativePath)) continue;
    out.push({ relativePath, sourceText: readFileSync(absolutePath, "utf8") });
  }
}

function isGuardedSourceFile(relativePath: string): boolean {
  const base = relativePath.split("/").at(-1) ?? "";
  if (base.includes(".test.") || base.includes(".spec.") || base.endsWith(".d.ts")) return false;
  const dot = base.lastIndexOf(".");
  return dot >= 0 && SOURCE_EXTENSIONS.has(base.slice(dot));
}

function normalizePath(path: string): string {
  return sep === "/" ? path : path.split(sep).join("/");
}
