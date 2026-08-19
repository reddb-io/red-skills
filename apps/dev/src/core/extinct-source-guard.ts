// extinct-source-guard — the ratchet that keeps the Fleet, the Attempt and the
// per-project supervisor extinct (issue #2795, Spec #2772, ADR 0130).
//
// ADR 0130 extinguished three nouns. The Fleet lost its reason to exist once the
// budget went host-wide and each project got exactly one demand producer; the
// Attempt was already a synonym of the Worker, so its lane, contract and
// retention rule recorded no additional fact; and Amendment 4 removed the
// per-project PROCESS by DELETION rather than rename (#2909), because
// `project_start` called it a demand producer, `project_status` answered with the
// key `supervisor:` and its command line was `__supervise` — three names for one
// process is the shape saying it has no place in the model that replaced it, and
// a fourth word would preserve the confusion. Deleting the code is the crossing.
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
//  2. THE RATCHET RUNS EVERY GATE, MID-CROSSING OR NOT. The ADR 0130 crossing
//     ran to zero, which promoted this invariant into `REPO_INVARIANT_SUITES`:
//     it runs in EVERY gate run, including a cone-scoped one that touched a
//     single unrelated package. A SECOND crossing now runs on the same ratchet
//     — ADRs 0147/0148/0149, declared in `./extinct-execution-chain.ts` — and it
//     starts at today's counts rather than at zero, because its surfaces are
//     still standing. The promotion is not undone by that: a baseline entry
//     tolerates exactly its declared count, so the check is green today and
//     reds the moment a reference is added.
//  3. PROSE IS NOT A READER. Comments explaining what was removed — including
//     this one — are the migration's own documentation, so comments are stripped
//     before matching. A reference in code or in a path/tool-name literal counts.
//  4. A NAME IS A SECOND DIMENSION. `EXTINCT_SOURCES` catches a reader reaching
//     for something removed; `EXTINCT_NAMES` catches the concept coming back as
//     VOCABULARY — a module basename or an identifier carrying an extinct noun's
//     name — even when nothing removed is read. Issue #2850 is why: the
//     supervisor's `attempt-accounting.ts` imported nothing extinct, so the
//     source dimension saw a clean file while a live module still keyed resource
//     accounting to a unit of work that no longer exists. Both dimensions fail
//     the same way, through the same baseline and the same message.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import {
  EXECUTION_CHAIN_BASELINE,
  EXECUTION_CHAIN_NAMES,
  EXECUTION_CHAIN_SOURCES,
} from "./extinct-execution-chain.js";

