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

import { type ValidationScope } from "./validation-scope.js";

/** Result of a single executed command. Mirrors a child-process completion. */
export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Injected `pnpm` executor. Receives a full argv (incl. the `pnpm` head). */
export type Exec = (args: string[]) => Promise<ExecResult>;

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

/** The literal sidecar schema id. */
export const VALIDATION_SCHEMA = "red.afk.validation.v1" as const;

/** A check outcome. Mirrors the bash `passed | failed | skipped`. */
export type ValidationStatus = "passed" | "failed" | "skipped";

/**
 * One `red.afk.validation.v1` sidecar record. Optional fields are omitted (not
 * null) when absent, exactly like the bash `jq` builder: `command` and
 * `durationMs` are present only for checks that ran, `summary` only when set.
 */
export interface ValidationRecord {
  schema: typeof VALIDATION_SCHEMA;
  name: string;
  status: ValidationStatus;
  command?: string;
  durationMs?: number;
  summary?: string;
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
  durationMs?: number;
  summary?: string;
}): ValidationRecord {
  const record: ValidationRecord = {
    schema: VALIDATION_SCHEMA,
    name: input.name,
    status: input.status,
  };
  if (input.command !== undefined && input.command !== "") record.command = input.command;
  if (input.durationMs !== undefined) record.durationMs = input.durationMs;
  if (input.summary !== undefined && input.summary !== "") record.summary = input.summary;
  return record;
}

/** Serialize a record to its single compact JSONL line (no trailing newline). */
export function formatValidationLine(record: ValidationRecord): string {
  return JSON.stringify(record);
}

// ---------- infra vs semantic failure classification ----------

/**
 * AFK runner improvement: distinguish INFRA validation failures (the gate's
 * environment is broken — worktree add / submodule init / pnpm install / OOM /
 * ENOENT — the WORKER's code is fine) from SEMANTIC validation failures (the
 * worker's tests/typecheck/lint/build actually failed for a code reason).
 *
 * Infra failures route through the `validation-infra` recovery policy (bounded
 * retry, default cap 2) so a one-off submodule/OOM flake self-heals instead
 * of parking a green branch on every flaky day. Semantic failures stay
 * non-recoverable — the worker code really has a problem, page a human.
 *
 * The signal is in the failing check's `summary`: feedback-worktree.ts fails
 * closed on setup problems by rewriting the exec result to carry the literal
 * `feedback worktree setup failed for <branch>; validation blocked` (or the
 * `submodule init failed` / `install failed` variants) in `stderr`. A
 * `summary` containing one of those markers — or an exit-code-137 (SIGKILL,
 * the Linux OOM killer signature), or a `maxBuffer length exceeded` capture
 * overflow (a green-but-verbose suite Node killed for its OUTPUT size, not a
 * test failure) anywhere in the gate output — flips this classifier to true.
 * The detection is substring-based on purpose: it has to survive pnpm's
 * error-wrapping, multi-line output, and minor message drift.
 */
export function isInfraFeedbackFailure(feedback: RunFeedbackResult): boolean {
  if (feedback.ok) return false;
  for (const check of feedback.checks) {
    if (check.status !== "failed") continue;
    const summary = check.record.summary ?? "";
    if (
      summary.includes("feedback worktree setup failed") ||
      summary.includes("feedback worktree submodule init failed") ||
      summary.includes("feedback worktree install failed")
    ) {
      return true;
    }
    // OOM killer: pnpm or vitest parent was SIGKILLed.
    if (summary.includes("SIGKILL") || /\b137\b/.test(summary)) {
      return true;
    }
    // Output capture overflow: a green-but-verbose suite whose output exceeded
    // the exec maxBuffer ceiling. The command may have SUCCEEDED — only its
    // output was too large — so this is an environment/config problem, not a
    // worker-code failure. Route through bounded validation-infra recovery.
    if (summary.includes("maxBuffer length exceeded")) {
      return true;
    }
  }
  return false;
}

/**
 * Short summary for a finished check — the port of afk_validation_output_summary.
 * A passing check is always `command exited 0`; a failing check surfaces a
 * trailing slice of its captured output (joined to one line, capped at 1000
 * chars), or `command exited non-zero` when there is nothing to show.
 */
export function outputSummary(status: ValidationStatus, output: string): string {
  if (status === "passed") return "command exited 0";
  const trimmed = output.replace(/\n+$/, "");
  if (trimmed === "") return "command exited non-zero";
  const lines = trimmed.split("\n");
  const tail = lines.slice(-20).join(" ");
  return tail.slice(0, 1000);
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
  status: ValidationStatus;
  record: ValidationRecord;
}

