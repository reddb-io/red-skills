// post-worker-format — the AFK pre-feedback mutating formatter step (#1015).
//
// Runs operator-declared shell commands AFTER the agent's commits and BEFORE
// the feedback gate. Each command executes in the worker-branch checkout; if it
// exits 0 and leaves the checkout dirty, the executor stages + commits
// (`style: <cmd>`) + pushes the delta onto the worker branch so the feedback
// gate sees a cleanly-formatted branch.
//
// Contract:
//   - commands run in declaration order;
//   - the first non-zero exit ABORTS the sequence (ok:false);
//   - a dirty checkout after a successful command triggers an auto-commit+push;
//   - an empty command list is a no-op (ok:true, committed:false).
//
// Unlike backpressure (which runs every command and gates on the union result),
// this step stops on the first failure — the formatter is a pre_*-style gate.

import { KILLED_EXIT_CODE } from "../runtime/exec.js";

/** Default per-command kill deadline for the post-worker format step (10 min). */
export const DEFAULT_POST_WORKER_FORMAT_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Injected shell executor for a single post-worker-format command. Receives
 * the command string, the worker-branch checkout root (`cwd` is the branch
 * token — the runtime materialises it to a path), and the per-command kill
 * deadline. The executor is responsible for:
 *   1. running the command via `sh -c` in the checkout;
 *   2. detecting whether the checkout became dirty after exit 0;
 *   3. if dirty: staging, committing (`style: <cmd>`), and pushing
 *      `HEAD:<branch>` to origin;
 *   4. returning `committed:true` when a commit was pushed, `false` otherwise.
 */
export type PostWorkerFormatExec = (input: {
  command: string;
  /** Branch token — passed as-is to the runtime materialise step. */
  cwd: string;
  timeoutMs: number;
}) => Promise<{ code: number; stdout: string; stderr: string; committed: boolean }>;

export interface RunPostWorkerFormatInput {
  /** Worker-branch token, passed through to each command's `cwd`. */
  worktree: string;
  /** Operator-declared commands (from `afk.post_worker_format`), in order. */
  commands: readonly string[];
  /** Injected millisecond clock — no `Date.now()` at call scope. */
  now: () => number;
  /**
   * Per-command kill deadline. Defaults to
   * {@link DEFAULT_POST_WORKER_FORMAT_TIMEOUT_MS}; a command that overruns
   * it is killed and resolves non-zero (via {@link KILLED_EXIT_CODE}), aborting
   * the sequence.
   */
  timeoutMs?: number;
}

export interface RunPostWorkerFormatResult {
  /** False when any command exited non-zero — caller routes to abortAfterClaim. */
  ok: boolean;
  /** True when at least one command produced a dirty checkout and was committed. */
  committed: boolean;
  /** Human-readable log lines (one per command that ran), for appendIterLog. */
  log: string[];
}

/**
 * Run the operator-declared post-worker-format commands in order against the
 * worker-branch worktree. For each command: time it with the injected clock,
 * run it via the injected exec in the worktree checkout, and either commit the
 * delta (if dirty + exit 0) or abort (if non-zero). Blank/whitespace entries
 * are skipped. An empty command list is a no-op (`ok:true`, `committed:false`).
 *
 * Stops on the FIRST non-zero exit (abort semantics, unlike backpressure which
 * runs all commands). A command killed by the `timeoutMs` deadline resolves
 * non-zero (via `KILLED_EXIT_CODE`) and aborts the sequence.
 */
export async function runPostWorkerFormat(
  exec: PostWorkerFormatExec,
  input: RunPostWorkerFormatInput,
): Promise<RunPostWorkerFormatResult> {
  const { worktree, commands, now } = input;
  const timeoutMs = input.timeoutMs ?? DEFAULT_POST_WORKER_FORMAT_TIMEOUT_MS;
  let anyCommitted = false;
  const log: string[] = [];

  for (const raw of commands) {
    const command = raw.trim();
    if (command === "") continue;

    const start = now();
    const result = await exec({ command, cwd: worktree, timeoutMs });
    const durationMs = now() - start;

    if (result.code !== 0) {
      const timedOut = result.code === KILLED_EXIT_CODE;
      const reason = timedOut ? `timed out after ${timeoutMs}ms` : `exited ${result.code}`;
      log.push(`post_worker_format: ${command}: ${reason} (${durationMs}ms) — aborting`);
      return { ok: false, committed: anyCommitted, log };
    }

    if (result.committed) anyCommitted = true;
    const action = result.committed ? "formatted + committed" : "clean";
    log.push(`post_worker_format: ${command}: ${action} (${durationMs}ms)`);
  }

  return { ok: true, committed: anyCommitted, log };
}
