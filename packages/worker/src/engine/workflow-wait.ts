import { spawn } from "node:child_process";
import {
  GithubPoolUnavailableError,
  githubRateLimitResetAt,
  type GithubClient,
} from "@reddb-io/github";
import { killTreeAndWait } from "@reddb-io/shared/kill-tree.js";
import type { WebhookWakeSource } from "./workflow-webhook.js";

export type WorkflowWaitStatus =
  "success" | "failure" | "timeout" | "indeterminate";

export type WorkflowWaitExitCode = 0 | 1 | 2;

export interface WorkflowWaitResult {
  readonly status: WorkflowWaitStatus;
  readonly exitCode: WorkflowWaitExitCode;
  readonly summary: string;
  readonly stdout?: string;
  readonly stderr?: string;
  readonly notification: WorkflowWaitNotification;
}

export type WorkflowWaitNotification =
  | { readonly status: "success" }
  | { readonly status: "failure"; readonly error: string };

export interface CommandWaitOptions {
  readonly command: string;
  readonly args?: readonly string[];
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly timeoutMs: number;
  readonly terminateGraceMs?: number;
  readonly signal?: AbortSignal;
  readonly notify?: (result: WorkflowWaitResult) => void | Promise<void>;
}

export interface WorkflowWaitObservation {
  readonly status: WorkflowWaitStatus | "running";
  readonly exitCode: WorkflowWaitExitCode;
  readonly summary: string;
}

export interface GithubWorkflowWaitOptions {
  readonly client: GithubClient;
  readonly probe: (
    client: GithubClient,
  ) => WorkflowWaitObservation | Promise<WorkflowWaitObservation>;
  readonly timeoutMs: number;
  readonly pollIntervalMs: number;
  readonly signal?: AbortSignal;
  readonly onTransition?: (
    observation: WorkflowWaitObservation,
  ) => void | Promise<void>;
  readonly webhook?: {
    readonly source: WebhookWakeSource;
    readonly kind: "pr" | "run";
    readonly target: string;
  };
  readonly notify?: (result: WorkflowWaitResult) => void | Promise<void>;
  /** Injectable monotonic clock used by deterministic wait fixtures. */
  readonly now?: () => number;
  /** Injectable cancellable sleep used by deterministic wait fixtures. */
  readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

export async function waitForCommand(
  options: CommandWaitOptions,
): Promise<WorkflowWaitResult> {
  const child = spawn(options.command, [...(options.args ?? [])], {
    cwd: options.cwd,
    env: options.env,
    stdio: ["ignore", "pipe", "pipe"],
    detached: process.platform !== "win32",
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
  child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));

  const result = await new Promise<WorkflowWaitResult>((resolve) => {
    let settled = false;
    let terminating = false;
    let timer: NodeJS.Timeout;
    const finish = (result: WorkflowWaitResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      resolve(result);
    };
    const terminate = (
      status: "timeout" | "indeterminate",
      summary: string,
    ) => {
      if (settled || terminating) return;
      terminating = true;
      const graceMs = options.terminateGraceMs ?? 2_000;
      const pollMs = Math.max(1, Math.min(100, graceMs));
      const graceTries = Math.max(1, Math.ceil(graceMs / pollMs));
      const pid = child.pid;
      void (
        pid
          ? killTreeAndWait(pid, { graceTries, pollMs })
          : Promise.resolve(true)
      ).then((cleaned) => {
        finish({
          status: cleaned ? status : "indeterminate",
          exitCode: 2,
          summary: cleaned
            ? summary
            : `${summary}; could not verify process cleanup`,
          stdout: Buffer.concat(stdout).toString("utf8"),
          stderr: Buffer.concat(stderr).toString("utf8"),
          notification: { status: "success" },
        });
      });
    };
    const onAbort = () => terminate("indeterminate", "command wait cancelled");
    child.once("error", (error) => {
      finish({
        status: "failure",
        exitCode: 1,
        summary: error.message,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        notification: { status: "success" },
      });
    });
    child.once("close", (code, signal) => {
      if (terminating) return;
      const success = code === 0;
      finish({
        status: success ? "success" : "failure",
        exitCode: success ? 0 : 1,
        summary: success
          ? "command exited successfully"
          : `command exited with ${signal ?? code ?? "unknown"}`,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        notification: { status: "success" },
      });
    });
    timer = setTimeout(
      () =>
        terminate("timeout", `command timed out after ${options.timeoutMs}ms`),
      options.timeoutMs,
    );
    options.signal?.addEventListener("abort", onAbort, { once: true });
    if (options.signal?.aborted) onAbort();
  });

  return await withNotification(result, options.notify);
}

/**
 * Wait for a GitHub-backed workflow through the repository's budget-aware
 * client. Reads are serial: a new probe never starts before the previous one
 * and its budget-directed delay have settled.
 */
export async function waitForGithubWorkflow(
  options: GithubWorkflowWaitOptions,
): Promise<WorkflowWaitResult> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? sleepUntil;
  const signal = options.signal ?? new AbortController().signal;
  const deadline = now() + options.timeoutMs;
  const webhook = options.webhook;
  let lastTransition = "";
  const reportTransition = async (observation: WorkflowWaitObservation) => {
    const transition = `${observation.status}\0${observation.summary}`;
    if (transition === lastTransition) return;
    lastTransition = transition;
    await options.onTransition?.(observation);
  };
  await webhook?.source.start().catch(() => undefined);

