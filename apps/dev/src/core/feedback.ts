// feedback — the AFK pre-merge validation runner (the merge gate of ADR 0008).
// ValidationScope threading: when `validationScope` is provided in
// RunFeedbackInput it is stored verbatim in RunFeedbackResult for the caller
// (process-issue.ts) to include in the Envelope validation section.
//
// Ported from the feedback_* helpers + feedback() in afk.sh. Pure scope
// resolution and result/sidecar shaping over an injected package layout and an
// injected executor: the worker branch's changed files are mapped to the
// nearest package.json scope, then test/typecheck/lint/build run with
// `pnpm -C <dir>` for each touched package that declares the script. A missing
// script becomes an explicit skip; any failure blocks the merge.
//
// IO is fully injected — `exec` runs the real `pnpm`, `layout` answers "does
// this dir have a package.json / declare this script", and `now` supplies the
// millisecond clock — so the decision logic, the exact argv, and the
// `red.afk.validation.v1` sidecar record shape are all unit-testable against
// fixed inputs with no real pnpm ever run.
//
// Quarantine lane (issue #1035): a config-declared list of known-flaky tests
// is passed as `RunFeedbackInput.quarantine`. The gate validates the list (a
// missing issue ref produces a loud gate-failure record), emits visible
// "skipped/quarantined" sidecar records for each exclusion so exclusions are
// never silent, and appends `-- --exclude <pattern>` to the test exec argv.

import {
  QuarantineConfigError,
  quarantineExcludeArgs,
  scopeQuarantineEntries,
  validateQuarantine,
  type QuarantineEntry,
} from "./quarantine.js";

import { pendingInvariantRuns } from "./repo-invariants.js";
import { type ValidationScope } from "./validation-scope.js";
import {
  composeValidationCommand,
  isSuspectInfraFailure,
  recordedValidationCommand,
  resolveValidationTarget,
  suspectInfraSummary,
  targetMissingSummary,
  type ValidationTarget,
  type ValidationTargetKind,
} from "./validation-command.js";
import { decideVerdict, emptyEnvironmentLedger } from "./verdict.js";
import type { ValidationResourceEvidence } from "./validation-resources.js";
import { applyValidationEvidence, reconcileValidationEvidence } from "./validation-evidence.js";
import { outputSummary } from "./validation-output.js";

// Re-exported from the source rather than imported-then-exported: a binding a
// module only forwards is not a binding it USES, and the import-hygiene ratchet
// counts the difference.
export { namedFailures, outputSummary } from "./validation-output.js";

/** Result of a single executed command. Mirrors a child-process completion. */
export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
  /** Typed infrastructure evidence from the real validation process boundary. */
  infraEvidence?:
    | { kind: "stall"; wallTimeMs: number; sampleWindowMs: number; cpuDeltaMs: number }
    | { kind: "admission-timeout"; wallTimeMs: number };
  /**
   * The ABSOLUTE directory the command actually ran in, when the executor
   * rewrote the `-C` token (#3041). The AFK gate is posed with a branch NAME;
   * the feedback-worktree executor materialises it and runs the command in a
   * real checkout, and only the executor knows that path. Reporting it back is
   * what lets the record name a directory a reader can `ls` instead of the
   * branch token that made the #3027 verdict unreadable. Absent → no rewrite
   * happened and the composed command stands.
   */
  commandDir?: string;
  /**
   * Worktree setup fact that must survive into the validation sidecar. Present
   * when the undeclared compatibility fallback had to skip lifecycle scripts
   * after a hook manager refused AFK's redirected `core.hooksPath` (#3268).
   */
  setup?: string;
  /** Secret-free cgroup/process deltas observed around this validation child. */
  resources?: ValidationResourceEvidence;
}

export interface FeedbackExecOptions {
  /** Explicit validation subprocess environment. Never default to the worker shell. */
  env: NodeJS.ProcessEnv;
  /** Castle's command classification; the host adapter decides admission. */
  weight?: "light" | "heavy";
}

/** Injected `pnpm` executor. Receives a full argv (incl. the `pnpm` head). */
export type Exec = (args: string[], opts?: FeedbackExecOptions) => Promise<ExecResult>;

/**
 * Executor for an operator-declared feedback command. The command is a shell
 * string and must be passed byte-for-byte to `sh -c` by the host adapter; the
 * feedback core owns only ordering, timing, and validation records.
 */
export type FeedbackCommandExec = (input: {
  command: string;
  cwd: string;
  timeoutMs: number;
}) => Promise<ExecResult>;

/** A declared feedback command has the same bounded post-DONE lifetime as backpressure. */
export const DEFAULT_FEEDBACK_COMMAND_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Feedback validation subprocess env contract.
 *
 * Allow: stable OS/toolchain variables needed to find node/pnpm and their
 * caches/config. Deny: AFK lane/routing/model/auth variables and common secret
 * prefixes. Everything else from the worker shell is omitted, so `/afk`,
 * `/go`, and scout lanes validate the same diff under the same gate contract.
 */
export const FEEDBACK_SUBPROCESS_ENV_ALLOW_EXACT = [
  "APPDATA",
  "CI",
  "COLORTERM",
  "ComSpec",
  "COREPACK_HOME",
  "FORCE_COLOR",
  "HOME",
  "LANG",
  "LOCALAPPDATA",
  "LOGNAME",
  "NO_COLOR",
  "NPM_CONFIG_USERCONFIG",
  "PATH",
  "PATHEXT",
  "PNPM_HOME",
  "SHELL",
  "SystemRoot",
  "TEMP",
  "TERM",
  "TMP",
  "TMPDIR",
  "USER",
  "USERPROFILE",
  "TZ",
  "npm_config_userconfig",
] as const;

export const FEEDBACK_SUBPROCESS_ENV_ALLOW_PREFIX = [
  "COREPACK_",
  "LC_",
  "NPM_CONFIG_",
  "PNPM_",
  "XDG_",
  "YARN_",
  "npm_config_",
] as const;

