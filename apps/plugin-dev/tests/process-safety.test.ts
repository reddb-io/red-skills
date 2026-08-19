import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  classifyDeathFromLog,
  classifyDeathFromLogFile,
  deathCauseForRecoveredWorker,
  describeDeath,
  fileSafetyLogger,
  getActiveSafety,
  installProcessSafety,
  markProcessSafetyStep,
  noopSafetyLogger,
  safetyLogPath,
  setActiveClaimFinalizer,
  splitClaimIdentity,
  type SafetyLogger,
} from "../src/core/process-safety.js";

// AFK runner improvement — Pattern 5 diagnostic: every spike worker died
// post-commit + vitest with no exit code / signal / stack trace. process-safety
// is the forensic recorder: it installs process-level handlers and writes one
// line per fatal event to a logger (file in production, in-memory in tests).
// The tests assert: (a) the install/uninstall lifecycle is well-behaved,
// (b) every event type produces the right log line, (c) uninstall detaches,
// (d) fileSafetyLogger writes one line per call, (e) safetyLogPath builds the
// canonical path.
//
// Tests call `safety.handlers.<event>(...)` directly instead of
// `process.emit(...)` so vitest's own global uncaughtException listener
// doesn't intercept the synthetic event (which would fail the test even
// though our handler did its job). In production the handlers are wired
// via process.on(...); the exposed `handlers` field is the unit-test seam.

describe("installProcessSafety — install/uninstall lifecycle", () => {
  it("install returns a ProcessSafety with an `uninstall` method + a `handlers` object", () => {
    const log: string[] = [];
    const logger: SafetyLogger = { log: (l) => log.push(l) };
    const safety = installProcessSafety(logger, { workerId: "wTEST", pid: 12345, heartbeatMs: 0 });
    expect(typeof safety.uninstall).toBe("function");
    expect(typeof safety.handlers.uncaughtException).toBe("function");
    expect(typeof safety.handlers.unhandledRejection).toBe("function");
    expect(typeof safety.handlers.sigTerm).toBe("function");
    expect(typeof safety.handlers.sigInt).toBe("function");
    expect(typeof safety.handlers.sigHup).toBe("function");
    expect(typeof safety.handlers.exit).toBe("function");
    safety.uninstall();
  });

  it("after uninstall, getActiveSafety returns null (handlers are detached)", () => {
    const log: string[] = [];
    const safety = installProcessSafety({ log: (l) => log.push(l) }, { workerId: "wTEST", heartbeatMs: 0 });
    expect(getActiveSafety()).not.toBeNull();
    safety.uninstall();
    expect(getActiveSafety()).toBeNull();
  });

  it("a second install uninstalls the first (idempotent singleton)", () => {
    const log1: string[] = [];
    const log2: string[] = [];
    const first = installProcessSafety({ log: (l) => log1.push(l) }, { workerId: "wFIRST", heartbeatMs: 0 });
    const second = installProcessSafety({ log: (l) => log2.push(l) }, { workerId: "wSECOND", heartbeatMs: 0 });
    expect(getActiveSafety()).toBe(second);
    second.uninstall();
    // first.uninstall() is now a no-op (it was already detached by the second install)
    expect(() => first.uninstall()).not.toThrow();
  });
});

