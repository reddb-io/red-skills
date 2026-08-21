// complexity-coverage-guard — a CRAP-style ceiling on untested complexity.
//
// A green suite is not evidence that the hard code was exercised. An agent can
// land a forty-branch function with no test that ever names it, and every gate
// stays green: the suite passes, the types check, the lint is quiet. Complexity
// alone is not the defect either — a branchy function a test drives is ordinary
// code. **Risk is complexity the tests do not reach**, which is exactly what
// Alberg's CRAP metric scores: `crap = c + c² · (1 - coverage)³`.
//
// ## The coverage proxy, stated plainly
//
// A real coverage run costs minutes; this guard runs inside EVERY cone-scoped
// gate (`invariants:complexity-coverage`), so it cannot collect coverage at all.
// The proxy it uses instead is deterministic and cheap:
//
//   **A function is COVERED when a test file in its owning package references
//   its exported name.**
//
// That is a static token match — an import, a call, a `describe` title, any
// identifier occurrence — over the package's `*.test.ts` and test-helper files.
// It is deliberately permissive and deliberately coarse:
//
//   - It over-credits: naming a function once covers all of its branches. The
//     Spec (#4129) says start permissive and ratchet later; a first cut that
//     fails half the repo is a first cut somebody turns off.
//   - It measures only EXPORTED functions. A private helper is reached through
//     the exported surface it serves, and a rule that demands tests name
//     unexported internals teaches the wrong refactor (exporting for the guard).
//   - The branch points of inner closures roll UP into the exported function
//     that holds them, so hiding forty branches inside one anonymous callback
//     does not launder the score.
//
// Replacing the proxy with real per-function line coverage is a strictly
// tightening change: the audit already takes coverage as a set of covered
// names, so a consumer that computes it properly swaps the input, not the rule.
//
// ## Scope: repo-wide today, diff-scoped for the consumer
//
// Spec #4129 frames the ceiling as "functions the diff touches". The invariants
// aggregate runs repo-wide with no diff in hand — like every one of its peers —
// so the ceiling here is repo-wide and permissive: it refuses a NEW function
// over the ceiling anywhere under `apps/` and `packages/`, and records the ones
// that predate it in a shrink-only baseline. A caller that HAS a diff (the
// publish-time gauntlet) narrows the same audit by filtering `measured` to the
// touched functions and may run it at a stricter ceiling; that refinement is
// the consumer's, not this module's.

import ts from "typescript";

/**
 * Complexity below which nothing is judged, however untested. A five-branch
 * function nobody names is not the risk this exists to refuse, and reddening it
 * would bury the forty-branch one in noise.
 */
export const COMPLEXITY_FLOOR = 10;

/**
 * Highest CRAP score a function may carry without a declared, shrinking
 * exception. This is the config the Spec asks for — one number, in code, next
 * to the rule it tunes, the way `FILE_SIZE_THRESHOLD` sits next to its ratchet.
 *
 * At 240 an UNCOVERED function may reach complexity 15 (15 + 225 = 240) and a
 * covered one is bounded only by the floor. Tuned so the tree passes today; the
 * way to tighten it is to lower this number once the baseline has drained.
 */
export const CRAP_CEILING = 240;

/** One function-like node measured out of a source file. */
export interface MeasuredFunction {
  /** Repo-relative path of the file that declares it. */
  readonly path: string;
  /** Its name — `foo`, or `Class.method` for a class member. */
  readonly name: string;
  /** 1-based line of its declaration, so a finding points somewhere. */
  readonly line: number;
  /** Cyclomatic complexity: 1 + the branch points in its subtree. */
  readonly complexity: number;
  /** True when the module surface exposes the name (a test could reach it). */
  readonly exported: boolean;
}

/** A function the ceiling refuses, or a baseline entry that no longer applies. */
export type ComplexityCoverageFindingKind = "over-ceiling" | "over-baseline" | "stale-baseline";

export interface ComplexityCoverageFinding {
  readonly path: string;
  readonly name: string;
  readonly line: number;
  readonly complexity: number;
  readonly crap: number;
  readonly kind: ComplexityCoverageFindingKind;
  readonly reason: string;
}