export const FEEDBACK_SUBPROCESS_ENV_DENY_EXACT = [
  "ANTHROPIC_API_KEY",
  "GITHUB_TOKEN",
  "GH_TOKEN",
  "MINIMAX_API_KEY",
  "NODE_AUTH_TOKEN",
  "NPM_TOKEN",
  "OPENAI_API_KEY",
  "OPENROUTER_API_KEY",
  "RED_AFK_WORKERS_NAMESPACE",
] as const;

export const FEEDBACK_SUBPROCESS_ENV_DENY_PREFIX = [
  "ANTHROPIC_",
  "CLAUDE_",
  "CODEX_",
  "MINIMAX_",
  "OPENAI_",
  "OPENROUTER_",
  "RED_AFK_",
  "RED_SKILLS_",
] as const;

function envNameMatches(name: string, exact: readonly string[], prefixes: readonly string[]): boolean {
  return exact.includes(name) || prefixes.some((prefix) => name.startsWith(prefix));
}

export function buildFeedbackSubprocessEnv(
  source: NodeJS.ProcessEnv = process.env,
  budget: { nodeMaxOldSpaceMb?: number; vitestMaxWorkers?: number; turboConcurrency?: number } = {},
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(source)) {
    if (typeof value !== "string") continue;
    if (
      envNameMatches(name, FEEDBACK_SUBPROCESS_ENV_DENY_EXACT, FEEDBACK_SUBPROCESS_ENV_DENY_PREFIX)
    ) {
      continue;
    }
    if (
      envNameMatches(name, FEEDBACK_SUBPROCESS_ENV_ALLOW_EXACT, FEEDBACK_SUBPROCESS_ENV_ALLOW_PREFIX)
    ) {
      env[name] = value;
    }
  }
  if (budget.nodeMaxOldSpaceMb && budget.nodeMaxOldSpaceMb > 0) {
    const heapOpt = `--max-old-space-size=${Math.trunc(budget.nodeMaxOldSpaceMb)}`;
    env.NODE_OPTIONS = env.NODE_OPTIONS && env.NODE_OPTIONS.trim() !== ""
      ? `${env.NODE_OPTIONS} ${heapOpt}`
      : heapOpt;
  }
  if (budget.vitestMaxWorkers && budget.vitestMaxWorkers > 0) {
    env.VITEST_MAX_WORKERS = String(Math.trunc(budget.vitestMaxWorkers));
  }
  if (budget.turboConcurrency && budget.turboConcurrency > 0) {
    env.TURBO_CONCURRENCY = String(Math.trunc(budget.turboConcurrency));
  }
  return env;
}

/**
 * Injected package-layout lookup — the pure analogue of probing the worktree
 * filesystem with `[[ -f .../package.json ]]` and `jq .scripts.<name>`.
 * `scope` is a repo-relative directory, or `"."` for the root package.
 */
export interface PackageLayout {
  /** True when `<scope>/package.json` exists (the root is `"."`). */
  hasPackage: (scope: string) => boolean;
  /** True when `<scope>/package.json` declares the named script. */
  hasScript: (scope: string, script: string) => boolean;
}

/** The four validation scripts, in run order — mirrors the bash `for script in`. */
export const FEEDBACK_SCRIPTS = ["test", "typecheck", "lint", "build"] as const;
export type FeedbackScript = (typeof FEEDBACK_SCRIPTS)[number];

/** Castle owns validation meaning; redskilled only sees a generic lease request. */
export function validationWeight(scope: string, script: string): "light" | "heavy" {
  return scope === "." && (script === "test" || script === "typecheck" || script === "build")
    ? "heavy"
    : "light";
}

/** The literal sidecar schema id. */
export const VALIDATION_SCHEMA = "red.afk.validation.v1" as const;

/** A check outcome. Mirrors the bash `passed | failed | skipped`. */
export type ValidationStatus = "passed" | "failed" | "skipped";

/**
 * One `red.afk.validation.v1` sidecar record. Optional fields are omitted (not
 * null) when absent, exactly like the bash `jq` builder: `command`, `exitCode`,
 * and `durationMs` are present only for checks that ran, `summary` only when set.
 */
export interface ValidationRecord {
  schema: typeof VALIDATION_SCHEMA;
  name: string;
  status: ValidationStatus;
  command?: string;
  exitCode?: number;
  durationMs?: number;
  summary?: string;
  /** Honest account of a non-standard dependency setup used for this check. */
  setup?: string;
  /**
   * Set only on a failure that exited too fast to have run (#3041). A suite
   * command that reports a verdict in under a second reported nothing; the flag
   * says so in the record rather than leaving the operator to notice the
   * millisecond count, which is how the #3027 phantom survived a whole park.
   */
  suspectInfra?: true;
  /** The command ran, but infrastructure reaped it after observing no progress. */
  infra?: "stall" | "admission-timeout";
  /** What the host was carrying while this check ran, when it was measured. */
  resources?: ValidationResourceEvidence;
}

/**
 * The three baseline-comparison verdicts (#2380). The probe is a COMPARISON
 * instrument, never a tracker: it classifies the *branch* and nothing else.
 *
 * 1. `clean` — the branch had no failures left to attribute.
 * 2. `branch-fault` — at least one branch failure is green on the baseline, so
 *    the branch owns it. Block the branch.
 * 3. `inconclusive` — every branch failure also reproduces on the baseline, so
 *    the probe cannot attribute fault. Block the branch anyway, but as an
 *    inconclusive park (`blocked:validation`) carrying the comparison
 *    evidence — never a tracked repair issue, never a global land block.
 */
export type BaselineComparisonVerdict = "clean" | "branch-fault" | "inconclusive";