describe("installProcessSafety — event log lines (via direct handler call)", () => {
  let log: string[];
  let handlers: {
    uncaughtException(err: Error): void;
    unhandledRejection(reason: unknown): void;
    sigTerm(): void;
    sigInt(): void;
    sigHup(): void;
    exit(code: number | null): void;
  };
  let uninstall: () => void;
  beforeEach(() => {
    log = [];
    const safety = installProcessSafety({ log: (l) => log.push(l) }, { workerId: "wDIAG", pid: 999, heartbeatMs: 0 });
    handlers = safety.handlers;
    uninstall = safety.uninstall;
  });
  afterEach(() => {
    uninstall();
  });

  it("emits an `installed` line on install (with node version + platform)", () => {
    // The install log line is emitted during `installProcessSafety`, so it's
    // already in `log` by the time the test runs.
    const installed = log.find((l) => l.includes("event=installed"));
    expect(installed).toBeDefined();
    expect(installed).toMatch(/pid=999/);
    expect(installed).toMatch(/worker=wDIAG/);
    expect(installed).toMatch(/node=v\d+\.\d+\.\d+/);
    expect(installed).toMatch(/platform=/);
  });

  it("uncaughtException handler records message + stack", () => {
    handlers.uncaughtException(new Error("simulated boom"));
    const line = log.find((l) => l.includes("event=uncaughtException"));
    expect(line).toBeDefined();
    expect(line).toMatch(/message="simulated boom"/);
    expect(line).toMatch(/stack=/);
  });

  it("unhandledRejection handler records a string reason", () => {
    handlers.unhandledRejection("just a string, not an Error");
    const line = log.find((l) => l.includes("event=unhandledRejection"));
    expect(line).toBeDefined();
    expect(line).toMatch(/value="just a string, not an Error"/);
  });

  it("unhandledRejection handler records an Error reason (message + stack)", () => {
    handlers.unhandledRejection(new Error("rejected!"));
    const line = log.find((l) => l.includes("event=unhandledRejection"));
    expect(line).toBeDefined();
    expect(line).toMatch(/message="rejected!"/);
    expect(line).toMatch(/stack=/);
  });

  it("SIGTERM handler records the signal name", () => {
    handlers.sigTerm();
    const line = log.find((l) => l.includes("event=SIGTERM"));
    expect(line).toBeDefined();
    expect(line).toMatch(/received/);
  });

  it("SIGTERM handler invokes the active claim finalizer once", () => {
    let calls = 0;
    setActiveClaimFinalizer(() => {
      calls += 1;
    });
    handlers.sigTerm();
    handlers.sigTerm();
    expect(calls).toBe(1);
  });

  it("SIGINT handler records the signal name", () => {
    handlers.sigInt();
    const line = log.find((l) => l.includes("event=SIGINT"));
    expect(line).toBeDefined();
  });

  it("uncaughtException handler invokes the active claim finalizer", () => {
    let calls = 0;
    setActiveClaimFinalizer(() => {
      calls += 1;
    });
    handlers.uncaughtException(new Error("simulated boom"));
    expect(calls).toBe(1);
  });

  it("SIGHUP handler records the signal name", () => {
    handlers.sigHup();
    const line = log.find((l) => l.includes("event=SIGHUP"));
    expect(line).toBeDefined();
  });

  it("exit handler records the exit code", () => {
    handlers.exit(0);
    const line = log.find((l) => l.includes("event=exit"));
    expect(line).toBeDefined();
    expect(line).toMatch(/code=0/);
  });

  it("records the last AFK step on catchable death receipts", () => {
    markProcessSafetyStep("post-agent:feedback-start");
    handlers.sigHup();
    const line = log.find((l) => l.includes("event=SIGHUP"));
    expect(line).toContain('last_step="post-agent:feedback-start"');
  });

  it("exit handler records null exit code (process killed by signal)", () => {
    handlers.exit(null);
    const line = log.find((l) => l.includes("event=exit"));
    expect(line).toMatch(/code=null/);
  });
});

describe("installProcessSafety — handlers detach on uninstall", () => {
  it("after uninstall, the handlers object is still callable (they don't crash) but no process event fires", () => {
    // After uninstall, the handlers object remains valid (for tests that
    // captured the reference) but `process.on('uncaughtException', ...)` is
    // detached, so a real process event will not invoke them. We assert
    // here that uninstall() does not throw and does not break the bundle.
    const log: string[] = [];
    const safety = installProcessSafety({ log: (l) => log.push(l) }, { workerId: "wTEST", heartbeatMs: 0 });
    safety.uninstall();
    // The bundle remains a valid object reference; uninstall is idempotent.
    expect(() => safety.uninstall()).not.toThrow();
  });
});

describe("fileSafetyLogger — append-only file writes", () => {
  it("writes one line per call, with an ISO timestamp prefix", async () => {
    const { mkdtemp, readFile, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = await mkdtemp(join(tmpdir(), "afk-safety-"));
    const path = join(dir, "safety.log");
    const logger = fileSafetyLogger(path);
    logger.log("first line");
    logger.log("second line");
    const content = await readFile(path, "utf8");
    const lines = content.trimEnd().split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z /);
    expect(lines[0]).toContain("first line");
    expect(lines[1]).toContain("second line");
    await rm(dir, { recursive: true, force: true });
  });

  it("swallows IO errors (a broken logger must never break the death handler)", async () => {
    const { join } = await import("node:path");
    const logger = fileSafetyLogger(join("/this-path-does-not-exist-for-safety-test", "x", "y.log"));
    expect(() => logger.log("ignored")).not.toThrow();
  });
});

describe("noopSafetyLogger", () => {
  it("exists and is a no-op (the contract for callers that don't want a file)", () => {
    expect(typeof noopSafetyLogger.log).toBe("function");
    expect(() => noopSafetyLogger.log("anything")).not.toThrow();
  });
});