export interface ComplexityCoverageBaselineEntry {
  /** Repo-relative path of the declaring file. */
  readonly path: string;
  /** Function name, exactly as `MeasuredFunction.name` spells it. */
  readonly name: string;
  /** The CRAP score it carried when the ratchet landed. Shrink only. */
  readonly crap: number;
}

/**
 * Functions over the ceiling when the ratchet landed. Shrink-only, exactly like
 * the file-size baseline: lower a number as the function is decomposed or a test
 * starts naming it, drop the entry once it passes under the ceiling, and never
 * add one — a new entry is the untested complexity this exists to refuse.
 */
export const COMPLEXITY_COVERAGE_BASELINE: readonly ComplexityCoverageBaselineEntry[] = [
  { path: "apps/plugin-dev/src/core/claim-recovery.ts", name: "planClaimRecovery", crap: 462 },
  { path: "apps/plugin-dev/src/core/declared-wait-guard.ts", name: "blankCommentsAndStrings", crap: 272 },
  { path: "apps/plugin-dev/src/core/development-workflow.ts", name: "activatePrimaryBranchLockConfig", crap: 506 },
  { path: "apps/plugin-dev/src/core/merge.ts", name: "evaluateFastForwardLocalTarget", crap: 462 },
  { path: "apps/plugin-dev/src/core/skill-audit.ts", name: "runMechanicalChecks", crap: 272 },
  { path: "apps/plugin-dev/src/runtime/deadend-audit-report.ts", name: "collectDeadendAuditReport", crap: 506 },
  { path: "apps/plugin-dev/src/runtime/medic-io.ts", name: "createMedicIo", crap: 420 },
  { path: "apps/plugin-dev/src/runtime/merge-driver-io.ts", name: "foldChecks", crap: 272 },
  { path: "apps/plugin-dev/src/runtime/supervisor-fs.ts", name: "resolveIterDirInfo", crap: 272 },
  { path: "apps/plugin-dev/src/runtime/wire/boot.ts", name: "buildBootDeps", crap: 812 },
  { path: "apps/plugin-dev/src/runtime/wire/docs.ts", name: "landDocsSweep", crap: 306 },
  { path: "apps/plugin-memory/src/cli/core.ts", name: "evidenceCardInputFromFlags", crap: 462 },
  { path: "apps/plugin-memory/src/cli/core.ts", name: "runEvidence", crap: 380 },
  { path: "apps/plugin-memory/src/cli/core.ts", name: "runInbox", crap: 552 },
  { path: "apps/plugin-memory/src/cli/core.ts", name: "runInit", crap: 306 },
  { path: "apps/plugin-memory/src/cli/docs.ts", name: "runBackup", crap: 342 },
  { path: "apps/plugin-memory/src/cli/docs.ts", name: "runDocs", crap: 600 },
  { path: "apps/plugin-memory/src/cli/extract-map.ts", name: "runExtract", crap: 306 },
  { path: "apps/plugin-memory/src/cli/graph-reports.ts", name: "printStructuralImpact", crap: 552 },
  { path: "apps/plugin-memory/src/cli/improve-build.ts", name: "buildSkillImprovementProposals", crap: 650 },
  { path: "apps/plugin-memory/src/cli/improve-build.ts", name: "semanticHeadingCandidates", crap: 506 },
  { path: "apps/plugin-memory/src/cli/operations.ts", name: "runVector", crap: 756 },
  { path: "apps/plugin-memory/src/cli/recall.ts", name: "runRecall", crap: 380 },
  { path: "apps/plugin-memory/src/cli/reports.ts", name: "graphStateMetadata", crap: 342 },
  { path: "apps/plugin-memory/src/cli/reports.ts", name: "runAsk", crap: 420 },
  { path: "apps/plugin-memory/src/cli/reports.ts", name: "runWorking", crap: 650 },
  { path: "apps/plugin-memory/src/cli/status.ts", name: "contextStatusReport", crap: 870 },
  { path: "apps/plugin-memory/src/cli/status.ts", name: "runStatus", crap: 380 },
  { path: "apps/plugin-memory/src/cli/vcs-ingest.ts", name: "runIngest", crap: 306 },
  { path: "apps/plugin-memory/src/communities.ts", name: "graphStateHash", crap: 420 },
  { path: "apps/plugin-memory/src/engine/core.ts", name: "confidenceSignalsFor", crap: 306 },
  { path: "apps/plugin-memory/src/export/core.ts", name: "toEdge", crap: 342 },
  { path: "apps/plugin-memory/src/export/html.ts", name: "renderHtml", crap: 506 },
  { path: "apps/plugin-memory/src/reasoning/learning-proposals.ts", name: "buildWorkerLearningReport", crap: 1332 },
  { path: "apps/redskilled/src/acp-worker-admission.ts", name: "admitNativeAcpWorker", crap: 1056 },
  { path: "apps/redskilled/src/acp-workflow-turn.ts", name: "runAcpWorkflowTurn", crap: 380 },
  { path: "apps/redskilled/src/admission.ts", name: "isRedskilledAdmissionVerdict", crap: 702 },
  { path: "apps/redskilled/src/daemon/lifecycle.ts", name: "startRedskilledDaemon", crap: 422 },
  { path: "apps/redskilled/src/host-state.ts", name: "isRedskilledUpgradeState", crap: 702 },
  { path: "apps/redskilled/src/project-registration-queue.ts", name: "isQueuePollPlanShape", crap: 420 },
  { path: "apps/redskilled/src/protocol.ts", name: "isRedskilledReapResult", crap: 462 },
  { path: "apps/redskilled/src/resource-lease.ts", name: "isRedskilledResourceLease", crap: 306 },
  { path: "apps/redskilled/src/statusline-deaths.ts", name: "buildDeaths", crap: 272 },
  { path: "apps/redskilled/src/worker-placement.ts", name: "selectWorkerPlacementDriver", crap: 272 },
  { path: "apps/rsp/src/elision-store/helpers.ts", name: "isIndexDocument", crap: 342 },
  { path: "apps/rsp/src/elision-store/helpers.ts", name: "isStoredRecord", crap: 600 },
  { path: "apps/rsp/src/elision-store/helpers.ts", name: "residentRowToRecallHit", crap: 272 },
  { path: "apps/rsp/src/fast-boundary.ts", name: "resolveFastBoundary", crap: 600 },
  { path: "apps/rsp/src/wait/probes.ts", name: "probeRelease", crap: 380 },
  { path: "packages/github/balance.ts", name: "isGithubBalanceReport", crap: 306 },
  { path: "packages/redskilled-render/dashboard-sections.ts", name: "projectLines", crap: 306 },
  { path: "packages/redskilled-render/dashboard.ts", name: "workerCells", crap: 870 },
  { path: "packages/redskilled-render/payload.ts", name: "isRedskilledRenderPayload", crap: 272 },
  { path: "packages/worker/src/engine/monitor.ts", name: "renderCompactDashboard", crap: 342 },
  { path: "packages/worker/src/engine/monitor.ts", name: "renderCompactDashboardToon", crap: 1122 },
  { path: "packages/worker/src/engine/monitor.ts", name: "renderWorkerCompactLine", crap: 812 },
  { path: "packages/worker/src/engine/monitor.ts", name: "workerFields", crap: 306 },
  { path: "packages/worker/src/engine/work-selector.ts", name: "normalizeWorkSelector", crap: 552 },
];

