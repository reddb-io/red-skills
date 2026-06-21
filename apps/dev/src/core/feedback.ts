// feedback — the AFK pre-merge validation runner (the merge gate of ADR 0008).
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
 * the Linux OOM killer signature) anywhere in the gate output — flips this
 * classifier to true. The detection is substring-based on purpose: it has to
 * survive pnpm's error-wrapping, multi-line output, and minor message drift.
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
  /** Scope label (`root` or the dir). `no-package` when the repo has no package. */
  label: string;
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
}

export interface RunFeedbackResult {
  /** False when any check failed — the merge gate (ADR 0008). */
  ok: boolean;
  /** Every check that ran/skipped, in `script × scope` order. */
  checks: FeedbackCheck[];
  /** The sidecar lines, one JSONL record per check, in the same order. */
  sidecar: string[];
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
 */
export async function runFeedback(exec: Exec, input: RunFeedbackInput): Promise<RunFeedbackResult> {
  const { worktree, scopes, layout, now } = input;
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
      push({ name, script, label: "no-package", status: "skipped", record });
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
        push({ name, script, label, status: "skipped", record });
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
      push({ name, script, label, status, record });
    }
  }

  return { ok: !failed, checks, sidecar };
}