describe("safetyLogPath", () => {
  it("builds the canonical `.red/tmp/diagnostics/<id>.log` path", async () => {
    const { join } = await import("node:path");
    expect(safetyLogPath("/repo/.red/tmp", "wABCD")).toBe(join("/repo/.red/tmp", "diagnostics", "wABCD.log"));
  });
});

describe("installProcessSafety — cost & integration", () => {
  it("installing twice in a row does not throw (idempotent under quick re-install)", () => {
    const safety1 = installProcessSafety(noopSafetyLogger, { workerId: "wA", heartbeatMs: 0 });
    const safety2 = installProcessSafety(noopSafetyLogger, { workerId: "wB", heartbeatMs: 0 });
    expect(safety2).not.toBe(safety1);
    safety1.uninstall(); // no-op (already detached)
    safety2.uninstall();
    expect(getActiveSafety()).toBeNull();
  });
});

// AFK runner improvement — the liveness heartbeat closes the SIGKILL blind
// spot: a SIGKILL/OOM death fires no handler, so the only trace is "installed
// + heartbeats, then silence". The heartbeat writes an `alive` line carrying
// RSS; the injected timer keeps the test free of real intervals.
describe("installProcessSafety — liveness heartbeat", () => {
  it("registers the injected interval and writes an `alive` line carrying rss_mb", () => {
    const log: string[] = [];
    let captured: (() => void) | null = null;
    const safety = installProcessSafety(
      { log: (l) => log.push(l) },
      {
        workerId: "wHB",
        heartbeatMs: 15000,
        setInterval: (fn) => {
          captured = fn;
          return { unref: () => {} };
        },
        clearInterval: () => {},
      },
    );
    // The timer was registered (the factory captured the callback).
    expect(captured).not.toBeNull();
    // Drive one beat.
    captured!();
    const alive = log.find((l) => l.includes("event=alive"));
    expect(alive).toBeDefined();
    expect(alive).toMatch(/rss_mb=\d+/);
    expect(alive).toMatch(/worker=wHB/);
    safety.uninstall();
  });

  it("heartbeatMs=0 disables the timer entirely (no interval registered)", () => {
    let registered = false;
    const safety = installProcessSafety(noopSafetyLogger, {
      workerId: "wNoHB",
      heartbeatMs: 0,
      setInterval: () => {
        registered = true;
        return { unref: () => {} };
      },
    });
    expect(registered).toBe(false);
    safety.uninstall();
  });

  it("uninstall clears the injected interval", () => {
    let cleared = false;
    const handle = { unref: () => {} };
    const safety = installProcessSafety(noopSafetyLogger, {
      workerId: "wClear",
      heartbeatMs: 15000,
      setInterval: () => handle,
      clearInterval: (h) => {
        if (h === handle) cleared = true;
      },
    });
    safety.uninstall();
    expect(cleared).toBe(true);
  });
});

// classifyDeathFromLog is the reader half: it names a dead worker's cause from
// its diagnostic log, including the UNCATCHABLE (SIGKILL/OOM) case the handlers
// can't see — the absence of a terminal line after `installed` + `alive`.
describe("classifyDeathFromLog — fate from the diagnostic log", () => {
  const inst = "2026-06-21T19:00:00.000Z pid=1 worker=wX event=installed node=v22 platform=linux";
  const alive1 = "2026-06-21T19:00:15.000Z pid=1 worker=wX event=alive rss_mb=512";
  const alive2 = "2026-06-21T19:00:30.000Z pid=1 worker=wX event=alive rss_mb=1900";

  it("clean exit wins (a terminal exit line was recorded)", () => {
    const log = [inst, alive1, "...event=exit code=0"].join("\n");
    expect(classifyDeathFromLog(log)).toEqual({ kind: "clean-exit", code: "0" });
  });

  it("a catchable signal is named", () => {
    const log = [inst, alive1, "...event=SIGTERM received"].join("\n");
    expect(classifyDeathFromLog(log)).toEqual({ kind: "signal", signal: "SIGTERM" });
  });

  it("an uncaught error is named", () => {
    const log = [inst, "...event=uncaughtException message=\"boom\""].join("\n");
    expect(classifyDeathFromLog(log)).toMatchObject({ kind: "uncaught" });
  });

  it("UNCATCHABLE: installed + heartbeats but NO terminal line → SIGKILL/OOM, pinned to the last heartbeat", () => {
    const log = [inst, alive1, alive2].join("\n");
    const result = classifyDeathFromLog(log);
    expect(result.kind).toBe("uncatchable");
    if (result.kind === "uncatchable") {
      expect(result.lastAliveLine).toBe(alive2); // the LAST heartbeat — climbing rss
    }
  });

  it("UNCATCHABLE with no heartbeat captured (died before the first beat)", () => {
    const result = classifyDeathFromLog(inst);
    expect(result).toEqual({ kind: "uncatchable", lastAliveLine: null });
  });

  it("no `installed` line → unknown (not a safety log)", () => {
    expect(classifyDeathFromLog("random unrelated content")).toEqual({ kind: "unknown" });
    expect(classifyDeathFromLog("")).toEqual({ kind: "unknown" });
  });

  it("classifyDeathFromLogFile returns unknown for a missing file (best-effort, no throw)", () => {
    expect(classifyDeathFromLogFile("/no/such/diagnostics/wZ.log")).toEqual({ kind: "unknown" });
  });
});