export interface BaselineDiffGateDecision {
  /** The comparison verdict for the branch. */
  verdict: BaselineComparisonVerdict;
  /** True for every verdict except `clean` — the probe never unblocks a branch. */
  shouldBlock: boolean;
  /** Failures present on the branch and absent from the baseline failing set. */
  blockingFailures: readonly string[];
  /** Failures reproduced on both branch and baseline — the inconclusive set. */
  inconclusiveFailures: readonly string[];
}

/**
 * Pure baseline-comparison predicate. A failure absent from the baseline is the
 * branch's fault; a failure reproduced on the baseline is inconclusive. Both
 * block the branch — the probe downgrades nothing and files nothing, because
 * pre-merge gating is the sole quality gate (#2380).
 */
export function decideBaselineDiffGate(
  branchFailingSet: readonly string[],
  baselineFailingSet: readonly string[],
): BaselineDiffGateDecision {
  const baselineFailures = new Set(baselineFailingSet);
  const seen = new Set<string>();
  const blockingFailures: string[] = [];
  const inconclusiveFailures: string[] = [];

  for (const failure of branchFailingSet) {
    if (seen.has(failure)) continue;
    seen.add(failure);
    if (baselineFailures.has(failure)) {
      inconclusiveFailures.push(failure);
    } else {
      blockingFailures.push(failure);
    }
  }

  // A real new failure outranks an inconclusive one: the branch is at fault
  // regardless of what else reproduces on the baseline.
  const verdict: BaselineComparisonVerdict = blockingFailures.length > 0
    ? "branch-fault"
    : inconclusiveFailures.length > 0
      ? "inconclusive"
      : "clean";

  return {
    verdict,
    shouldBlock: verdict !== "clean",
    blockingFailures,
    inconclusiveFailures,
  };
}

// ---------- pure scope resolution ----------

/** Drop a leading `./`, matching the bash `${file#./}`. */
function stripDotSlash(file: string): string {
  return file.startsWith("./") ? file.slice(2) : file;
}

/**
 * Nearest package scope for one changed file — the pure port of
 * feedback_nearest_package_scope. Walk up from the file's directory looking for
 * a `package.json`; fall back to the root package (`"."`) only when one exists.
 * Returns `undefined` when no package contains the file.
 */
export function nearestPackageScope(layout: PackageLayout, file: string): string | undefined {
  if (file === "") return undefined;
  const clean = stripDotSlash(file);

  let dir = clean.includes("/") ? clean.slice(0, clean.lastIndexOf("/")) : ".";

  while (dir !== "" && dir !== "." && dir !== "/") {
    if (layout.hasPackage(dir)) return dir;
    dir = dir.includes("/") ? dir.slice(0, dir.lastIndexOf("/")) : ".";
  }

  return layout.hasPackage(".") ? "." : undefined;
}

/**
 * Relevant package scopes for a changed-file set — the pure port of
 * feedback_relevant_scopes. Each file maps to its nearest package scope; the
 * deduped scopes are returned sorted (LC_ALL=C, i.e. byte order). When no file
 * maps to a scope but a root package exists, the root (`"."`) is the fallback —
 * the root-only-repo case.
 */
export function relevantScopes(layout: PackageLayout, changedFiles: readonly string[]): string[] {
  const seen = new Set<string>();
  for (const file of changedFiles) {
    if (file === "") continue;
    const scope = nearestPackageScope(layout, file);
    if (scope !== undefined) seen.add(scope);
  }

  if (seen.size === 0 && layout.hasPackage(".")) seen.add(".");

  // LC_ALL=C sort — byte-wise ascending, which is JS default string sort.
  return [...seen].sort();
}

/** Human label for a scope — the root package shows as `root`. */
export function scopeLabel(scope: string): string {
  return scope === "." ? "root" : scope;
}

/** Absolute directory for a scope under `worktree`, for the `pnpm -C` arg. */
export function scopeDir(worktree: string, scope: string): string {
  return scope === "." ? worktree : `${worktree}/${scope}`;
}

// ---------- pure record shaping ----------

/**
 * Build a `red.afk.validation.v1` record. Optional fields are dropped when
 * empty/undefined, matching the bash `+ (if … then {…} else {} end)` chain:
 * `command` omitted when empty, `durationMs` omitted when undefined, `summary`
 * omitted when empty. The skip records carry only `name`/`status`/`summary`.
 */
export function buildValidationRecord(input: {
  name: string;
  status: ValidationStatus;
  command?: string;
  exitCode?: number;
  durationMs?: number;
  summary?: string;
  setup?: string;
  suspectInfra?: boolean;
  infra?: "stall" | "admission-timeout";
  resources?: ValidationResourceEvidence;
}): ValidationRecord {
  const record: ValidationRecord = {
    schema: VALIDATION_SCHEMA,
    name: input.name,
    status: input.status,
  };
  if (input.command !== undefined && input.command !== "") record.command = input.command;
  if (input.exitCode !== undefined && Number.isFinite(input.exitCode)) record.exitCode = Math.trunc(input.exitCode);
  if (input.durationMs !== undefined) record.durationMs = input.durationMs;
  if (input.summary !== undefined && input.summary !== "") record.summary = input.summary;
  if (input.setup !== undefined && input.setup !== "") record.setup = input.setup;
  if (input.suspectInfra === true) record.suspectInfra = true;
  if (input.infra !== undefined) record.infra = input.infra;
  if (input.resources !== undefined) record.resources = input.resources;
  return record;
}

/**
 * Build the record for ONE executed validation command, applying the #3041
 * honesty rules in one place: the recorded command names the directory the
 * executor really ran in, and a sub-second failure is flagged `suspectInfra`
 * with the evidence spelled into its summary.
 */
function buildRanRecord(input: {
  name: string;
  status: ValidationStatus;
  command: string;
  exitCode: number;
  durationMs: number;
  output: string;
  summary: string;
  setup?: string;
  infra?: "stall" | "admission-timeout";
  resources?: ValidationResourceEvidence;
}): ValidationRecord {
  const suspect = isSuspectInfraFailure({
    status: input.status,
    durationMs: input.durationMs,
    output: input.output,
  });
  const summary = suspect
    ? suspectInfraSummary({
        command: input.command,
        exitCode: input.exitCode,
        durationMs: input.durationMs,
        summary: input.summary,
      })
    : input.summary;
  return buildValidationRecord({ ...input, summary, suspectInfra: suspect });
}

