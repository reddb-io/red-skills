import { CANONICAL_HOOK_NAMES, type HookName } from "./hook-config.js";

/**
 * hook-dispatcher.ts — TypeScript port of the dispatch half of
 * scripts/lib/hook-dispatcher.sh (PRD #207, issues #208 / #215).
 *
 * Runs one lifecycle point's resolved hook list (from hook-config's
 * `resolveHooks`) under the interceptor contract (ADR 0026, SKILL.md
 * "Lifecycle Hooks"):
 *
 *   - each command receives the documented RED_AFK_* env and the current
 *     mutable context as JSON on stdin;
 *   - empty stdout → context unchanged;
 *   - a JSON object on stdout → AFK replaces the mutable slice with the
 *     returned value;
 *   - non-JSON stdout → a parse failure, routed through the same exit-code
 *     policy as a non-zero exit;
 *   - exit code is routed through the per-hook policy table:
 *     `pre_*` points ABORT the chain on the first non-zero exit / parse
 *     failure (and propagate the rc); every other point LOGS and continues
 *     so a broken notifier never wedges AFK.
 *
 * Commands in a list run in order; each one sees the context as mutated by
 * the previous one. A `pre_*` abort short-circuits the remaining commands.
 *
 * The dispatch is pure over an injected `HookExec`: every command runs
 * through the executor, so no real subprocess is spawned here (or in tests).
 * The structured result feeds the terminal Envelope's `data-section="hooks"`
 * block (issue #215).
 */

/**
 * Per-hook exit-code policy (HOOK_EXIT_POLICY in hook-dispatcher.sh).
 * `abort` → first non-zero exit / parse failure halts the chain and the step
 * is signalled aborted. `continue` → the failure is logged and the chain
 * proceeds with the un-mutated context.
 */
export type HookExitPolicy = "abort" | "continue";

/**
 * The per-hook exit-code policy table — matches HOOK_EXIT_POLICY in
 * scripts/lib/hook-dispatcher.sh exactly. `pre_*` points abort; `post_*`,
 * `on_idle`, and `on_*_error` log and continue.
 */
export const HOOK_EXIT_POLICY: Record<HookName, HookExitPolicy> = {
  pre_session: "abort",
  pre_pick: "abort",
  post_pick: "continue",
  pre_worktree: "abort",
  pre_attempt: "abort",
  post_attempt: "continue",
  // Feedback gate (#832). `pre_feedback` is a pre_* gate: a non-zero exit VETOES
  // the feedback run and aborts the attempt. The rest observe/mutate but never
  // wedge the gate, so they log-and-continue.
  pre_feedback: "abort",
  on_baseline_probe: "continue",
  post_feedback: "continue",
  pre_merge: "abort",
  post_merge: "continue",
  on_attempt_error: "continue",
  on_recovery_decision: "continue",
  on_blocked: "continue",
  on_reconcile: "continue",
  on_idle: "continue",
  on_heartbeat: "continue",
  post_session: "continue",
  on_session_error: "continue",
};

/**
 * The injected command executor. Receives the command string, the documented
 * RED_AFK_* env, and the current context serialized as JSON on stdin; returns
 * the process exit code and its captured stdout. All command execution in the
 * dispatcher flows through this — tests inject a fake so no real process runs.
 */
export type HookExec = (
  command: string,
  env: Record<string, string>,
  stdinJson: string,
) => Promise<{ code: number; stdout: string }>;

/** One recorded command execution, in execution order (issue #215). */
export interface HookExecution {
  /** The lifecycle point this command ran under. */
  name: HookName;
  /** The command string as registered. */
  command: string;
  /** The command's exit code (recorded regardless of policy outcome). */
  rc: number;
}

/** The structured outcome of dispatching one lifecycle point. */
export interface HookDispatchResult {
  /** The final mutated context after the chain (JSON string). */
  context: string;
  /**
   * `true` when a `pre_*` policy aborted the chain (non-zero exit or parse
   * failure). The abort halts the remaining commands and signals the caller
   * to abort the surrounding step.
   */
  aborted: boolean;
  /**
   * The rc that triggered an abort, or that the chain should propagate.
   * `0` when the chain completed without an abort. A parse failure under an
   * `abort` policy propagates rc=65 (matches hook-dispatcher.sh's `EX_DATAERR`
   * exit on non-JSON stdout).
   */
  rc: number;
  /** Every command that ran, in execution order. */
  executions: HookExecution[];
}

const HOOK_NAME_SET = new Set<string>(CANONICAL_HOOK_NAMES);

/** Thrown when dispatch is asked for a name outside the canonical set. */
export class UnknownLifecyclePointError extends Error {
  constructor(public readonly name: string) {
    super(`unknown lifecycle point '${name}'`);
    this.name = "UnknownLifecyclePointError";
  }
}

/**
 * rc that a parse failure (non-JSON stdout) propagates under an `abort`
 * policy — matches the literal `return 65` in hook-dispatcher.sh.
 */
const PARSE_FAILURE_RC = 65;

/**
 * Cheap structural JSON-object check, mirroring `_hook_is_json_object` in the
 * shell: the trimmed stdout must start with `{` and parse as an object.
 */
function isJsonObject(trimmed: string): boolean {
  if (trimmed.length === 0) return false;
  if (trimmed[0] !== "{") return false;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed);
  } catch {
    return false;
  }
}

export interface DispatchHooksOptions {
  /**
   * The base RED_AFK_* env passed to every command in this point. Per-event vars
   * derived from the mutable context are layered on top.
   */
  env?: Record<string, string>;
  /** Sink for the dispatcher's log lines (defaults to a no-op). */
  log?: (message: string) => void;
}

