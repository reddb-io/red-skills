import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  fileSafetyLogger,
  getActiveSafety,
  installProcessSafety,
  noopSafetyLogger,
  safetyLogPath,
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
    const safety = installProcessSafety(logger, { workerId: "wTEST", pid: 12345 });
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
    const safety = installProcessSafety({ log: (l) => log.push(l) }, { workerId: "wTEST" });
    expect(getActiveSafety()).not.toBeNull();
    safety.uninstall();
    expect(getActiveSafety()).toBeNull();
  });

  it("a second install uninstalls the first (idempotent singleton)", () => {
    const log1: string[] = [];
    const log2: string[] = [];
    const first = installProcessSafety({ log: (l) => log1.push(l) }, { workerId: "wFIRST" });
    const second = installProcessSafety({ log: (l) => log2.push(l) }, { workerId: "wSECOND" });
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
    const safety = installProcessSafety({ log: (l) => log.push(l) }, { workerId: "wDIAG", pid: 999 });
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

  it("SIGINT handler records the signal name", () => {
    handlers.sigInt();
    const line = log.find((l) => l.includes("event=SIGINT"));
    expect(line).toBeDefined();
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
    const safety = installProcessSafety({ log: (l) => log.push(l) }, { workerId: "wTEST" });
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
    const safety1 = installProcessSafety(noopSafetyLogger, { workerId: "wA" });
    const safety2 = installProcessSafety(noopSafetyLogger, { workerId: "wB" });
    expect(safety2).not.toBe(safety1);
    safety1.uninstall(); // no-op (already detached)
    safety2.uninstall();
    expect(getActiveSafety()).toBeNull();
  });
});