/**
 * The CRAP score of a function: `c + c² · (1 - coverage)³`, Alberg's formula,
 * with the binary coverage this guard's proxy yields. Covered → the complexity
 * itself; uncovered → complexity plus its square. PURE.
 */
export function crapScore(complexity: number, covered: boolean): number {
  return covered ? complexity : complexity + complexity * complexity;
}

/** True for a node whose branch points belong to a function of its own. */
function isFunctionLike(node: ts.Node): boolean {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isConstructorDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node)
  );
}

/** True when `node` is a branch point — one more independent path through the code. */
function isBranchPoint(node: ts.Node): boolean {
  if (
    ts.isIfStatement(node) ||
    ts.isCatchClause(node) ||
    ts.isConditionalExpression(node) ||
    ts.isForStatement(node) ||
    ts.isForInStatement(node) ||
    ts.isForOfStatement(node) ||
    ts.isWhileStatement(node) ||
    ts.isDoStatement(node)
  ) {
    return true;
  }
  // A `case` with no statements falls through to the next one: same path, so it
  // is not a branch. `default:` is the fall-off path, already counted by the 1.
  if (ts.isCaseClause(node)) return node.statements.length > 0;
  if (ts.isBinaryExpression(node)) {
    const kind = node.operatorToken.kind;
    return (
      kind === ts.SyntaxKind.AmpersandAmpersandToken ||
      kind === ts.SyntaxKind.BarBarToken ||
      kind === ts.SyntaxKind.QuestionQuestionToken
    );
  }
  return false;
}

