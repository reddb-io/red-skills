// process-safety — install process-level death detectors on the AFK worker.
//
// Pattern 5 of the claude-minimax spike investigation: every single worker
// process (10+, across wMHZR/wPB6F/wUP0D/wAFBD/wQYIB/w8NT0/wBSCD/wUF6D/
// wJVX3/...) died post-commit + vitest. The cross-host stale-claim sweep
// recovered every issue, but the CAUSE was opaque — no exit code, no signal,
// no stack. The next worker that re-claimed the issue had no way to know
// why its predecessor died; the only signal was "agent idle for 1 minute"
// followed by process absence.
//
// This module fixes that by installing process-level handlers at worker
// startup. Every death leaves a forensic record at a known path so the
// next session (or a human running `git log` on `.red/`) can see what
// happened:
//
//   - uncaughtException         → stack + message → fatal log
//   - unhandledRejection        → stack + reason → fatal log
//   - SIGTERM / SIGINT / SIGHUP  → signal name → fatal log
//   - exit (any reason)          → exit code → notice log
//   - memoryPressure (Node ≥ 18) → warning log (best effort)
//
// The handlers do NOT prevent the process from dying (the goal is to OBSERVE,
// not to swallow the death — swallowing would mask the real bug). They just
// leave a breadcrumb so the next session can correlate. Tests stub `install`
// via the injected logger so the handlers don't fire spuriously under vitest.

import { appendFileSync } from "node:fs";
import { join } from "node:path";

/** The injectable logger the safety handlers use. Production: writes to a
 * file via appendFileSync; tests: an in-memory array. */
export interface SafetyLogger {
  log(line: string): void;
}

/** A file-backed logger; one line per death event, append-only. */
export function fileSafetyLogger(path: string): SafetyLogger {
  return {
    log(line: string): void {
      try {
        appendFileSync(path, `${new Date().toISOString()} ${line}\n`);
      } catch {
        // best effort — a broken logger must never break the death handler
      }
    },
  };
}

/** A no-op logger (used when the caller wants the handlers installed but
 * doesn't care about the output — e.g. short-lived one-shot commands). */
export const noopSafetyLogger: SafetyLogger = {
  log(_line: string): void {
    /* noop */
  },
};

/** The bundle of handlers + their teardown function. */
export interface ProcessSafety {
  /** Detach the installed handlers. Idempotent. After uninstall the
   * handlers no longer fire — the process continues to run normally. */
  uninstall(): void;
  /**
   * The individual handlers, exposed for unit tests. Tests call them
   * directly instead of `process.emit('uncaughtException', ...)` so vitest's
   * own uncaughtException listener doesn't intercept the synthetic event.
   * In production code these are NEVER called directly — `process.on(...)`
   * is the only intended trigger.
   */
  handlers: {
    uncaughtException(err: Error): void;
    unhandledRejection(reason: unknown): void;
    sigTerm(): void;
    sigInt(): void;
    sigHup(): void;
    exit(code: number | null): void;
  };
}

/** The current safety installation status, exported for tests + diagnostics.
 * `null` when no handlers are installed (the default state). */
let activeSafety: ProcessSafety | null = null;

/** Return the active safety installation (or null). Useful for tests and for
 * code that wants to coordinate with the handlers (e.g. a graceful-shutdown
 * path that should also uninstall the death detectors). */
export function getActiveSafety(): ProcessSafety | null {
  return activeSafety;
}

/**
 * Install process-level death detectors that write to `logger`.
 *
 * Idempotent: if a previous installation is still active it is uninstalled
 * first (matches the contract of `getActiveSafety` — there is at most one
 * bundle of handlers per process). Returns a `ProcessSafety` whose
 * `uninstall` tears down every handler the install added. NEVER call this
 * from library code — only from the worker entry point (commands/run.ts +
 * the boot supervisor), so test code stays untouched.
 *
 * The handler bodies are deliberately small (just a log line + a `process
 * .exit(0)` for graceful paths) so a misbehaving handler itself can't
 * become a new source of process death.
 */
export function installProcessSafety(
  logger: SafetyLogger,
  meta: { workerId?: string; pid?: number } = {},
): ProcessSafety {
  if (activeSafety) activeSafety.uninstall();
  const pid = meta.pid ?? process.pid;
  const wid = meta.workerId ?? "(no-worker-id)";

  const write = (event: string, detail: string): void => {
    logger.log(`pid=${pid} worker=${wid} event=${event} ${detail}`);
  };

  const onUncaught = (err: Error): void => {
    write("uncaughtException", `message=${JSON.stringify(err.message)} stack=${JSON.stringify(err.stack ?? "")}`);
  };
  const onUnhandled = (reason: unknown): void => {
    const r = reason instanceof Error
      ? `message=${JSON.stringify(reason.message)} stack=${JSON.stringify(reason.stack ?? "")}`
      : `value=${JSON.stringify(reason)}`;
    write("unhandledRejection", r);
  };
  const onSigTerm = (): void => write("SIGTERM", "received");
  const onSigInt = (): void => write("SIGINT", "received");
  const onSigHup = (): void => write("SIGHUP", "received");
  const onExit = (code: number | null): void => {
    // The exit handler is best-effort: a process is already on its way out
    // when this fires, so we use the synchronous file write and accept that
    // a hard kill may skip it. The other handlers above are the durable
    // signal; this one is the "we made it to a clean exit code N" notice.
    write("exit", `code=${code ?? "null"}`);
  };

  process.on("uncaughtException", onUncaught);
  process.on("unhandledRejection", onUnhandled);
  process.on("SIGTERM", onSigTerm);
  process.on("SIGINT", onSigInt);
  process.on("SIGHUP", onSigHup);
  process.on("exit", onExit);

  write("installed", `node=${process.version} platform=${process.platform}`);

  activeSafety = {
    uninstall(): void {
      process.off("uncaughtException", onUncaught);
      process.off("unhandledRejection", onUnhandled);
      process.off("SIGTERM", onSigTerm);
      process.off("SIGINT", onSigInt);
      process.off("SIGHUP", onSigHup);
      process.off("exit", onExit);
      activeSafety = null;
    },
    handlers: {
      uncaughtException: onUncaught,
      unhandledRejection: onUnhandled,
      sigTerm: onSigTerm,
      sigInt: onSigInt,
      sigHup: onSigHup,
      exit: onExit,
    },
  };
  return activeSafety;
}

/** Build the canonical safety-log path for a worker: `.red/tmp/diagnostics/
 * <worker-id>.log`. The diagnostics dir is gitignored. */
export function safetyLogPath(redTmpDir: string, workerId: string): string {
  return join(redTmpDir, "diagnostics", `${workerId}.log`);
}
