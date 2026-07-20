/**
 * delivery.ts — waking whoever is sleeping on this wait.
 *
 * System signals are the wake mechanism; this module only decides WHOM to
 * signal and whether the wake actually landed. Two hazards drive the code:
 *
 * - **PID reuse.** `--signal-pid 4242` is validated when the wait starts, but a
 *   wait runs for an hour. If the original process dies and the OS hands 4242 to
 *   something else, signaling it would interrupt an innocent stranger. The PID's
 *   start time is pinned at parse time and re-checked immediately before the
 *   signal; a mismatch is a delivery FAILURE, never a misdirected signal.
 * - **A hook that hangs.** `--notify-cmd` is arbitrary shell. It is bounded by
 *   `--notify-timeout` and terminated as a whole process group, so a wedged hook
 *   cannot outlive the wait it was supposed to announce.
 */
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import type { JsonObject } from "@reddb-io/toon";
import type { DeliveryResult, WaitOptions } from "./model.js";
import { recordOf } from "./json.js";
import { pidIdentityMatches, terminateProcessTree } from "./process-tree.js";

/**
 * Run every configured completion hook against the already-durable `result`.
 *
 * Errors accumulate instead of short-circuiting: a failed signal must not stop
 * the notify command from running, and the caller wants the full receipt.
 */
export async function deliverCompletion(options: WaitOptions, result: JsonObject, cwd: string): Promise<DeliveryResult> {
  const errors: JsonObject[] = [];
  if (options.signalPid) {
    const error = await deliverSignal(options);
    if (error) errors.push(error);
  }
  if (options.notifyCmd?.trim()) {
    const error = await deliverNotify(options, result, cwd);
    if (error) errors.push({ hook: "notify-cmd", ...error });
  }
  return errors.length === 0 ? { status: "success" } : { status: "failure", errors };
}

/** Signal the pinned process, refusing to fire at a recycled PID. */
async function deliverSignal(options: WaitOptions): Promise<JsonObject | null> {
  const pid = options.signalPid!;
  if (!(await pidIdentityMatches(pid, options.signalPidStartTime))) {
    return {
      hook: "signal-pid",
      error: "target process is no longer the process the wait was asked to signal",
      pid,
      signal: options.signal,
    };
  }
  try {
    process.kill(pid, options.signal);
    return null;
  } catch (err) {
    return { hook: "signal-pid", error: errorMessage(err), pid, signal: options.signal };
  }
}

/**
 * Run `--notify-cmd` with the result in its environment.
 *
 * The hook receives the envelope as JSON in `RSP_WAIT_RESULT_JSON` because an
 * env var crossing into an arbitrary external program is exactly the
 * compatibility boundary JSON is for; the canonical record on disk stays TOON.
 */
async function deliverNotify(options: WaitOptions, result: JsonObject, cwd: string): Promise<JsonObject | null> {
  const wait = recordOf(result.wait);
  const verdict = recordOf(result.verdict);
  return await runNotifyCommand(options.notifyCmd!, cwd, options.notifyTimeoutMs, options.terminateGraceMs, {
    ...process.env,
    RSP_WAIT_RESULT_JSON: JSON.stringify(result),
    RSP_WAIT_RESULT_FILE: options.resultFile ? resolve(cwd, options.resultFile) : "",
    RSP_WAIT_STATUS: String(wait.status ?? "indeterminate"),
    RSP_WAIT_EXIT_CODE: String(verdict.target_exit_code ?? 2),
    RSP_WAIT_TARGET: String(wait.target ?? ""),
    RSP_WAIT_RESULT_SCHEMA: "rsp.wait.result@1",
  });
}

/** Returns null on success, or a structured error describing the failure. */
async function runNotifyCommand(
  command: string,
  cwd: string,
  timeoutMs: number,
  graceMs: number,
  env: NodeJS.ProcessEnv,
): Promise<JsonObject | null> {
  return await new Promise((resolveResult) => {
    let settled = false;
    let terminating = false;
    const finish = (value: JsonObject | null) => {
      if (settled) return;
      settled = true;
      resolveResult(value);
    };
    const child = spawn(command, { cwd, shell: true, stdio: "ignore", env, detached: process.platform !== "win32" });
    const timer = setTimeout(() => {
      terminating = true;
      void terminateProcessTree(child, graceMs).then((outcome) =>
        finish({
          error: `timed out after ${timeoutMs}ms`,
          ...(outcome.cleaned ? {} : { survivors: outcome.survivors }),
        }),
      );
    }, timeoutMs);
    child.once("error", (err) => {
      clearTimeout(timer);
      finish({ error: errorMessage(err) });
    });
    child.once("close", (status, signal) => {
      clearTimeout(timer);
      if (terminating) return;
      finish(
        status === 0
          ? null
          : { error: `exited with ${signal ?? status ?? "unknown"}`, status: status ?? null, signal: signal ?? null },
      );
    });
  });
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