/**
 * Cyclomatic complexity of one function body: 1 + every branch point in its
 * subtree. Inner closures are NOT excluded — an anonymous callback is part of
 * the function that holds it, and excluding it would let forty branches hide
 * behind one `.map(...)`. Nested NAMED declarations are measured separately by
 * the walker and still roll up here, which is deliberate: the exported name is
 * what a test can reach, so it carries what it contains. PURE.
 */
function measureComplexity(body: ts.Node): number {
  let complexity = 1;
  const walk = (node: ts.Node): void => {
    if (isBranchPoint(node)) complexity += 1;
    node.forEachChild(walk);
  };
  body.forEachChild(walk);
  return complexity;
}

/** The function-like initializer of `const foo = ...`, when there is one. */
function functionInitializer(declaration: ts.VariableDeclaration): ts.Node | undefined {
  const initializer = declaration.initializer;
  if (!initializer) return undefined;
  return ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer)
    ? initializer
    : undefined;
}

function hasExportModifier(node: ts.Node): boolean {
  return ts.canHaveModifiers(node)
    ? (ts.getModifiers(node) ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
    : false;
}

/** Names a `export { a, b as c }` statement puts on the module surface. */
function collectNamedExports(source: ts.SourceFile): Set<string> {
  const exported = new Set<string>();
  for (const statement of source.statements) {
    if (!ts.isExportDeclaration(statement)) continue;
    const clause = statement.exportClause;
    if (!clause || !ts.isNamedExports(clause)) continue;
    for (const element of clause.elements) {
      exported.add((element.propertyName ?? element.name).text);
    }
  }
  return exported;
}

/**
 * Every named top-level function and class member in one TypeScript source,
 * with its cyclomatic complexity and whether the module surface exposes it.
 * PURE — takes text, touches no filesystem. `path` is carried through to the
 * findings and never read.
 */
export function measureFunctions(text: string, path: string): MeasuredFunction[] {
  const source = ts.createSourceFile(
    path.endsWith(".ts") ? path : `${path}.ts`,
    text,
    ts.ScriptTarget.ES2022,
    true,
  );
  const reExported = collectNamedExports(source);
  const measured: MeasuredFunction[] = [];

  const record = (name: string, node: ts.Node, exported: boolean): void => {
    measured.push({
      path,
      name,
      line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
      complexity: measureComplexity(node),
      exported: exported || reExported.has(name.split(".")[0] ?? name),
    });
  };

  for (const statement of source.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name) {
      record(statement.name.text, statement, hasExportModifier(statement));
      continue;
    }
    if (ts.isVariableStatement(statement)) {
      const exported = hasExportModifier(statement);
      for (const declaration of statement.declarationList.declarations) {
        const initializer = functionInitializer(declaration);
        if (initializer && ts.isIdentifier(declaration.name)) {
          record(declaration.name.text, initializer, exported);
        }
      }
      continue;
    }
    if (ts.isClassDeclaration(statement) && statement.name) {
      const exported = hasExportModifier(statement);
      const className = statement.name.text;
      for (const member of statement.members) {
        if (!isFunctionLike(member) || !member.name || !ts.isIdentifier(member.name)) continue;
        // A method is reachable exactly when its class is: the class name is
        // what a test imports, so the class carries the exported verdict.
        record(`${className}.${member.name.text}`, member, exported);
      }
    }
  }

  return measured;
}