export interface RunFeedbackInput {
  /** Worktree root passed through to the `pnpm -C` directory arg. */
  worktree: string;
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
   * The computed validation scope (from {@link computeValidationScope}).
   * When provided, it is recorded verbatim in {@link RunFeedbackResult} so
   * the caller (process-issue.ts) can include it in the Envelope validation
   * section — a human reading a blocked:validation park immediately sees
   * what was actually tested. Optional: absent callers behave exactly as
   * before (no scope is recorded in the result).
   */
  validationScope?: ValidationScope;
}

export interface RunFeedbackResult {
  /** False when any check failed — the merge gate (ADR 0008). */
  ok: boolean;
  /** Every check that ran/skipped, in `script × scope` order. */
  checks: FeedbackCheck[];
  /** The sidecar lines, one JSONL record per check, in the same order. */
  sidecar: string[];
  /**
   * AFK runner improvement: the set of check names that were downgraded from
   * `failed` to `skipped` because they ALSO failed on the baseline branch
   * (pre-existing failures on main, not the worker's fault). Always empty
   * when no `baselineWorktree` is supplied to `runFeedback`. Surfaced for
   * observability so the issue thread / envelope can explain why the gate
   * passed when the worker's branch showed red.
   */
  baselineDowngraded: readonly string[];
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
): Promise<Map<string, "passed" | "failed">> {
  const out = new Map<string, "passed" | "failed">();
  for (const { name, script, scope } of refs) {
    if (!layout.hasScript(scope, script)) continue;
    const dir = scopeDir(baselineWorktree, scope);
    const result = await exec(["pnpm", "-C", dir, script]);
    out.set(name, result.code === 0 ? "passed" : "failed");
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
  const checks: FeedbackCheck[] = [];
  const sidecar: string[] = [];
  let failed = false;

  const push = (check: FeedbackCheck): void => {
    checks.push(check);
    sidecar.push(formatValidationLine(check.record));
  };

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

      const dir = scopeDir(worktree, scope);
      const command = `pnpm -C ${dir} ${script}`;
      const start = now();
      const result = await exec(["pnpm", "-C", dir, script]);
      const durationMs = now() - start;
      const status: ValidationStatus = result.code === 0 ? "passed" : "failed";
      if (status === "failed") failed = true;
      const summary = outputSummary(status, `${result.stdout}${result.stderr}`);
      const record = buildValidationRecord({ name, status, command, durationMs, summary });
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
    const dir = scopeDir(worktree, ".");
    const command = `pnpm -C ${dir} typecheck`;
    const start = now();
    const result = await exec(["pnpm", "-C", dir, "typecheck"]);
    const durationMs = now() - start;
    const status: ValidationStatus = result.code === 0 ? "passed" : "failed";
    if (status === "failed") failed = true;
    const summary = outputSummary(status, `${result.stdout}${result.stderr}`);
    const record = buildValidationRecord({ name, status, command, durationMs, summary });
    push({ name, script: "typecheck", label, scope, status, record });
  }

  // AFK runner improvement: baseline probe for pre-existing failures. Only
  // triggered when the gate failed AND a baseline worktree was supplied.
  if (failed && baselineWorktree) {
    const failing = checks
      .filter((c) => c.status === "failed")
      .map((c) => ({ name: c.name, script: c.script, scope: c.scope }));
    const baselineResults = await runChecksForBaseline(exec, baselineWorktree, failing, layout, now);

    // Re-classify any check that ALSO failed on the baseline as
    // `skipped (pre-existing failure on baseline)`. Rebuild the sidecar
    // and the `failed` flag in lockstep so the downgraded check is
    // observable on the Envelope / Memory sidecar but does not block
    // the gate.
    const downgraded: string[] = [];
    for (let i = 0; i < checks.length; i += 1) {
      const check = checks[i]!;
      if (check.status !== "failed") continue;
      const baselineStatus = baselineResults.get(check.name);
      if (baselineStatus === "failed") {
        const newRecord = buildValidationRecord({
          name: check.name,
          status: "skipped",
          command: check.record.command,
          summary: "pre-existing failure on baseline",
        });
        checks[i] = { ...check, status: "skipped", record: newRecord };
        sidecar[i] = formatValidationLine(newRecord);
        downgraded.push(check.name);
      }
    }
    failed = checks.some((c) => c.status === "failed");
    return { ok: !failed, checks, sidecar, baselineDowngraded: downgraded, validationScope };
  }

  return { ok: !failed, checks, sidecar, baselineDowngraded: [], validationScope };
}