/** Serialize a record to its single compact JSONL line (no trailing newline). */
export function formatValidationLine(record: ValidationRecord): string {
  return JSON.stringify(record);
}

/**
 * The minimum a check exposes to the Verdict: status plus its validation record.
 * Feedback and backpressure both satisfy this structural shape.
 */
export interface ClassifiableCheck {
  status: ValidationStatus;
  record: ValidationRecord;
}

// ---------- orchestration ----------

/** A single completed check, surfaced to the caller alongside its sidecar record. */
export interface FeedbackCheck {
  /** `{script}:{label}` such as `test:root` or `lint:plugins/memory`. */
  name: string;
  script: FeedbackScript;
  /** Scope label (`root` or the dir). `no-package` when the repo has no package. `workspace` for the whole-workspace typecheck. */
  label: string;
  /** Real package scope (repo-relative dir, `"."` for root, `""` for no-package). Used by the baseline probe. */
  scope: string;
  /**
   * The package script actually executed, when it differs from `script` — the
   * repo-wide invariant suites run a dedicated script (`test:invariants`) while
   * still classifying as a `test` check. The baseline probe must re-run THIS
   * script, not the package's full `test`.
   */
  runScript?: string;
  status: ValidationStatus;
  record: ValidationRecord;
}

export interface RunFeedbackInput {
  /** Worktree root passed through to the `pnpm -C` directory arg. */
  worktree: string;
  /**
   * What {@link RunFeedbackInput.worktree} IS (#3041). `checkout` declares it a
   * directory — it is resolved to an absolute path and a MISSING one refuses
   * the whole gate as an infrastructure error. `branch` declares it a branch
   * name the executor materialises. Omitted → auto-detect, which can only
   * downgrade to `branch`: absent a declaration the gate has no grounds to call
   * a token a missing directory.
   */
  worktreeKind?: ValidationTargetKind;
  /** The checkout a relative worktree token anchors to. Defaults to the cwd. */
  root?: string;
  /** Injected directory probe for the target resolution. Defaults to `statSync`. */
  dirExists?: (dir: string) => boolean;
  /** Resolved relevant scopes (from {@link relevantScopes}); empty for no-package. */
  scopes: readonly string[];
  /** Package layout, for the per-scope `hasScript` probe. */
  layout: PackageLayout;
  /** Injected millisecond clock — no `Date.now()` at module scope. */
  now: () => number;
  /**
   * AFK runner improvement: when the gate fails, re-run the failing checks
   * against this baseline worktree. A check that also fails on the baseline
   * is a pre-existing flake (NOT the worker's fault) and is downgraded to
   * `skipped (pre-existing failure on baseline)` so a green branch doesn't
   * get parked as `blocked:validation` because main itself is red. The
   * baseline worktree is typically the base ref (`origin/main` or the
   * lock-pinned branch); feedback-worktree.ts materialises it on demand.
   * Optional — when absent the gate runs exactly as before (no baseline
   * probe, no slowdown, no behavior change). The probe only runs when the
   * gate FAILED, so the happy path costs nothing.
   */
  baselineWorktree?: string;
  /**
   * Config-declared test quarantine entries (issue #1035). The gate validates
   * this list before running — a missing issue ref produces a loud gate-failure
   * record (blocked:validation). Absent/empty → no quarantine, no behavior
   * change. Matching entries are excluded from the test exec argv and emitted
   * as visible `skipped` sidecar records so exclusions are never silent.
   */
  quarantine?: readonly QuarantineEntry[];
  /**
   * The computed validation scope (from {@link computeValidationScope}).
   * When provided, it is recorded verbatim in {@link RunFeedbackResult} so
   * the caller (process-issue.ts) can include it in the Envelope validation
   * section — a human reading a blocked:validation park immediately sees
   * what was actually tested. Optional: absent callers behave exactly as
   * before (no scope is recorded in the result).
   */
  validationScope?: ValidationScope;
  /**
   * Validation subprocess resource budget (#1758). Applied to every feedback
   * command and baseline probe through the sanitized env.
   */
  resourceBudget?: { nodeMaxOldSpaceMb?: number; vitestMaxWorkers?: number; turboConcurrency?: number };
  /**
   * Operator-owned replacement for the discovered test/typecheck/lint/build
   * harness (`plugins.dev.afk.feedback.commands`, #3276). `undefined` preserves
   * discovery byte-for-byte; a declared list, including `[]`, replaces it.
   */
  commands?: readonly string[];
  /** Shell executor paired with {@link RunFeedbackInput.commands}. */
  commandExec?: FeedbackCommandExec;
  /** Per-command deadline for a declared replacement. */
  commandTimeoutMs?: number;
}

export interface RunFeedbackResult {
  /** False when any check failed — the merge gate (ADR 0008). */
  ok: boolean;
  evidenceInconsistency?: string;
  /** Every check that ran/skipped, in `script × scope` order. */
  checks: FeedbackCheck[];
  /** The sidecar lines, one JSONL record per check, in the same order. */
  sidecar: string[];
  /**
   * The branch failures that also reproduced on the baseline — the
   * `inconclusive` set (#2380). These still fail the gate; they are surfaced so
   * the park comment / envelope can say *why* the verdict is inconclusive
   * rather than the branch's fault. Always empty when no `baselineWorktree`
   * is supplied to `runFeedback`.
   */
  baselineInconclusive: readonly string[];
  /**
   * True when the baseline probe actually ran. This distinguishes "the
   * comparison ran and attributed the failure" from "the happy path skipped
   * the baseline probe entirely".
   */
  baselineProbeRan?: boolean;
  /**
   * The comparison verdict for the branch, present only when the probe ran.
   * Comparison-only: it never becomes a tracked issue and never blocks landing
   * for anyone but this branch (#2380).
   */
  baselineVerdict?: BaselineComparisonVerdict;
  /**
   * Quarantine entries that were active for this gate run — the full validated
   * list from `RunFeedbackInput.quarantine`. Always empty when no quarantine
   * was configured. Surfaced for envelope builders that want to render the
   * active quarantine list separately from the per-check sidecar records.
   */
  quarantined: readonly QuarantineEntry[];
  /**
   * The computed validation scope passed to `runFeedback` via
   * {@link RunFeedbackInput.validationScope}, or `undefined` when the caller
   * did not supply one. Surfaced here so callers can include it in the
   * Envelope without carrying it separately.
   */
  validationScope?: ValidationScope;
}