/** The noun an extinct source belonged to. */
export type ExtinctNoun =
  | "fleet"
  | "attempt"
  | "supervisor"
  | "alias"
  | "manual-landing"
  // ADRs 0147/0148/0149 — the execution-chain crossing, declared in `./extinct-execution-chain.ts`.
  | "dev-cli"
  | "dev-worker-body"
  | "janitor"
  | "resident"
  | "red-castle";

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
const ADR_0130_SOURCES: readonly ExtinctSource[] = [
  {
    id: "feedback-classification-hook",
    noun: "alias",
    what: "the mutable feedback classification hook and its environment channel",
    replacement:
      "the pure Verdict plus `plugins.dev.afk.validation.subsecond_failures_are_branch_fault` for the one operator escape",
    pattern: /\bon_feedback_classify\b|["']RED_AFK_FEEDBACK_CLASS["']/,
  },
  {
    id: "deprecated-status-alias",
    noun: "alias",
    what: "an expired status reader published as a separate MCP verb",
    replacement:
      "the consolidated `status { scope: worker | project | host }` intent read (ADR 0134)",
    pattern:
      /\bname\s*:\s*["'](?:worker_status|worker_vitals|monitor|host_state|host_dashboard|host_provision_check|host_unit_status)["']/,
  },
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
      "the single project lane; a stale argv is answered by `refuseFleetNaming`, never silently rescoped",
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
  {
    id: "project-supervisor-entrypoint",
    noun: "supervisor",
    what: "the per-project process — its hidden `__supervise` / `__watchdog` entrypoints and the `fleet` launcher",
    replacement:
      "the registration a project contributes: `project_start` registers with the daemon through" +
      " `runtime/redskilled-birth.ts`, and the daemon polls the tracker and births the Worker",
    pattern:
      /\b__supervise\b|\b__watchdog\b|\b(?:superviseCommand|supervisorWatchdogCommand|buildSupervisorBootSweeps|launchFleet|stopFleet|statusFleet)\b/,
  },
  {
    id: "project-supervisor-spawn",
    noun: "supervisor",
    what: "the launch path that spawned the per-project process and the watchdog that relaunched it",
    replacement:
      "`createRedskilledBirthPort(...).register(...)` — the daemon owns birth, so nothing a project" +
      " runs can put a producer on the machine that no host admitted (ADR 0130 rule 6)",
    pattern:
      /\bsupervisor-(?:spawn|entry|watchdog-spawn)(?:\.js)?\b|\bwatchdog-io(?:\.js)?\b|\b(?:spawnSupervisor|spawnSupervisorWatchdog|resolveSupervisorEntry|supervisorLaunchVersion|buildWatchdogIO|runWatchdog|teardownWedgedSupervisor)\b/,
  },
  {
    id: "project-supervisor-payload-key",
    noun: "supervisor",
    what: "the `supervisor:` key `project_status` and `monitor` answered with",
    replacement:
      "the `registration:` block — what the HOST holds for this project, with the poll it last ran" +
      " against it (`projectRegistrationStatusSchema`)",
    pattern: /\bsupervisorHealthSchema\b|\bpublishSupervisorLiveness\b/,
  },
];

/**
 * Every declared extinct source, both crossings. One list so a finding, a
 * baseline key and a failure message have one shape regardless of which ADR
 * retired the surface — a second mechanism would be a second thing to keep
 * green.
 */
export const EXTINCT_SOURCES: readonly ExtinctSource[] = [...ADR_0130_SOURCES, ...EXECUTION_CHAIN_SOURCES];

/**
 * One NAME an extinct concept owned. A source entry names an artifact a reader
 * can reach for; a name entry names the concept's own vocabulary, matched
 * against a module basename and against every identifier and path token in the
 * code. It fires on a module that reads nothing removed and merely CARRIES the
 * extinct noun — the leftover the source dimension cannot see (issue #2850).
 *
 * The pattern is scoped to the concept, never to the bare noun: `Attempt` and
 * `fleet` still appear in surviving vocabulary (an ordinary retry, the live
 * `CastleAttemptStatus` envelope attribute, the fleet heartbeat), so an entry
 * pairs the noun with what it owned. A name that must be tolerated for a while
 * goes in `EXTINCT_SOURCE_BASELINE` like any other location — one tolerance
 * mechanism, and it only ever shrinks.
 */
export interface ExtinctName {
  /** Stable slug — half of a baseline key, and the name the failure carries. */
  id: string;
  noun: ExtinctNoun;
  /** What the name used to identify, in one noun phrase. */
  what: string;
  /** The vocabulary that replaced it, named concretely enough to rename onto. */
  replacement: string;
  /** Matched against the module basename and every identifier/path token. */
  pattern: RegExp;
}

/**
 * The declared extinct-name inventory. Resource accounting is the whole content
 * for now: ADR 0130 killed the Attempt, and #2850 found its accounting module
 * still standing because nothing in the tree failed on a NAME.
 *
 * The `afk.attempt.budget.*` config keys and the `RED_AFK_ATTEMPT_*` env
 * overrides are deliberately NOT matched — they are the published operator
 * contract, and renaming a key is a breaking change of its own, not a rename.
 */
const ADR_0130_NAMES: readonly ExtinctName[] = [
  {
    id: "manual-landing-mode",
    noun: "manual-landing",
    what:
      "the per-issue mode that ran the whole pipeline, opened the PR and then held the merge behind a `landing:manual` label",
    replacement:
      "nothing inside the engine — a merge that must wait is held by the Ticket sitting `ready-for-human` (no Worker claims it) and by whoever owns the pull request. The mode decided a Ticket's fate from `is there an open PR` rather than from whether it still owed work, so a held Ticket could not be sent back for more",
    pattern: /landing[^A-Za-z]?manual|manual[^A-Za-z]?landing/i,
  },
  {
    id: "attempt-keyed-accounting",
    noun: "attempt",
    what: "resource accounting, usage and budgets named for the Attempt",
    replacement:
      "the Worker, the unit that survived — `supervisor/worker-accounting.ts` (`workerUsage`, `sampleWorkerPeakRss`) and `core/worker-budget.ts` (`WorkerUsage`, `WorkerBudgets`, `resolveWorkerBudgets`)",
    pattern: /attempt[^A-Za-z]?(?:accounting|budget|usage|spend)/i,
  },
  {
    id: "fleet-keyed-accounting",
    noun: "fleet",
    what: "resource accounting keyed to the fleet rather than to the worker whose process tree it measures",
    replacement:
      "`sampleWorkerPeakRss` — the peak belongs to the Worker, so a slot respawned onto a new worker never charges a dead worker's memory to a live one",
    // `usage` is deliberately absent here: `FLEET_USAGE` is the CLI's help text,
    // and a pattern that reds a usage STRING would teach a worker to rename the
    // wrong thing. The accounting sense is carried by the other three words.
    pattern: /fleet[^A-Za-z]?(?:accounting|budget|rss|peak[^A-Za-z]?rss)/i,
  },
  {
    id: "project-supervisor-naming",
    noun: "supervisor",
    what: "a module or symbol named for the per-project PROCESS — the thing it entered, spawned, watched or relaunched",
    replacement:
      "the registration and the daemon that drives it — `runtime/redskilled-birth.ts`" +
      " (`createRedskilledBirthPort`, `register`, `restateLaunch`), and `runtime/published-entry.ts` for" +
      " WHICH BUNDLE a Worker runs",
    // Paired with what the process OWNED, never reddening the bare noun: an
    // ordinary English "supervise" in prose is stripped before matching, and the
    // project's own lane vocabulary (`PROJECT_SUPERVISOR_LANE`,
    // `supervisorRuntimeDir`) named a DIRECTORY the process wrote to rather than
    // the process itself, so it outlives it.
    pattern: /supervis(?:e|or)[^A-Za-z]?(?:command|entry|spawn|watchdog|launch|relaunch|process)|(?:spawn|launch|relaunch)[^A-Za-z]?supervisor/i,
  },
  {
    id: "project-supervisor-tick",
    noun: "supervisor",
    what: "the per-project tick that birthed Workers and repeated project-side maintenance",
    replacement:
      "the `redskilled` daemon for Worker birth and the redskilled MCP resident's independent belts for recurring maintenance",
    pattern: /\bsuperviseTick\b/,
  },
  {
    id: "project-supervisor-loop",
    noun: "supervisor",
    what: "the per-project process loop that repeatedly drove the supervisor tick",
    replacement:
      "project registration through `runtime/redskilled-birth.ts`; the `redskilled` daemon owns the host-scoped execution loop",
    pattern: /\brunSupervisor\b/,
  },
];

/** Every declared extinct name, both crossings — the name half of `EXTINCT_SOURCES`. */
export const EXTINCT_NAMES: readonly ExtinctName[] = [...ADR_0130_NAMES, ...EXECUTION_CHAIN_NAMES];

/** What made a location a finding — a source being read, or a name being carried. */
export type ExtinctFindingKind = "source" | "module-name" | "symbol-name";

/** One reference to an extinct source, at the location that carries it. */
export interface ExtinctSourceFinding {
  /** `<source id>:<repo-relative path>` — the key the baseline declares. */
  locationKey: string;
  /** The inventory entry that fired — an `EXTINCT_SOURCES` or `EXTINCT_NAMES` id. */
  sourceId: string;
  kind: ExtinctFindingKind;
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
 * The retained locations, declared. The ADR 0130 crossing contributes NOTHING —
 * its last source cleared, which is what promoted this invariant into the normal
 * check set — and every entry belongs to the execution-chain crossing of ADRs
 * 0147/0148/0149, declared at today's counts in `./extinct-execution-chain.ts`.
 *
 * An entry may only ever be REMOVED or have its `count` LOWERED. Raising a count
 * to admit a new reference is the regression the ratchet exists to refuse, and a
 * review that sees a count go up is reading a reintroduction.
 */
export const EXTINCT_SOURCE_BASELINE: readonly ExtinctSourceBaselineEntry[] = [...EXECUTION_CHAIN_BASELINE];

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
 * The inventory modules DECLARE what is extinct; they do not read it. Both are
 * exempt, and the exemption is a CLOSED list of exact paths: every other file in
 * `apps/` and `packages/` is scanned, so it cannot be widened by moving code
 * into a friend module, and a copy of either file at any other path is a reader
 * again.
 */
export const EXTINCT_INVENTORY_PATHS: readonly string[] = [
  "apps/dev/src/core/extinct-source-guard.ts",
  "apps/dev/src/core/extinct-execution-chain.ts",
];
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
  names: readonly ExtinctName[] = EXTINCT_NAMES,
): ExtinctSourceFinding[] {
  return files
    .filter((file) => !EXTINCT_INVENTORY_PATHS.includes(file.relativePath))
    .flatMap((file) => [...collectFileFindings(file, sources), ...collectFileNameFindings(file, names)])
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
    // A name is not "read" — it is CARRIED, and a module carries it in its own
    // filename. Naming the dimension is what tells a worker whether to change an
    // import or to rename the module it is standing in.
    violations.push(
      `${finding.noun} ${FINDING_PHRASE[finding.kind]} ${finding.sourceId} at` +
        ` ${finding.relativePath}:${finding.line}:${finding.column} — \`${finding.match}\` (${finding.snippet})`,
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
  names: readonly ExtinctName[] = EXTINCT_NAMES,
): string {
  if (violations.length === 0) return "";
  const plural = violations.length === 1 ? "reference" : "references";
  const routes = [...sources, ...names]
    .filter((entry) => violations.some((violation) => violation.includes(entry.id)))
    .map((entry) => `  ${entry.id} — ${entry.what} → ${entry.replacement}`);
  return [
    `extinction ratchet (ADR 0130): ${violations.length} reintroduced ${plural} to a source ADR 0130` +
      " removed, or carrying an extinct concept's name.",
    ...violations.map((violation) => `  - ${violation}`),
    ...(routes.length > 0 ? ["Routes:", ...routes] : []),
    `Read the replacement instead. The baseline in ${EXTINCT_SOURCE_BASELINE_DECLARATION} only ever shrinks —` +
      " raising a count to admit a new reference is the regression this refuses.",
  ].join("\n");
}

/**
 * True when a crossing is over: no location of it is still declared, so the
 * ratchet is green on an empty tolerance. The ADR 0130 crossing answers `true`;
 * the execution-chain crossing answers `false` until its last count is paid.
 * PURE.
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
          kind: "source",
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

/**
 * Every extinct NAME this file carries — its own module basename first, then
 * every identifier and path token in the code. The module basename is the whole
 * point of the dimension: `attempt-accounting.ts` read nothing removed, so only
 * its filename could ever have failed it (issue #2850).
 *
 * Tokens allow `-` so one token spans a module specifier (`attempt-accounting`
 * inside `"./attempt-accounting.js"`) as well as an identifier. Dots are token
 * boundaries, which is why a dotted config key (`afk.attempt.budget.peak_rss_mb`)
 * is NOT a name being carried — it is the published operator contract.
 */
function collectFileNameFindings(
  file: ExtinctSourceFile,
  names: readonly ExtinctName[],
): ExtinctSourceFinding[] {
  const basename = moduleBasename(file.relativePath);
  const lines = stripComments(file.sourceText).split("\n");
  const findings: ExtinctSourceFinding[] = [];

  for (const name of names) {
    // A `g`-flagged pattern would carry `lastIndex` from token to token and skip
    // half of them — the silent hole that makes a ratchet decorative.
    const pattern = new RegExp(name.pattern.source, name.pattern.flags.replace("g", ""));
    const at = (kind: ExtinctFindingKind, line: number, column: number, match: string, snippet: string) => ({
      locationKey: `${name.id}:${file.relativePath}`,
      sourceId: name.id,
      kind,
      noun: name.noun,
      relativePath: file.relativePath,
      line,
      column,
      match,
      snippet,
    });
    if (pattern.test(basename)) {
      findings.push(at("module-name", 1, 1, basename, `module ${file.relativePath}`));
    }
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index]!;
      TOKEN_PATTERN.lastIndex = 0;
      for (let token = TOKEN_PATTERN.exec(line); token !== null; token = TOKEN_PATTERN.exec(line)) {
        if (!pattern.test(token[0])) continue;
        findings.push(at("symbol-name", index + 1, token.index + 1, token[0], bound(line.trim())));
      }
    }
  }
  return findings;
}

/** The module's own name — path and extension dropped, so `x/attempt-budget.ts` is `attempt-budget`. */
function moduleBasename(relativePath: string): string {
  const base = relativePath.split("/").at(-1) ?? "";
  const dot = base.indexOf(".");
  return dot > 0 ? base.slice(0, dot) : base;
}

/** One identifier or path segment. `-` is inside a token so a kebab module name is one name. */
const TOKEN_PATTERN = /[A-Za-z_$][\w$-]*/g;

/** How each dimension reads in a violation line — a source is READ, a name is CARRIED. */
const FINDING_PHRASE: Record<ExtinctFindingKind, string> = {
  source: "reader of extinct source",
  "module-name": "module named for extinct concept",
  "symbol-name": "symbol named for extinct concept",
};

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
