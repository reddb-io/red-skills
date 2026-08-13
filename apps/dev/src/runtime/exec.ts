// runtime/exec.ts — the single real-process boundary.
//
// Every gh/git/pnpm closure assembled in this runtime/ tree ultimately routes
// through `execTool`, a bounded wrapper over node:child_process spawn. It NEVER
// throws on a non-zero exit (the orchestrators decide what a
// non-zero code means); it resolves with {code,stdout,stderr} so callers can
// branch on the code. The thin `git` / `gh` / `pnpm` helpers fix the command
// head so call sites read as argv arrays.

import { spawn } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";

const PROCESS_GROUP_POLL_MS = 50;
const PROCESS_GROUP_GRACE_TRIES = 10;
const PROCESS_GROUP_KILL_TRIES = 20;

const sleep = (ms: number, signal?: AbortSignal): Promise<boolean> =>
  new Promise((resolve) => {
    if (signal?.aborted) {
      resolve(false);
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve(true);
    }, ms);
    const abort = (): void => {
      clearTimeout(timer);
      resolve(false);
    };
    signal?.addEventListener("abort", abort, { once: true });
  });

function processGroupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function signalProcessGroup(pgid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pgid, signal);
  } catch {
    // The group already exited.
  }
}

async function terminateProcessGroup(pgid: number): Promise<boolean> {
  signalProcessGroup(pgid, "SIGTERM");
  for (let i = 0; i < PROCESS_GROUP_GRACE_TRIES; i += 1) {
    if (!processGroupAlive(pgid)) return true;
    await sleep(PROCESS_GROUP_POLL_MS);
  }
  signalProcessGroup(pgid, "SIGKILL");
  for (let i = 0; i < PROCESS_GROUP_KILL_TRIES; i += 1) {
    if (!processGroupAlive(pgid)) return true;
    await sleep(PROCESS_GROUP_POLL_MS);
  }
  return !processGroupAlive(pgid);
}

export interface ExecOutput {
  code: number;
  stdout: string;
  stderr: string;
  /** Typed infrastructure evidence emitted when validation made no CPU progress. */
  infraEvidence?: ValidationInfraEvidence;
  resources?: import("../core/validation-resources.js").ValidationResourceEvidence;
}

export interface ValidationInfraEvidence {
  kind: "stall";
  wallTimeMs: number;
  sampleWindowMs: number;
  cpuDeltaMs: number;
}

export interface ValidationStallDetection {
  /** Do not judge CPU idleness until the command exceeds its normal envelope. */
  minWallTimeMs: number;
  /** One CPU-progress observation window. */
  sampleIntervalMs: number;
  /** CPU growth at or below this value is treated as no progress. */
  idleCpuThresholdMs: number;
}

/** Production validation envelope: 20 minutes, then one 30-second CPU window. */
export const DEFAULT_VALIDATION_STALL_DETECTION: Readonly<ValidationStallDetection> = Object.freeze({
  minWallTimeMs: 20 * 60_000,
  sampleIntervalMs: 30_000,
  idleCpuThresholdMs: 5,
});

export interface ExecOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Process-kill timeout in milliseconds (0 / undefined = no timeout). */
  timeoutMs?: number;
  /** Max captured bytes per stream (default 16 MiB). */
  maxBuffer?: number;
  /** Optional stdin payload written to the child. */
  input?: string;
  /** Best-effort delivery of each complete stdout line while the child runs.
   * The normal captured stdout remains unchanged. Callback failures are
   * swallowed so observability cannot affect command execution. */
  onStdoutLine?: (line: string) => void;
  /** Called synchronously as soon as the OS assigns the child pid. A caller
   * blocked on this command can publish an explained wait before it awaits the
   * exit. Callback failures are observability failures and never affect the
   * child. */
  onSpawn?: (pid: number) => void;
  /** Linux process-group CPU-idle detector, enabled only for validation children. */
  stallDetection?: ValidationStallDetection;
}

/** Linux exposes process CPU in USER_HZ ticks; USER_HZ is 100 on supported hosts. */
const LINUX_USER_TICK_MS = 10;

/** Aggregate current CPU for every process in the detached validation group. */
function processGroupCpuMs(pgid: number): number | null {
  if (process.platform !== "linux") return null;
  let ticks = 0;
  let seen = false;
  let entries: string[];
  try {
    entries = readdirSync("/proc");
  } catch {
    return null;
  }
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const stat = readFileSync(`/proc/${entry}/stat`, "utf8");
      const close = stat.lastIndexOf(")");
      if (close < 0) continue;
      const fields = stat.slice(close + 2).trim().split(/\s+/);
      if (Number(fields[2]) !== pgid) continue;
      const utime = Number(fields[11]);
      const stime = Number(fields[12]);
      if (!Number.isFinite(utime) || !Number.isFinite(stime)) continue;
      ticks += utime + stime;
      seen = true;
    } catch {
      // A process can exit between the /proc directory read and its stat read.
    }
  }
  return seen ? ticks * LINUX_USER_TICK_MS : null;
}

