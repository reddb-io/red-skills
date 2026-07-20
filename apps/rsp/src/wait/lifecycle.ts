/**
 * lifecycle.ts — how a wait actually spends its time, and how it stops.
 *
 * Two execution shapes live here and share one discipline: a single deadline, a
 * single cancellation signal, and no path that can outlive either.
 *
 * - {@link runCommandWait} is event-driven. It never polls; the child's `close`
 *   event is the signal. The only timers are the deadline and the termination
 *   grace.
 * - {@link pollUntilDone} is the GitHub shape. Each probe is individually
 *   bounded (see `github.ts`), so the loop's deadline is a REAL upper bound even
 *   when a single call hangs.
 *
 * Both record their progress into the registry as they go, so an observer can
 * see attempts and last observation without asking the waiting process anything.
 */
import { spawn } from "node:child_process";
import type { JsonObject } from "@reddb-io/toon";
import { createCommandCaptures, type BoundedStreamCapture } from "./capture.js";
import { defaultWaitCaptureStore, type WaitCaptureStore } from "./capture-store.js";
import { indeterminate, type Verdict, type WaitOptions, type WaitRegistryEntry } from "./model.js";
import { sleepUntil, terminateProcessTree } from "./process-tree.js";
import { writeRegistryEntry, writeStatus } from "./registry.js";

/** A finished execution, plus the cleanup evidence the completion needs. */
export interface WaitExecution {
  verdict: Verdict;
  /**
   * Undefined when nothing needed terminating. False means signals were sent but
   * the tree could not be proven gone — the completion downgrades to exit 2.
   */
  cleanupProven?: boolean;
  survivors?: number[];
}

export interface CommandWaitContext {
  commandLine: string;
  options: WaitOptions;
  cwd: string;
  spoolDir: string;
  registryPath: string;
  entry: WaitRegistryEntry;
  signal: AbortSignal;
  /** Injected in tests to exercise the store-unavailable path. */
  store?: WaitCaptureStore;
}

/**
 * Run a local command and wait for it, capturing bounded output.
 *
 * The child is spawned DETACHED so it leads its own process group: that is what
 * makes whole-tree termination possible on timeout or interruption. The cost is
 * that we must always terminate deliberately — an orphaned group would survive
 * this process — which is why every exit path here goes through
 * {@link terminateProcessTree} or a natural `close`.
 */
export async function runCommandWait(context: CommandWaitContext): Promise<WaitExecution> {
  const { commandLine, options, cwd, registryPath, entry, signal } = context;
  if (!commandLine.trim()) return { verdict: indeterminate("missing command line") };

  const store = context.store ?? defaultWaitCaptureStore(cwd);
  const captures = createCommandCaptures(context.spoolDir, entry.id, options.captureBytes);

  return await new Promise<WaitExecution>((resolveExecution) => {
    let settled = false;
    let terminating = false;
    const finish = async (execution: WaitExecution) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      await writeStatus(registryPath, entry, execution.verdict.status).catch(() => undefined);
      resolveExecution(execution);
    };

    const child = spawn(commandLine, {
      cwd,
      shell: true,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    child.stdout?.on("data", (chunk) => captures.stdout.write(Buffer.from(chunk)));
    child.stderr?.on("data", (chunk) => captures.stderr.write(Buffer.from(chunk)));

    /** Cancel the command and report what we could prove about the cleanup. */
    const terminate = async (status: "timeout" | "indeterminate", summary: string) => {
      if (settled || terminating) return;
      terminating = true;
      clearTimeout(timer);
      const outcome = await terminateProcessTree(child, options.terminateGraceMs);
      const details = await commandDetails(null, null, captures, store, commandLine);
      await finish({
        verdict: { status, exitCode: 2, summary, details },
        cleanupProven: outcome.cleaned,
        survivors: outcome.survivors,
      });
    };

    const onAbort = () => void terminate("indeterminate", "command interrupted");
    signal.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => {
      void terminate("timeout", `command timed out after ${formatDuration(options.timeoutMs)}`);
    }, options.timeoutMs);

    child.once("error", (err) => {
      clearTimeout(timer);
      void captures.stdout.discard();
      void captures.stderr.discard();
      void finish({ verdict: { status: "failure", exitCode: 1, summary: err.message } });
    });

    child.once("close", (status, closeSignal) => {
      clearTimeout(timer);
      if (settled || terminating) return;
      const ok = status === 0;
      void commandDetails(status, closeSignal, captures, store, commandLine).then((details) =>
        finish({
          verdict: {
            status: ok ? "success" : "failure",
            exitCode: ok ? 0 : 1,
            summary: ok ? "command exited successfully" : `command exited with ${closeSignal ?? status ?? "unknown"}`,
            details,
          },
        }),
      );
    });

    // An abort that arrived while we were spawning must still be honored.
    if (signal.aborted) onAbort();
  });
}