/** A single check to re-run against the baseline, for the baseline probe. */
export interface BaselineCheckRef {
  /** The canonical check name — used as the map key so the probe result matches the main run. */
  name: string;
  script: FeedbackScript;
  scope: string;
  /** The script to actually execute, when it differs from `script` (see {@link FeedbackCheck.runScript}). */
  runScript?: string;
}

export interface BaselineFailureEvidence {
  check: string;
  summary: string;
  outputTail: string;
}

interface BaselineCheckResult {
  status: "passed" | "failed" | "inconclusive";
  evidence?: BaselineFailureEvidence;
  /** The baseline command did not produce a verdict the branch can influence. */
  environmentFailure?: boolean;
}

function boundedFailureOutputTail(output: string): string {
  return output.replace(/\n+$/, "").split("\n").slice(-20).join("\n").slice(-4_000);
}

/**
 * A baseline check that exited by SIGKILL (137, the usual OOM kill) or whose
 * output carries a V8 heap-exhaustion / fatal-crash signature did not produce a
 * clean test verdict — the run was killed by the environment, not by a red
 * assertion. On the resource-constrained fleet host the full-suite baseline
 * probe can OOM where CI (a fresh runner) passes, so a crash must NOT be read as
 * "main is red". Treat it as inconclusive instead.
 */
function isCrashOrOom(code: number, output: string): boolean {
  if (code === 137) return true;
  return /JavaScript heap out of memory|Reached heap limit|FATAL ERROR|out of memory|\bKilled\b/i.test(output);
}

/**
 * A baseline probe run that failed because the worktree itself could not be
 * materialised (stale detached worktree, git lock, missing ref) must never
 * claim that main is red — it is an infra failure of the probe, not a real
 * test signal. Detect the sentinel stderr the feedback worktree manager writes
 * when pathFor returns null and treat it as inconclusive (#2379).
 */
function isWorktreeSetupFailure(output: string): boolean {
  return output.includes("feedback worktree setup failed");
}

/**
 * The sidecar summary for an `inconclusive` check — the comparison evidence a
 * human needs to read the `blocked:validation` park without re-running anything.
 */
/**
 * Patterns that mean the baseline was never BUILT, not that it also failed.
 *
 * A baseline worktree that could not be created, checked out or installed
 * produces a message about a path or a ref, not about a test — and calling that
 * "also fails on the baseline" asserts a comparison that never ran.
 */
const BASELINE_UNBUILT_PATTERNS: readonly RegExp[] = [
  /\bENOENT\b/i,
  /couldn't find remote ref/i,
  /could not find remote ref/i,
  /\bunable to lock ref\b/i,
  /worktree (?:add|install) failed/i,
  /lock wait timed out/i,
  /\bEACCES\b/i,
];

/** True when the baseline never ran, so nothing was compared. PURE. */
export function baselineNeverRan(baselineSummary: string | undefined): boolean {
  const detail = baselineSummary?.trim();
  if (detail == null || detail === "") return false;
  return BASELINE_UNBUILT_PATTERNS.some((pattern) => pattern.test(detail));
}

/**
 * What the branch's record says once the baseline has been consulted.
 *
 * **"Also fails on the baseline" is a claim about a comparison, and it must not
 * be made when the comparison never happened.** A baseline worktree that could
 * not be constructed — a missing ref, a busy lock, an `ENOENT` on the path —
 * produces a message about infrastructure, and the old wording concatenated it
 * behind "also fails on the baseline", asserting a result nobody measured.
 *
 * That mattered: #3082 sat parked as broken work for hours on a record reading
 * `failed` in 146ms, with `typecheck` and `build` green, because the baseline
 * worktree for `main` did not exist. The change was complete and landed
 * unmodified once rebased.
 */
function baselineComparisonSummary(baselineSummary: string | undefined): string {
  const detail = baselineSummary?.trim();
  if (detail?.includes("baseline environment failure")) {
    return `inconclusive: ${detail}`;
  }
  if (detail && baselineNeverRan(detail)) {
    return `inconclusive: the baseline could not be built, so nothing was compared — ${detail}`;
  }
  return detail
    ? `inconclusive: also fails on the baseline — ${detail}`
    : "inconclusive: also fails on the baseline";
}

function joinCommandOutput(stdout: string, stderr: string): string {
  if (stdout === "") return stderr;
  if (stderr === "") return stdout;
  return stdout.endsWith("\n") || stderr.startsWith("\n") ? `${stdout}${stderr}` : `${stdout}\n${stderr}`;
}

/**
 * Internal: run a list of FEEDBACK_SCRIPTS over a list of scopes against a
 * concrete worktree path, using the same per-check shape `runFeedback` emits.
 * The probe reuses the same `exec`/`layout`/`now` injections so the
 * per-scope `hasScript` probe + the sidecar shape stay byte-identical to
 * the worker's run — only the worktree path (and the script/scope set) differ.
 *
 * Returns a Map keyed by the same `{script}:{label}` names `runFeedback`
 * uses, so the baseline comparison is a single `Set` membership test. A
 * check that was `skipped` on the worker's run because the script was
 * missing is NOT re-run on the baseline (it would just be skipped again)
 * and is absent from the map.
 */