/**
 * Watch one detached validation process group until it exits or exceeds the
 * normal wall envelope without consuming CPU for a complete sampling window.
 */
async function monitorCpuStall(
  pgid: number,
  options: ValidationStallDetection,
  signal: AbortSignal,
  onStall: (evidence: ValidationInfraEvidence) => void,
): Promise<void> {
  const started = Date.now();
  let previousCpuMs = processGroupCpuMs(pgid);
  let previousSampleAt = started;
  while (!signal.aborted) {
    const elapsed = await sleep(options.sampleIntervalMs, signal);
    if (!elapsed || signal.aborted) return;
    const sampledAt = Date.now();
    const cpuMs = processGroupCpuMs(pgid);
    if (cpuMs === null || previousCpuMs === null) {
      previousCpuMs = cpuMs;
      previousSampleAt = sampledAt;
      continue;
    }
    const wallTimeMs = sampledAt - started;
    const sampleWindowMs = sampledAt - previousSampleAt;
    const cpuDeltaMs = Math.max(0, cpuMs - previousCpuMs);
    const sampleStartedAfterEnvelope = previousSampleAt - started >= options.minWallTimeMs;
    previousCpuMs = cpuMs;
    previousSampleAt = sampledAt;
    if (wallTimeMs < options.minWallTimeMs) continue;
    if (!sampleStartedAfterEnvelope) continue;
    if (cpuDeltaMs > options.idleCpuThresholdMs) continue;
    onStall({ kind: "stall", wallTimeMs, sampleWindowMs, cpuDeltaMs });
    return;
  }
}

/**
 * The injectable exec boundary. `execTool` is the production implementation; the
 * gh/git Contexts carry an OPTIONAL field of this shape so tests can drive the
 * REAL gh/git closure assembly over a recording fake instead of the OS. When
 * unset (production), the gh/git helpers fall through to the real `execTool`, so
 * behaviour is identical to a static import.
 */
export type ExecFn = (cmd: string, args: readonly string[], opts?: ExecOptions) => Promise<ExecOutput>;

// Default stdout/stderr capture ceiling for a single command. Raised from 16MB
// to 64MB (AFK runner improvement): the feedback gate runs `pnpm test` for a
// whole monorepo package, and a verbose vitest run over ~1700 tests can exceed
// 16MB of combined output. On overflow Node KILLS the child and reports the
// error — so a fully-GREEN suite would read as a failure purely because its
// output was large. 64MB covers the largest current suite with headroom;
// callers that need a different ceiling pass `opts.maxBuffer`.
const DEFAULT_MAX_BUFFER = 64 * 1024 * 1024;

/**
 * Exit code reported when a command's output exceeds the maxBuffer ceiling.
 * Distinct from a real command failure (the command may have SUCCEEDED — the
 * tests all passed — and only its OUTPUT was too large). The feedback gate's
 * Verdict matches the literal `maxBuffer length exceeded` substring this
 * carries on stderr, so a buffer overflow consumes the one environment ledger
 * (a config problem the operator fixes), never the branch budget. 126 mirrors
 * the shell's "command found but not
 * executable" slot — a code no normal test runner returns.
 */
export const MAXBUFFER_EXIT_CODE = 126;

/**
 * Exit code reported for a command killed by the exec timeout or an external
 * signal. Node leaves the numeric exit slot empty when a child dies from a
 * signal, so without this the old fallthrough read a killed/timed-out
 * command as success — a slow model classification, or a future timed-out land,
 * silently passing (PRD #567). 124 mirrors GNU `timeout(1)`'s killed-process
 * code so any caller branching on `code !== 0` reads the kill as a failure.
 */
export const KILLED_EXIT_CODE = 124;

/**
 * Run `cmd args…` and resolve with the captured exit code + streams. A spawn
 * error (ENOENT for a missing binary, etc.) resolves with code 127 and the
 * error message on stderr rather than rejecting, so a missing `gh` reads as a
 * clean precondition signal upstream instead of an unhandled rejection. A
 * command killed by the `timeoutMs` deadline or an external signal resolves with
 * {@link KILLED_EXIT_CODE} — never code 0 — so callers branching on a non-zero
 * code read the kill as a failure.
 */
