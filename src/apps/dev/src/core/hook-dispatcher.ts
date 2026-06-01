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
  pre_merge: "abort",
  post_merge: "continue",
  on_attempt_error: "continue",
  on_idle: "continue",
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
  /** The documented RED_AFK_* env passed to every command in this point. */
  env?: Record<string, string>;
  /** Sink for the dispatcher's log lines (defaults to a no-op). */
  log?: (message: string) => void;
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

  const env = options.env ?? {};
  const log = options.log ?? (() => {});
  const policy = HOOK_EXIT_POLICY[name];

  const executions: HookExecution[] = [];
  let ctx = context;

  for (const command of commands) {
    if (command.length === 0) continue;

    const { code, stdout } = await exec(command, env, ctx);
    // Record every execution regardless of policy outcome — the Envelope must
    // show that a non-zero exit happened, not hide it.
    executions.push({ name, command, rc: code });

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