  try {
    while (now() < deadline) {
      if (signal.aborted) {
        return await withNotification(
          workflowResult("indeterminate", 2, "workflow wait cancelled"),
          options.notify,
        );
      }

      let observation: WorkflowWaitObservation;
      try {
        observation = await options.probe(options.client);
      } catch (error) {
        const delayMs = Math.min(
          githubRetryDelay(error, now(), options.pollIntervalMs),
          Math.max(0, deadline - now()),
        );
        await pause(
          delayMs,
          signal,
          sleep,
          webhook?.source.makeWakeSignalFor(webhook.kind, webhook.target)(),
        );
        continue;
      }
      await reportTransition(observation).catch(() => undefined);

      if (
        observation.status !== "running" &&
        observation.status !== "indeterminate"
      ) {
        return await withNotification(
          workflowResult(
            observation.status,
            observation.exitCode,
            observation.summary,
          ),
          options.notify,
        );
      }

      await pause(
        Math.min(options.pollIntervalMs, Math.max(0, deadline - now())),
        signal,
        sleep,
        webhook?.source.makeWakeSignalFor(webhook.kind, webhook.target)(),
      );
    }

    return await withNotification(
      workflowResult(
        "timeout",
        2,
        `workflow timed out after ${options.timeoutMs}ms`,
      ),
      options.notify,
    );
  } finally {
    await webhook?.source.stop().catch(() => undefined);
  }
}

function workflowResult(
  status: WorkflowWaitStatus,
  exitCode: WorkflowWaitExitCode,
  summary: string,
): WorkflowWaitResult {
  return {
    status,
    exitCode,
    summary,
    notification: { status: "success" },
  };
}

async function withNotification(
  result: WorkflowWaitResult,
  notify: CommandWaitOptions["notify"],
): Promise<WorkflowWaitResult> {
  if (!notify) return result;
  try {
    await notify(result);
    return result;
  } catch (error) {
    return {
      ...result,
      notification: {
        status: "failure",
        error: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

function githubRetryDelay(
  error: unknown,
  nowMs: number,
  fallbackMs: number,
): number {
  const resetAt =
    error instanceof GithubPoolUnavailableError
      ? error.resetAt
      : githubRateLimitResetAt(error, nowMs);
  if (!resetAt) return fallbackMs;
  const resetMs = Date.parse(resetAt);
  if (!Number.isFinite(resetMs)) return fallbackMs;
  return Math.max(fallbackMs, resetMs - nowMs);
}

async function sleepUntil(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0 || signal.aborted) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(done, ms);
    const onAbort = () => done();
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      resolve();
    }
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

async function pause(
  ms: number,
  cancelSignal: AbortSignal,
  sleep: (ms: number, signal: AbortSignal) => Promise<void>,
  wakeSignal: AbortSignal | undefined,
): Promise<void> {
  if (!wakeSignal) return await sleep(ms, cancelSignal);
  if (wakeSignal.aborted || cancelSignal.aborted || ms <= 0) return;
  await new Promise<void>((resolve) => {
    const controller = new AbortController();
    const done = () => {
      wakeSignal.removeEventListener("abort", done);
      cancelSignal.removeEventListener("abort", done);
      controller.abort();
      resolve();
    };
    wakeSignal.addEventListener("abort", done, { once: true });
    cancelSignal.addEventListener("abort", done, { once: true });
    void sleep(ms, controller.signal).then(done, done);
  });
}