export function execTool(cmd: string, args: readonly string[], opts: ExecOptions = {}): Promise<ExecOutput> {
  return new Promise((resolve) => {
    const maxBuffer = opts.maxBuffer ?? DEFAULT_MAX_BUFFER;
    const child = spawn(cmd, [...args], {
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      // POSIX setsid: child.pid is the process-group ID for the complete gate.
      detached: process.platform !== "win32",
      stdio: [opts.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });
    if (child.pid !== undefined && opts.onSpawn !== undefined) {
      try {
        opts.onSpawn(child.pid);
      } catch {
        // Declared-wait publication must never change command execution.
      }
    }
    let stdout = "";
    let stderr = "";
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let overflow = false;
    let timedOut = false;
    let infraEvidence: ValidationInfraEvidence | undefined;
    let spawnError: Error | undefined;
    let termination: Promise<boolean> | undefined;
    const monitorAbort = new AbortController();

    const terminate = (): Promise<boolean> => {
      if (termination) return termination;
      if (child.pid === undefined) return Promise.resolve(true);
      if (process.platform === "win32") {
        child.kill("SIGKILL");
        return Promise.resolve(true);
      }
      termination = terminateProcessGroup(child.pid);
      return termination;
    };

    if (
      child.pid !== undefined &&
      process.platform === "linux" &&
      opts.stallDetection !== undefined
    ) {
      void monitorCpuStall(child.pid, opts.stallDetection, monitorAbort.signal, (evidence) => {
        infraEvidence = evidence;
        void terminate();
      });
    }

    const capture = (stream: "stdout" | "stderr", chunk: Buffer): void => {
      const used = stream === "stdout" ? stdoutBytes : stderrBytes;
      if (used + chunk.byteLength > maxBuffer) {
        overflow = true;
        void terminate();
        return;
      }
      if (stream === "stdout") {
        stdoutBytes += chunk.byteLength;
        stdout += chunk.toString();
      } else {
        stderrBytes += chunk.byteLength;
        stderr += chunk.toString();
      }
    };

    child.stdout?.on("data", (chunk: Buffer) => capture("stdout", chunk));
    child.stderr?.on("data", (chunk: Buffer) => capture("stderr", chunk));
    child.on("error", (error) => {
      spawnError = error;
    });

    const timeout = opts.timeoutMs && opts.timeoutMs > 0
      ? setTimeout(() => {
          timedOut = true;
          void terminate();
        }, opts.timeoutMs)
      : undefined;

    child.on("close", async (code, signal) => {
      monitorAbort.abort();
      if (timeout) clearTimeout(timeout);
      const cleaned = signal !== null
        ? await terminate()
        : termination
          ? await termination
          : true;
      if (!cleaned) {
        resolve({
          code: KILLED_EXIT_CODE,
          stdout,
          stderr: `${stderr}${stderr ? "\n" : ""}process-group cleanup could not be confirmed`,
        });
        return;
      }

      if (overflow) {
        resolve({
          code: MAXBUFFER_EXIT_CODE,
          stdout,
          stderr: "command output exceeded the capture ceiling (maxBuffer length exceeded)",
        });
        return;
      }
      if (spawnError) {
        resolve({ code: 127, stdout, stderr: spawnError.message });
        return;
      }
      if (timedOut || signal !== null) {
        const stallMessage = infraEvidence
          ? `validation child stalled: ${infraEvidence.cpuDeltaMs}ms CPU over ` +
            `${infraEvidence.sampleWindowMs}ms while wall time reached ${infraEvidence.wallTimeMs}ms`
          : undefined;
        resolve({
          code: KILLED_EXIT_CODE,
          stdout,
          stderr: stallMessage ?? (stderr || `command terminated by ${signal ?? "timeout"}`),
          ...(infraEvidence === undefined ? {} : { infraEvidence }),
        });
        return;
      }
      resolve({ code: code ?? 0, stdout, stderr });
    });
    if (opts.input !== undefined && child.stdin) {
      // A hook that ignores stdin (or exits first) closes the pipe under us.
      // Without this listener that EPIPE is an unhandled 'error' event and
      // takes the whole worker down; the child's exit code is the real signal.
      child.stdin.on("error", () => {});
      child.stdin.end(opts.input);
    }
    if (opts.onStdoutLine && child.stdout) {
      let pending = "";
      const deliver = (line: string): void => {
        try {
          opts.onStdoutLine?.(line);
        } catch {
          // Observability callbacks must never affect the child process.
        }
      };
      child.stdout.on("data", (chunk) => {
        pending += String(chunk);
        const lines = pending.split(/\r?\n/);
        pending = lines.pop() ?? "";
        for (const line of lines) deliver(line);
      });
      child.stdout.on("end", () => {
        if (pending) deliver(pending);
      });
    }
  });
}

/** Thin `git args…` helper (optionally pinned to a working dir via opts.cwd). */
export function git(args: readonly string[], opts: ExecOptions = {}): Promise<ExecOutput> {
  return execTool("git", args, opts);
}

/** Thin `gh args…` helper. */
export function gh(args: readonly string[], opts: ExecOptions = {}): Promise<ExecOutput> {
  return execTool("gh", args, opts);
}

/** Thin `pnpm args…` helper. */
export function pnpm(args: readonly string[], opts: ExecOptions = {}): Promise<ExecOutput> {
  return execTool("pnpm", args, opts);
}