/**
 * Every identifier a test file names, as a flat token set — the coverage proxy's
 * whole input. A regex over identifier-shaped runs, not an AST walk: the file is
 * read only to answer "does this test ever say this name", and a token match
 * answers it at a fraction of the cost of parsing every test in the repo. PURE.
 */
export function collectReferencedNames(text: string): Set<string> {
  const names = new Set<string>();
  for (const match of text.matchAll(/[A-Za-z_$][A-Za-z0-9_$]*/g)) names.add(match[0]);
  return names;
}

/**
 * True when the coverage proxy considers `fn` reached: some test in its owning
 * package names it. A class member counts when the tests name either the bare
 * member (`drain`) or its class (`Engine`), because a test that drives the class
 * reaches the method through it. PURE.
 */
export function isCovered(fn: MeasuredFunction, referenced: ReadonlySet<string>): boolean {
  const parts = fn.name.split(".");
  return parts.some((part) => referenced.has(part));
}

/**
 * Judge measured functions against the CRAP ceiling and the shrink-only
 * baseline. `referencedByPackage` maps a package dir (repo-relative, e.g.
 * `apps/plugin-dev`) to every identifier its tests name; `packageOf` says which
 * package owns a file. PURE.
 */
export function auditComplexityCoverage(
  measured: readonly MeasuredFunction[],
  referencedByPackage: ReadonlyMap<string, ReadonlySet<string>>,
  packageOf: (path: string) => string | undefined,
  baseline: readonly ComplexityCoverageBaselineEntry[] = COMPLEXITY_COVERAGE_BASELINE,
  ceiling: number = CRAP_CEILING,
): ComplexityCoverageFinding[] {
  const allowed = new Map(baseline.map((entry) => [`${entry.path}::${entry.name}`, entry.crap]));
  const seen = new Map<string, number>();
  const findings: ComplexityCoverageFinding[] = [];

  const ordered = [...measured].sort((a, b) =>
    a.path === b.path ? a.name.localeCompare(b.name) : a.path.localeCompare(b.path),
  );

  for (const fn of ordered) {
    // Only exported functions are measurable under the proxy: a test cannot
    // name what the module does not expose, so judging a private helper would
    // score every one of them as uncovered.
    if (!fn.exported) continue;
    if (fn.complexity < COMPLEXITY_FLOOR) continue;

    const owner = packageOf(fn.path);
    const referenced = (owner ? referencedByPackage.get(owner) : undefined) ?? new Set<string>();
    const covered = isCovered(fn, referenced);
    const crap = crapScore(fn.complexity, covered);
    const key = `${fn.path}::${fn.name}`;
    seen.set(key, Math.max(seen.get(key) ?? 0, crap));

    const budget = allowed.get(key);
    const where = `${fn.path}:${fn.line} ${fn.name}`;
    if (budget === undefined) {
      if (crap > ceiling) {
        findings.push({
          path: fn.path,
          name: fn.name,
          line: fn.line,
          complexity: fn.complexity,
          crap,
          kind: "over-ceiling",
          reason: `${where} scores CRAP ${crap} (cyclomatic complexity ${fn.complexity}, ${covered ? "covered" : "no test in its package names it"}), over the ceiling of ${ceiling}. Either name it from a test in ${owner ?? "its package"} or split the branches out — the baseline records debt that predates this ratchet, never a new function.`,
        });
      }
      continue;
    }
    if (crap > budget) {
      findings.push({
        path: fn.path,
        name: fn.name,
        line: fn.line,
        complexity: fn.complexity,
        crap,
        kind: "over-baseline",
        reason: `${where} grew from CRAP ${budget} to ${crap}. The baseline is shrink-only: lower the number as the function is tested or decomposed, never raise it.`,
      });
    }
  }

  for (const entry of baseline) {
    const key = `${entry.path}::${entry.name}`;
    const crap = seen.get(key);
    if (crap !== undefined && crap <= ceiling) {
      findings.push({
        path: entry.path,
        name: entry.name,
        line: 0,
        complexity: 0,
        crap,
        kind: "stale-baseline",
        reason: `${entry.path} ${entry.name} now scores CRAP ${crap}, under the ceiling — drop its baseline entry. Leaving it re-authorises the untested complexity the work just paid off.`,
      });
    }
  }

  return findings;
}