async function runChecksForBaseline(
  exec: Exec,
  baselineWorktree: string,
  refs: readonly BaselineCheckRef[],
  layout: PackageLayout,
  now: () => number,
  env: NodeJS.ProcessEnv,
): Promise<Map<string, BaselineCheckResult>> {
  const out = new Map<string, BaselineCheckResult>();
  // One execution per (scope, script): several checks can share one script — the
  // repo-wide invariant suites do — and the probe already runs on the slow path.
  const executed = new Map<string, ExecResult>();
  for (const { name, script, scope, runScript } of refs) {
    const command = runScript ?? script;
    if (!layout.hasScript(scope, command)) continue;
    const dir = scopeDir(baselineWorktree, scope);
    const cacheKey = `${scope} ${command}`;
    const result = executed.get(cacheKey) ?? (await exec(["pnpm", "-C", dir, command], {
      env,
      weight: validationWeight(scope, command),
    }));
    executed.set(cacheKey, result);
    if (result.code === 0) {
      out.set(name, { status: "passed" });
      continue;
    }
    const output = joinCommandOutput(result.stdout, result.stderr);
    if (isCrashOrOom(result.code, output)) {
      // Probe-infrastructure failure ⇒ inconclusive, silently logged (#2380).
      // Main's CI is the validation authority; a local probe OOM/crash on the
      // resource-constrained fleet host must not manufacture a main-red verdict
      // CI never saw. The caller promotes this to an environment-inconclusive
      // round so lifecycle recovery reruns it for free before judging the branch.
      out.set(name, {
        status: "inconclusive",
        environmentFailure: true,
        evidence: {
          check: name,
          summary:
            `baseline environment failure: baseline probe crashed/OOM before a verdict — ` +
            outputSummary("failed", output),
          outputTail: boundedFailureOutputTail(output),
        },
      });
      continue;
    }
    if (isWorktreeSetupFailure(output)) {
      // The baseline probe's worktree materialisation failed (stale detached
      // worktree, lock, missing ref — infra, not a test result). Treat as
      // environment-inconclusive so no branch verdict can be produced from a
      // comparison that never ran. The lifecycle retries this round as INFRA.
      out.set(name, {
        status: "inconclusive",
        environmentFailure: true,
        evidence: {
          check: name,
          summary:
            `baseline environment failure: the baseline could not be built — ` +
            outputSummary("failed", output),
          outputTail: boundedFailureOutputTail(output),
        },
      });
      continue;
    }
    out.set(name, {
      status: "failed",
      evidence: {
        check: name,
        summary: outputSummary("failed", output),
        outputTail: boundedFailureOutputTail(output),
      },
    });
  }
  // `now` is part of the signature for symmetry with the main run; the
  // baseline probe is intentionally cheaper (no per-check timing emitted
  // to the sidecar) so the clock is unused. Reference it to keep tsc quiet.
  void now;
  return out;
}

/**
 * Run the four validation scripts across the resolved scopes — the port of
 * feedback(). For each `script × scope`:
 *   - the scope declares the script → run `pnpm -C <dir> <script>`, timing it
 *     with the injected clock, and emit a `passed`/`failed` record;
 *   - the script is missing → emit an explicit `skipped` record (`script missing`).
 * When there are no scopes at all (no package.json anywhere) each script emits a
 * single `{script}:no-package` skip (`no package.json`). `ok` is false if any
 * check failed, blocking the merge. Nothing here touches the filesystem or a
 * real clock — the `exec`/`now`/`layout` injections own all IO.
 *
 * AFK runner improvement: when `baselineWorktree` is provided AND the gate
 * fails, the failing checks are re-run against the baseline branch. Any
 * check that also fails on the baseline is a pre-existing flake (NOT the
 * worker's fault) and is downgraded from `failed` to `skipped` with the
 * summary `pre-existing failure on baseline`. This stops a green worker
 * branch from being parked as `blocked:validation` when main itself is red
 * (the #791/#792/#793/#794 cause: the worker's tests were 103/103 green in
 * sandcastle but the feedback gate picked up a pre-existing main failure
 * from a touched-but-untouched-by-worker file). Only the failing checks
 * are probed — the happy path costs nothing extra.
 */
