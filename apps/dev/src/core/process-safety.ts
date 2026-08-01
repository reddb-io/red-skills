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
//
// THE SIGKILL BLIND SPOT. The single most likely Pattern 5 cause — the OS
// OOM-killer SIGKILLing the orchestrator under memory pressure — is
// UNCATCHABLE: SIGKILL fires no handler and no `exit` event. So a worker that
// is OOM-killed leaves a log with an `installed` line but NO terminal line.
// That absence is itself the signal. To make it legible, the install starts a
// periodic `alive` heartbeat (default every 15s). A reader
// (`classifyDeathFromLog`) then classifies a worker's fate from its log:
//   - a terminal line (exit / signal / uncaught) present  → "clean" / that cause
//   - `installed` + `alive` but NO terminal line          → "uncatchable"
//     (almost always SIGKILL/OOM, the thing the handlers can't see), with the
//     last heartbeat as the approximate time of death.
// This closes Pattern 5's observability: the next session can SAY "the previous
// worker was OOM-killed at ~HH:MM" instead of "the process just vanished".

import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { markDeathPhase } from "@reddb-io/shared/death-record.js";

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
  /** Detach the installed handlers + stop the heartbeat. Idempotent. After
   * uninstall the handlers no longer fire — the process runs normally. */
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
    /** The periodic liveness heartbeat. Exposed for unit tests; in production
     * a timer drives it. */
    heartbeat(): void;
  };
}

export type ActiveClaimFinalizer = () => void | Promise<void>;

/** Options for {@link installProcessSafety}. */
export interface ProcessSafetyOptions {
  workerId?: string;
  pid?: number;
  /**
   * Liveness heartbeat interval in milliseconds. Default 15000. The heartbeat
   * writes an `alive` line so `classifyDeathFromLog` can pin the approximate
   * time of an UNCATCHABLE death (SIGKILL/OOM, which fire no handler). Set to
   * 0 to disable the heartbeat (tests that drive `handlers.heartbeat()`
   * manually pass 0 so no real timer is created).
   */
  heartbeatMs?: number;
  /**
   * Injected timer factory, so tests don't create real intervals. Defaults to
   * Node's `setInterval`/`clearInterval`. The returned handle is passed back to
   * `clear` on uninstall. `.unref()` is called when present so the heartbeat
   * never keeps the process alive on its own.
   */
  setInterval?: (fn: () => void, ms: number) => { unref?: () => void };
  clearInterval?: (handle: unknown) => void;
}

/** The classified fate of a worker, derived from its diagnostic log. */
export type DeathClass =
  | { kind: "running" } // installed, alive, no terminal — but we can't tell live-vs-dead from the log alone
  | { kind: "clean-exit"; code: string }
  | { kind: "signal"; signal: string }
  | { kind: "uncaught"; detail: string }
  | { kind: "uncatchable"; lastAliveLine: string | null } // SIGKILL/OOM: installed + maybe alive, no terminal
  | { kind: "unknown" }; // no `installed` line — the log isn't a safety log

/** The current safety installation status, exported for tests + diagnostics.
 * `null` when no handlers are installed (the default state). */
let activeSafety: ProcessSafety | null = null;
let activeClaimFinalizer: ActiveClaimFinalizer | null = null;
let activeStepWriter: ((step: string) => void) | null = null;
let activeLastStep = "startup";

/** Return the active safety installation (or null). Useful for tests and for
 * code that wants to coordinate with the handlers (e.g. a graceful-shutdown
 * path that should also uninstall the death detectors). */
export function getActiveSafety(): ProcessSafety | null {
  return activeSafety;
}

export function setActiveClaimFinalizer(finalizer: ActiveClaimFinalizer | null): void {
  activeClaimFinalizer = finalizer;
}

/** Record the worker's current macro step in the process-safety diagnostic log.
 * The value is intentionally short and local to AFK internals; public comments
 * consume only the classified cause, not these raw breadcrumbs. */
export function markProcessSafetyStep(step: string): void {
  activeLastStep = step;
  activeStepWriter?.(step);
  // One announcement, both records. The death record's `last_phase` is only worth
  // reading if it is the phase the process was ACTUALLY in, and the call sites
  // that already say where they are are these — asking them to announce twice is
  // how the second record drifts into naming a phase nobody is in any more.
  markDeathPhase(step);
}