/**
 * Poll a probe until it returns a terminal verdict or the deadline passes.
 *
 * `running` and `indeterminate` both mean "ask again": a transient GitHub error
 * must not be mistaken for a target failure. Only the deadline converts an
 * unresolved wait into a terminal `timeout`, and the last observation rides along
 * so the caller can see WHY it never resolved.
 */
export async function pollUntilDone(input: {
  probe: () => Promise<Verdict>;
  timeoutMs: number;
  baseSleepMs: number;
  registryPath: string;
  entry: WaitRegistryEntry;
  signal: AbortSignal;
}): Promise<WaitExecution> {
  const { probe, timeoutMs, baseSleepMs, registryPath, entry, signal } = input;
  const deadline = Date.now() + timeoutMs;
  let attempt = 0;
  let lastObservation: Verdict | undefined;

  while (Date.now() < deadline) {
    if (signal.aborted) return { verdict: interruptedVerdict(lastObservation, attempt, entry.last_poll_at) };
    let verdict: Verdict;
    try {
      verdict = await probe();
    } catch (err) {
      // A throwing probe is an observation failure, not a target failure.
      verdict = indeterminate(err instanceof Error ? err.message : String(err));
    }
    lastObservation = verdict;
    entry.attempts = ++attempt;
    entry.last_poll_at = new Date().toISOString();
    entry.last_observation = observationOf(verdict);
    await writeRegistryEntry(registryPath, entry).catch(() => undefined);

    if (verdict.status !== "running" && verdict.status !== "indeterminate") {
      await writeStatus(registryPath, entry, verdict.status).catch(() => undefined);
      return { verdict };
    }
    // Exponential backoff with jitter, capped at 4x the base tier and never
    // sleeping past the deadline, so the loop cannot overshoot its own bound.
    const backoffMs = Math.min(baseSleepMs * 4, Math.round(baseSleepMs * Math.pow(1.25, attempt - 1)));
    const jitterMs = Math.floor(Math.random() * 1_000);
    await sleepUntil(Math.min(backoffMs + jitterMs, Math.max(0, deadline - Date.now())), signal);
  }

  await writeStatus(registryPath, entry, "timeout").catch(() => undefined);
  return {
    verdict: {
      status: "timeout",
      exitCode: 2,
      summary: `timed out after ${formatDuration(timeoutMs)}`,
      details: lastObservation
        ? {
          attempts: attempt,
          last_poll_at: entry.last_poll_at ?? null,
          last_observation: observationOf(lastObservation),
        }
        : { attempts: attempt },
    },
  };
}

/** Finalize both captures and fold them into the verdict details. */
async function commandDetails(
  status: number | null,
  signal: NodeJS.Signals | null,
  captures: { stdout: BoundedStreamCapture; stderr: BoundedStreamCapture },
  store: WaitCaptureStore,
  commandLine: string,
): Promise<JsonObject> {
  const [stdout, stderr] = await Promise.all([
    captures.stdout.finish(store, `${commandLine} # stdout`),
    captures.stderr.finish(store, `${commandLine} # stderr`),
  ]);
  return {
    status: status ?? null,
    signal: signal ?? null,
    stdout: stdout as unknown as JsonObject,
    stderr: stderr as unknown as JsonObject,
  };
}

function observationOf(value: Verdict): JsonObject {
  return {
    status: value.status,
    exit_code: value.exitCode,
    summary: value.summary,
    ...(value.details ? { details: value.details } : {}),
  };
}

function interruptedVerdict(last: Verdict | undefined, attempts: number, lastPollAt: string | undefined): Verdict {
  return indeterminate("wait interrupted", {
    attempts,
    last_poll_at: lastPollAt ?? null,
    ...(last ? { last_observation: observationOf(last) } : {}),
  });
}

export function formatDuration(ms: number): string {
  if (ms % 3_600_000 === 0) return `${ms / 3_600_000}h`;
  if (ms % 60_000 === 0) return `${ms / 60_000}m`;
  if (ms % 1_000 === 0) return `${ms / 1_000}s`;
  return `${ms}ms`;
}