export async function runFeedback(exec: Exec, input: RunFeedbackInput): Promise<RunFeedbackResult> {
  const { worktree, scopes, layout, now, baselineWorktree, validationScope } = input;
  const subprocessEnv = buildFeedbackSubprocessEnv(process.env, input.resourceBudget);
  const quarantine = input.quarantine ?? [];
  const checks: FeedbackCheck[] = [];
  const sidecar: string[] = [];
  let failed = false;

  const push = (check: FeedbackCheck): void => {
    checks.push(check);
    sidecar.push(formatValidationLine(check.record));
  };

  // Resolve the target BEFORE composing anything (#3041). A declared checkout
  // whose directory is gone refuses here: the gate would otherwise compose a
  // command against a path that resolves nowhere, exit non-zero in about a
  // millisecond, and hand that back as the branch's validation verdict.
  const target: ValidationTarget = resolveValidationTarget(worktree, {
    root: input.root ?? process.cwd(),
    ...(input.worktreeKind === undefined ? {} : { kind: input.worktreeKind }),
    ...(input.dirExists === undefined ? {} : { isDirectory: input.dirExists }),
  });
  if (target.missing) {
    const name = "validation:worktree-missing";
    const record = buildValidationRecord({
      name,
      status: "failed",
      summary: targetMissingSummary(target),
    });
    push({ name, script: "test", label: "worktree", scope: "", status: "failed", record });
    return {
      ok: false,
      checks,
      sidecar,
      baselineInconclusive: [],
      quarantined: [],
      ...(validationScope === undefined ? {} : { validationScope }),
    };
  }

  // A repository declaration owns WHAT runs. Presence, not length, is the
  // switch: `commands: []` intentionally disables local feedback, while an
  // absent declaration retains the discovered harness below byte-for-byte.
  if (input.commands !== undefined) {
    const timeoutMs = input.commandTimeoutMs ?? DEFAULT_FEEDBACK_COMMAND_TIMEOUT_MS;
    const commands = input.commands.map((command) => command.trim()).filter(Boolean);
    if (commands.length > 0 && input.commandExec === undefined) {
      const name = "feedback:executor-missing";
      const record = buildValidationRecord({
        name,
        status: "failed",
        summary: "feedback.commands is declared but no shell executor is available",
      });
      push({ name, script: "test", label: "operator", scope: "", status: "failed", record });
      return {
        ok: false,
        checks,
        sidecar,
        baselineInconclusive: [],
        quarantined: [],
        ...(validationScope === undefined ? {} : { validationScope }),
      };
    }

    for (const command of commands) {
      const name = `feedback:${command}`;
      const start = now();
      const result = await input.commandExec!({ command, cwd: target.root, timeoutMs });
      const durationMs = now() - start;
      const status: ValidationStatus = result.code === 0 ? "passed" : "failed";
      if (status === "failed") failed = true;
      const output = joinCommandOutput(result.stdout, result.stderr);
      const record = buildRanRecord({
        name,
        status,
        command,
        exitCode: result.code,
        durationMs,
        output,
        summary: outputSummary(status, output),
        setup: result.setup,
        infra: result.infraEvidence?.kind,
        resources: result.resources,
      });
      push({ name, script: "test", label: "operator", scope: "", status, record });
    }

    const evidence = reconcileValidationEvidence(failed, checks);
    return {
      ...evidence,
      baselineInconclusive: [],
      quarantined: [],
      ...(validationScope === undefined ? {} : { validationScope }),
    };
  }

  // Quarantine validation: a missing issue ref is a loud gate failure (never
  // a silent skip). Surface it as a failed sidecar record so the envelope shows
  // the misconfiguration clearly.
  try {
    validateQuarantine(quarantine);
  } catch (err) {
    if (err instanceof QuarantineConfigError) {
      const record = buildValidationRecord({
        name: "quarantine:config-error",
        status: "failed",
        summary: err.message,
      });
      const check: FeedbackCheck = {
        name: "quarantine:config-error",
        script: "test",
        label: "quarantine",
        scope: "",
        status: "failed",
        record,
      };
      push(check);
      return { ok: false, checks, sidecar, baselineInconclusive: [], quarantined: [] };
    }
    throw err;
  }

  for (const script of FEEDBACK_SCRIPTS) {
    if (scopes.length === 0) {
      const name = `${script}:no-package`;
      const record = buildValidationRecord({
        name,
        status: "skipped",
        summary: "no package.json",
      });
      push({ name, script, label: "no-package", scope: "", status: "skipped", record });
      continue;
    }

    for (const scope of scopes) {
      const label = scopeLabel(scope);
      const name = `${script}:${label}`;

      if (!layout.hasScript(scope, script)) {
        const record = buildValidationRecord({
          name,
          status: "skipped",
          summary: "script missing",
        });
        push({ name, script, label, scope, status: "skipped", record });
        continue;
      }

      // Quarantine lane: emit a visible skipped record for each entry that
      // applies to this scope × test run, then pass --exclude args so the
      // tests actually do not run. Exclusions are never silent.
      const excludeArgs = script === "test" ? quarantineExcludeArgs(quarantine, scope) : [];
      if (script === "test" && excludeArgs.length > 0) {
        for (const entry of scopeQuarantineEntries(quarantine, scope)) {
          const qName = `quarantined:${entry.pattern}`;
          const qRecord = buildValidationRecord({
            name: qName,
            status: "skipped",
            summary: `quarantined — ${entry.issue} (since ${entry.since})`,
          });
          push({ name: qName, script: "test", label, scope, status: "skipped", record: qRecord });
        }
      }

      const composed = composeValidationCommand({ target, scope, script, extraArgs: excludeArgs });
      const start = now();
      const result = await exec(composed.args, {
        env: subprocessEnv,
        weight: validationWeight(scope, script),
      });
      const durationMs = now() - start;
      const status: ValidationStatus = result.code === 0 ? "passed" : "failed";
      if (status === "failed") failed = true;
      const command = recordedValidationCommand(composed, script, excludeArgs, result.commandDir);
      const output = joinCommandOutput(result.stdout, result.stderr);
      const summary = outputSummary(status, output);
      const record = buildRanRecord({
        name,
        status,
        command,
        exitCode: result.code,
        durationMs,
        output,
        summary,
        setup: result.setup,
        infra: result.infraEvidence?.kind,
        resources: result.resources,
      });
      push({ name, script, label, scope, status, record });
    }
  }

  // Whole-workspace typecheck: run `pnpm -C <root> typecheck` once after all
  // scoped checks. This catches cross-package type breaks — a slice that
  // touches only package A but breaks package B's typecheck will pass the
  // scoped gate (B is not in scopes) but fail here. Skipped when:
  //   • the repo has no packages (scopes is empty — no-package repos);
  //   • "." is already in scopes (the scoped loop already ran typecheck:root,
  //     which executes the same workspace-wide turbo command);
  //   • the root package.json does not declare a `typecheck` script.
  if (scopes.length > 0 && !scopes.includes(".") && layout.hasScript(".", "typecheck")) {
    const name = "typecheck:workspace";
    const label = "workspace";
    const scope = ".";
    const composed = composeValidationCommand({ target, scope: ".", script: "typecheck" });
    const start = now();
    const result = await exec(composed.args, { env: subprocessEnv, weight: "heavy" });
    const durationMs = now() - start;
    const status: ValidationStatus = result.code === 0 ? "passed" : "failed";
    if (status === "failed") failed = true;
    const command = recordedValidationCommand(composed, "typecheck", [], result.commandDir);
    const output = joinCommandOutput(result.stdout, result.stderr);
    const summary = outputSummary(status, output);
    const record = buildRanRecord({
      name,
      status,
      command,
      exitCode: result.code,
      durationMs,
      output,
      summary,
      setup: result.setup,
      infra: result.infraEvidence?.kind,
        resources: result.resources,
    });
    push({ name, script: "typecheck", label, scope, status, record });
  }

  // Repo-wide invariant suites (#2762). A cone-scoped run validates the changed
  // packages only, so an invariant that spans the repo but lives in ONE package
  // (the TOON JSON file-I/O ratchet in apps/dev) never runs in the loop where the
  // agent could still satisfy it — it first fires in root CI, after the worker
  // reported DONE. Run every declared suite the cone does not already cover, and
  // emit a visible `skipped` record when the script is absent rather than
  // silently dropping the invariant.
  for (const run of pendingInvariantRuns(scopes)) {
    const label = scopeLabel(run.scope);
    // The owning package is absent → this repo does not carry the invariant at
    // all (the gate also runs against consumer repos). Nothing to say.
    if (!layout.hasPackage(run.scope)) continue;
    if (!layout.hasScript(run.scope, run.script)) {
      for (const suite of run.suites) {
        const record = buildValidationRecord({
          name: suite.name,
          status: "skipped",
          summary: `invariant suite script missing (${run.scope} has no \`${run.script}\`)`,
        });
        push({ name: suite.name, script: "test", label, scope: run.scope, status: "skipped", record });
      }
      continue;
    }
    const composed = composeValidationCommand({ target, scope: run.scope, script: run.script });
    const start = now();
    const result = await exec(composed.args, {
      env: subprocessEnv,
      weight: validationWeight(run.scope, run.script),
    });
    const durationMs = now() - start;
    const status: ValidationStatus = result.code === 0 ? "passed" : "failed";
    if (status === "failed") failed = true;
    const command = recordedValidationCommand(composed, run.script, [], result.commandDir);
    const output = joinCommandOutput(result.stdout, result.stderr);
    // One execution, one record per invariant it carries: the park names the
    // constraint a human must satisfy, not only the script that reported it.
    for (const suite of run.suites) {
      const summary =
        status === "failed"
          ? `repo-wide invariant — ${suite.why}: ${outputSummary(status, output)}`.slice(0, 1000)
          : outputSummary(status, output);
      const record = buildRanRecord({
        name: suite.name,
        status,
        command,
        exitCode: result.code,
        durationMs,
        output,
        summary,
        setup: result.setup,
        infra: result.infraEvidence?.kind,
        resources: result.resources,
      });
      push({ name: suite.name, script: "test", label, scope: run.scope, runScript: run.script, status, record });
    }
  }

  const evidence = applyValidationEvidence(failed, checks, sidecar);
  failed = evidence.failed;

  // Baseline comparison is meaningful only when Verdict sees no environment
  // refusal in the check records. Verdict remains the sole fault classifier.
  const checksFault = failed
    ? decideVerdict({
        checks,
        signature: "",
        history: { environment: emptyEnvironmentLedger(0), branchBudgetAvailable: true },
        environment: {},
      }).fault
    : undefined;
  if (failed && baselineWorktree && checksFault?.kind === "branch") {
    const failing = checks
      .filter((c) => c.status === "failed")
      .map((c) => ({ name: c.name, script: c.script, scope: c.scope, runScript: c.runScript }));
    const baselineResults = await runChecksForBaseline(exec, baselineWorktree, failing, layout, now, subprocessEnv);
    const baselineEnvironmentEvidence = [...baselineResults.values()]
      .find((result) => result.environmentFailure)?.evidence;
    // A sick comparison environment cannot acquit or accuse the branch. Mark
    // the whole round inconclusive so lifecycle routing retries it for free;
    // only a healthy baseline may produce a branch-fault verdict.
    const baselineFailing = baselineEnvironmentEvidence
      ? failing.map((check) => check.name)
      : [...baselineResults.entries()]
          .filter(([, result]) => result.status === "failed")
          .map(([name]) => name);
    const gateDecision = decideBaselineDiffGate(
      failing.map((check) => check.name),
      baselineFailing,
    );
    const inconclusive = new Set(gateDecision.inconclusiveFailures);

    // Annotate — never downgrade — a check that also failed on the baseline.
    // The check stays `failed` so the branch parks `blocked:validation`; the
    // rewritten summary carries the comparison evidence onto the sidecar so a
    // human reading the park knows the failure was not attributed to the branch.
    for (let i = 0; i < checks.length; i += 1) {
      const check = checks[i]!;
      if (check.status !== "failed") continue;
      if (!inconclusive.has(check.name)) continue;
      const evidence = baselineEnvironmentEvidence ?? baselineResults.get(check.name)?.evidence;
      const newRecord = buildValidationRecord({
        name: check.name,
        status: "failed",
        command: check.record.command,
        exitCode: check.record.exitCode,
        durationMs: check.record.durationMs,
        summary: baselineComparisonSummary(evidence?.summary),
        infra: check.record.infra,
      });
      checks[i] = { ...check, record: newRecord };
      sidecar[i] = formatValidationLine(newRecord);
    }
    failed = gateDecision.shouldBlock;
    return {
      ok: !failed, checks, sidecar,
      baselineInconclusive: gateDecision.inconclusiveFailures,
      baselineProbeRan: true, baselineVerdict: gateDecision.verdict, quarantined: quarantine,
      ...(evidence.evidenceInconsistency ? { evidenceInconsistency: evidence.evidenceInconsistency } : {}),
      validationScope,
    };
  }
  return { ok: !failed, checks, sidecar, baselineInconclusive: [], quarantined: quarantine, ...(evidence.evidenceInconsistency ? { evidenceInconsistency: evidence.evidenceInconsistency } : {}), validationScope };
}