function runActiveClaimFinalizer(): void {
  const finalizer = activeClaimFinalizer;
  if (!finalizer) return;
  activeClaimFinalizer = null;
  try {
    void finalizer();
  } catch {
    // best-effort shutdown cleanup; a broken finalizer must not hide the signal
  }
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
  meta: ProcessSafetyOptions = {},
): ProcessSafety {
  if (activeSafety) activeSafety.uninstall();
  const pid = meta.pid ?? process.pid;
  const wid = meta.workerId ?? "(no-worker-id)";
  const heartbeatMs = meta.heartbeatMs ?? 15000;
  const setIntervalFn = meta.setInterval ?? ((fn, ms) => setInterval(fn, ms));
  const clearIntervalFn = meta.clearInterval ?? ((h) => clearInterval(h as NodeJS.Timeout));

  const write = (event: string, detail: string): void => {
    logger.log(`pid=${pid} worker=${wid} event=${event} ${detail}`);
  };
  activeLastStep = "startup";
  activeStepWriter = (step) => write("step", `name=${JSON.stringify(step)}`);

  const onUncaught = (err: Error): void => {
    write("uncaughtException", `last_step=${JSON.stringify(activeLastStep)} message=${JSON.stringify(err.message)} stack=${JSON.stringify(err.stack ?? "")}`);
    runActiveClaimFinalizer();
  };
  const onUnhandled = (reason: unknown): void => {
    const r = reason instanceof Error
      ? `message=${JSON.stringify(reason.message)} stack=${JSON.stringify(reason.stack ?? "")}`
      : `value=${JSON.stringify(reason)}`;
    write("unhandledRejection", `last_step=${JSON.stringify(activeLastStep)} ${r}`);
    runActiveClaimFinalizer();
  };
  const onSigTerm = (): void => {
    write("SIGTERM", `last_step=${JSON.stringify(activeLastStep)} received`);
    runActiveClaimFinalizer();
  };
  const onSigInt = (): void => {
    write("SIGINT", `last_step=${JSON.stringify(activeLastStep)} received`);
    runActiveClaimFinalizer();
  };
  const onSigHup = (): void => {
    write("SIGHUP", `last_step=${JSON.stringify(activeLastStep)} received`);
    runActiveClaimFinalizer();
  };
  const onExit = (code: number | null): void => {
    // The exit handler is best-effort: a process is already on its way out
    // when this fires, so we use the synchronous file write and accept that
    // a hard kill may skip it. The other handlers above are the durable
    // signal; this one is the "we made it to a clean exit code N" notice.
    write("exit", `last_step=${JSON.stringify(activeLastStep)} code=${code ?? "null"}`);
  };
  // The heartbeat is the SIGKILL counter-measure: a SIGKILL/OOM death fires no
  // handler, so the only forensic trace is "installed + heartbeats, then
  // silence". Each beat carries the current RSS so a reader can see memory
  // climbing toward the OOM wall before the silence.
  const onHeartbeat = (): void => {
    const rssMb = Math.round(process.memoryUsage().rss / (1024 * 1024));
    write("alive", `last_step=${JSON.stringify(activeLastStep)} rss_mb=${rssMb}`);
  };

  process.on("uncaughtException", onUncaught);
  process.on("unhandledRejection", onUnhandled);
  process.on("SIGTERM", onSigTerm);
  process.on("SIGINT", onSigInt);
  process.on("SIGHUP", onSigHup);
  process.on("exit", onExit);

  write("installed", `last_step=${JSON.stringify(activeLastStep)} node=${process.version} platform=${process.platform}`);

  let timer: { unref?: () => void } | null = null;
  if (heartbeatMs > 0) {
    timer = setIntervalFn(onHeartbeat, heartbeatMs);
    // Never let the heartbeat alone keep the process alive.
    timer.unref?.();
  }

  activeSafety = {
    uninstall(): void {
      process.off("uncaughtException", onUncaught);
      process.off("unhandledRejection", onUnhandled);
      process.off("SIGTERM", onSigTerm);
      process.off("SIGINT", onSigInt);
      process.off("SIGHUP", onSigHup);
      process.off("exit", onExit);
      if (timer) clearIntervalFn(timer);
      timer = null;
      activeClaimFinalizer = null;
      activeStepWriter = null;
      activeLastStep = "startup";
      activeSafety = null;
    },
    handlers: {
      uncaughtException: onUncaught,
      unhandledRejection: onUnhandled,
      sigTerm: onSigTerm,
      sigInt: onSigInt,
      sigHup: onSigHup,
      exit: onExit,
      heartbeat: onHeartbeat,
    },
  };
  return activeSafety;
}

/** Build the canonical safety-log path for a worker: `.red/tmp/diagnostics/
 * <worker-id>.log`. The diagnostics dir is gitignored. */
export function safetyLogPath(redTmpDir: string, workerId: string): string {
  return join(redTmpDir, "diagnostics", `${workerId}.log`);
}