describe("describeDeath — one-line human summary", () => {
  it("summarizes each death class for the next session's log", () => {
    expect(describeDeath({ kind: "clean-exit", code: "0" })).toContain("clean exit");
    expect(describeDeath({ kind: "signal", signal: "SIGTERM" })).toContain("SIGTERM");
    expect(describeDeath({ kind: "uncaught", detail: "x" })).toContain("uncaught");
    expect(describeDeath({ kind: "uncatchable", lastAliveLine: "...rss_mb=1900" })).toContain("SIGKILL/OOM");
    expect(describeDeath({ kind: "uncatchable", lastAliveLine: null })).toContain("no heartbeat");
    expect(describeDeath({ kind: "unknown" })).toContain("no diagnostic log");
  });
});

describe("splitClaimIdentity", () => {
  it("splits host:worker on the first colon", () => {
    expect(splitClaimIdentity("cyber-XPS:wABCD")).toEqual({ host: "cyber-XPS", worker: "wABCD" });
  });
  it("a bare id (no colon) has an empty host", () => {
    expect(splitClaimIdentity("wABCD")).toEqual({ host: "", worker: "wABCD" });
  });
  it("splits only on the FIRST colon (a host may contain more)", () => {
    expect(splitClaimIdentity("h:o:st:wX")).toEqual({ host: "h", worker: "o:st:wX" });
  });
});

// deathCauseForRecoveredWorker is the consumer that makes the diagnostic
// actionable — it resolves a recovered SAME-HOST predecessor's cause from its
// log, and returns null cross-host (the log isn't on this filesystem).
describe("deathCauseForRecoveredWorker", () => {
  it("returns null for a cross-host predecessor (its log is on another machine)", async () => {
    const { mkdtemp, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = await mkdtemp(join(tmpdir(), "afk-death-"));
    try {
      // Different host prefix → null even though we never look at the file.
      expect(deathCauseForRecoveredWorker(dir, "otherhost:wDEAD", "myhost:wSELF")).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("returns null when the same-host predecessor left no diagnostic log", async () => {
    const { mkdtemp, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = await mkdtemp(join(tmpdir(), "afk-death-"));
    try {
      expect(deathCauseForRecoveredWorker(dir, "myhost:wDEAD", "myhost:wSELF")).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("resolves the cause for a same-host predecessor with an uncatchable-death log", async () => {
    const { mkdtemp, mkdir, writeFile, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = await mkdtemp(join(tmpdir(), "afk-death-"));
    try {
      // Write a diagnostic log for wDEAD at the canonical path: installed +
      // heartbeats, no terminal line → uncatchable.
      await mkdir(join(dir, "diagnostics"), { recursive: true });
      await writeFile(
        safetyLogPath(dir, "wDEAD"),
        ["T0 ...event=installed node=v22", "T1 ...event=alive rss_mb=1800"].join("\n"),
      );
      const cause = deathCauseForRecoveredWorker(dir, "myhost:wDEAD", "myhost:wSELF");
      expect(cause).not.toBeNull();
      expect(cause).toContain("SIGKILL/OOM");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("returns null when the same-host predecessor exited cleanly... no — surfaces it (a clean exit is a real cause)", async () => {
    const { mkdtemp, mkdir, writeFile, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = await mkdtemp(join(tmpdir(), "afk-death-"));
    try {
      await mkdir(join(dir, "diagnostics"), { recursive: true });
      await writeFile(safetyLogPath(dir, "wDEAD"), ["T0 ...event=installed", "T1 ...event=exit code=0"].join("\n"));
      const cause = deathCauseForRecoveredWorker(dir, "myhost:wDEAD", "myhost:wSELF");
      // A recorded clean exit IS a useful cause — surface it.
      expect(cause).toContain("clean exit");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