/**
 * Derive the documented per-event RED_AFK_* env from a hook's mutable context.
 * Irrelevant fields stay unset instead of being exported as empty strings.
 */
export function deriveHookEnv(base: Record<string, string>, contextJson: string): Record<string, string> {
  const env: Record<string, string> = { ...base };

  let parsed: unknown;
  try {
    parsed = JSON.parse(contextJson);
  } catch {
    return env;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return env;
  const ctx = parsed as Record<string, unknown>;

  const set = (key: string, value: unknown): void => {
    if (typeof value === "string") {
      if (value.length > 0) env[key] = value;
    } else if (typeof value === "number" && Number.isFinite(value)) {
      env[key] = String(value);
    }
  };
  const obj = (value: unknown): Record<string, unknown> | undefined =>
    typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;

  set("RED_AFK_ISSUE", obj(ctx.issue)?.number);
  set("RED_AFK_WORKSPACE", ctx.workspace);
  set("RED_AFK_RUNNER", ctx.runner);
  set("RED_AFK_MERGE_BASE", ctx.merge_base);

  // Per-attempt file paths — set by the orchestrator in the post_attempt context
  // so the red-heartbeat and red-envelope library hooks can write to them.
  set("RED_AFK_ITER_LOG", ctx.iter_log);
  set("RED_AFK_STATE_FILE", ctx.state_file);

  const result = obj(ctx.result);
  if (result) {
    set("RED_AFK_RESULT_STATUS", result.status);
    set("RED_AFK_RESULT_OUTCOME", result.outcome);
  }

  const error = obj(ctx.error);
  if (error) {
    set("RED_AFK_ERROR_CLASS", error.class);
    set("RED_AFK_ERROR_MESSAGE", error.message);
  }

  const mergeCommit = obj(ctx.merge_commit);
  if (mergeCommit) {
    set("RED_AFK_MERGE_COMMIT", mergeCommit.sha);
    set("RED_AFK_MERGE_SHA", mergeCommit.short);
  }

  // New checkpoints (#832). Each exposes its decision-bearing field as a flat
  // RED_AFK_* var so a plain shell hook can branch without parsing the stdin JSON.
  set("RED_AFK_RECOVERY_DECISION", ctx.decision); // on_recovery_decision (mutable)
  set("RED_AFK_RECOVERY_REASON", ctx.reason); // on_recovery_decision
  set("RED_AFK_BLOCKED_LABEL", ctx.blocked_label); // on_blocked
  set("RED_AFK_RECONCILE_OUTCOME", ctx.outcome); // on_reconcile (landed/parked/skipped)

  // Worker vitals (ADR 0065/#832): the on_heartbeat context carries the full
  // vitals object. Surface each numeric vital as RED_AFK_VITAL_<UPPER> so a
  // shell hook can alert on a threshold without parsing the JSON.
  const vitals = obj(ctx.vitals);
  if (vitals) {
    for (const [key, value] of Object.entries(vitals)) {
      if (typeof value === "number" && Number.isFinite(value)) {
        env[`RED_AFK_VITAL_${key.toUpperCase()}`] = String(value);
      }
    }
  }

  return env;
}

/**
 * Dispatch one lifecycle point's resolved command list under the interceptor
 * contract and exit-code policy. Mirrors `hook_dispatch` in
 * scripts/lib/hook-dispatcher.sh.
 *
 * @param name      the canonical lifecycle point being dispatched
 * @param commands  the resolved, ordered command list (defaults-then-user,
 *                   straight from hook-config's `resolveHooks`)
 * @param context   the current mutable context as a JSON string
 * @param exec      the injected command executor
 * @returns         the final context, abort signal, and execution list
 */
export async function dispatchHooks(
  name: HookName,
  commands: string[],
  context: string,
  exec: HookExec,
  options: DispatchHooksOptions = {},
): Promise<HookDispatchResult> {
  if (!HOOK_NAME_SET.has(name)) throw new UnknownLifecyclePointError(name);

  const env = deriveHookEnv(options.env ?? {}, context);
  const log = options.log ?? (() => {});
  const policy = HOOK_EXIT_POLICY[name];

  const executions: HookExecution[] = [];
  let ctx = context;

  for (const command of commands) {
    if (command.length === 0) continue;

    log(`[afk:hooks] ${name}: enter: ${command}`);
    const { code, stdout } = await exec(command, env, ctx);
    // Record every execution regardless of policy outcome — the Envelope must
    // show that a non-zero exit happened, not hide it.
    executions.push({ name, command, rc: code });
    log(`[afk:hooks] ${name}: exit rc=${code}: ${command}`);

    if (code !== 0) {
      if (policy === "abort") {
        log(`[afk:hooks] ${name}: command failed (rc=${code}): ${command}`);
        return { context: ctx, aborted: true, rc: code, executions };
      }
      log(`[afk:hooks] ${name}: command failed (rc=${code}), continuing: ${command}`);
      continue;
    }

    // rc=0 path: empty stdout → no mutation; JSON object → replace context.
    const trimmed = stdout.trim();
    if (trimmed.length === 0) continue;

    if (isJsonObject(trimmed)) {
      ctx = trimmed;
      continue;
    }

    // rc=0 but non-JSON stdout → parse failure, routed through the policy.
    if (policy === "abort") {
      log(`[afk:hooks] ${name}: non-JSON stdout (parse failure) from: ${command}`);
      return { context: ctx, aborted: true, rc: PARSE_FAILURE_RC, executions };
    }
    log(`[afk:hooks] ${name}: non-JSON stdout, ignoring (parse failure): ${command}`);
  }

  return { context: ctx, aborted: false, rc: 0, executions };
}