/**
 * Classify a worker's fate from its diagnostic log CONTENT (pure — the caller
 * reads the file). This is the half that closes the SIGKILL blind spot: a
 * terminal line (exit/signal/uncaught) means the death was caught and named;
 * its ABSENCE after `installed` + `alive` heartbeats means the process died
 * UNCATCHABLY — almost always SIGKILL/OOM — and the last `alive` line pins the
 * approximate time of death.
 *
 * Precedence (first match wins, scanning the whole log):
 *   1. `event=exit`               → clean-exit (the process reached an exit code)
 *   2. `event=SIG*`               → signal (a catchable signal was delivered)
 *   3. `event=uncaughtException` / `event=unhandledRejection` → uncaught
 *   4. `event=installed` present, none of the above → uncatchable
 *      (SIGKILL/OOM), carrying the last `event=alive` line if any
 *   5. no `event=installed`       → unknown (not a safety log)
 *
 * NOTE: a still-RUNNING worker also has no terminal line. This classifier is
 * for a worker KNOWN to be gone (its pid is absent / its claim went stale) —
 * the caller establishes death; this names the cause. When liveness is unknown
 * the `uncatchable` verdict should be read as "no clean shutdown was recorded".
 */
export function classifyDeathFromLog(logContent: string): DeathClass {
  const lines = logContent.split("\n").filter((l) => l.trim() !== "");
  let installed = false;
  let lastAlive: string | null = null;
  for (const line of lines) {
    if (line.includes("event=installed")) installed = true;
    if (line.includes("event=alive")) lastAlive = line;
    if (line.includes("event=exit")) {
      const m = /code=(\S+)/.exec(line);
      return { kind: "clean-exit", code: m?.[1] ?? "unknown" };
    }
    if (line.includes("event=SIGTERM") || line.includes("event=SIGINT") || line.includes("event=SIGHUP")) {
      const m = /event=(SIG\w+)/.exec(line);
      return { kind: "signal", signal: m?.[1] ?? "SIG?" };
    }
    if (line.includes("event=uncaughtException") || line.includes("event=unhandledRejection")) {
      return { kind: "uncaught", detail: line };
    }
  }
  if (!installed) return { kind: "unknown" };
  return { kind: "uncatchable", lastAliveLine: lastAlive };
}

/**
 * Read a worker's diagnostic log from disk and classify its fate. Returns
 * `{ kind: "unknown" }` when the file is absent / unreadable (treated the same
 * as "no safety log"). Best-effort — a read failure never throws.
 */
export function classifyDeathFromLogFile(path: string): DeathClass {
  try {
    return classifyDeathFromLog(readFileSync(path, "utf8"));
  } catch {
    return { kind: "unknown" };
  }
}

/** A one-line human summary of a {@link DeathClass}, for the next session's
 * iteration log / a worker's re-claim comment. */
export function describeDeath(d: DeathClass): string {
  switch (d.kind) {
    case "running":
      return "no terminal record (worker may still be running)";
    case "clean-exit":
      return `clean exit (code ${d.code})`;
    case "signal":
      return `terminated by ${d.signal}`;
    case "uncaught":
      return `uncaught error: ${d.detail}`;
    case "uncatchable":
      return d.lastAliveLine
        ? `uncatchable death (likely SIGKILL/OOM) — no clean shutdown recorded; last heartbeat: ${d.lastAliveLine}`
        : "uncatchable death (likely SIGKILL/OOM) — no clean shutdown recorded, no heartbeat captured";
    case "unknown":
      return "no diagnostic log (cause unknown)";
  }
}

/** Split a `host:worker_id` claim identity into its parts. A bare id (no `:`)
 * has an empty host. Only the FIRST `:` splits — a worker id never contains one,
 * but a host theoretically could, so the worker is everything after the first. */
export function splitClaimIdentity(fullId: string): { host: string; worker: string } {
  const idx = fullId.indexOf(":");
  if (idx < 0) return { host: "", worker: fullId };
  return { host: fullId.slice(0, idx), worker: fullId.slice(idx + 1) };
}

/**
 * Resolve the death cause of a recovered stale-claim owner for the cross-host
 * recovery audit comment — the CONSUMER that makes the diagnostic actionable.
 *
 * Cross-host caveat: a worker that died on ANOTHER host left its diagnostic log
 * on that host's filesystem, unreadable from here. So this only resolves a
 * cause when the recovered owner ran on the SAME host as `self` (same `host:`
 * prefix); a different host returns null (the comment then omits the cause, as
 * before). Returns null too when the log is absent / classifies as
 * `running`/`unknown` (nothing useful to say). Best-effort — never throws.
 */
export function deathCauseForRecoveredWorker(
  redTmpDir: string,
  recoveredFullId: string,
  selfFullId: string,
): string | null {
  const recovered = splitClaimIdentity(recoveredFullId);
  const self = splitClaimIdentity(selfFullId);
  // Cross-host: the predecessor's log isn't on this filesystem.
  if (recovered.host !== self.host) return null;
  const verdict = classifyDeathFromLogFile(safetyLogPath(redTmpDir, recovered.worker));
  if (verdict.kind === "unknown" || verdict.kind === "running") return null;
  return describeDeath(verdict);
}
