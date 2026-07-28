import { spawn } from "node:child_process";
import { appendTelemetryEventSync } from "../telemetry.js";
import type { ParsedArgs } from "./types.js";

export async function runControlHoldout(args: ParsedArgs, telemetryRoot: string, holdoutShare: number): Promise<number> {
  const started = process.hrtime.bigint();
  const result = await passthroughCaptured(args.positional);
  const wrapperMs = Number(process.hrtime.bigint() - started) / 1_000_000;
  appendControlHoldoutTelemetry(telemetryRoot, args, result, wrapperMs, holdoutShare);
  if (result.signal) {
    process.kill(process.pid, result.signal);
    return 128;
  }
  return result.status ?? 0;
}

export async function passthroughCaptured(argv: readonly string[]): Promise<{
  stdoutBytes: number;
  stderrBytes: number;
  status: number | null;
  signal: NodeJS.Signals | null;
}> {
  const command = argv[0];
  if (!command) return { stdoutBytes: 0, stderrBytes: 0, status: 2, signal: null };
  let child;
  if (command === "exec" || command === "proxy") {
    const commandLine = command === "proxy"
      ? await import("../proxy.js").then((module) => module.parseProxyCommandLine(argv))
      : await import("../exec-wrapper.js").then((module) => module.parseExecCommandLine(argv));
    child = spawn(commandLine, { shell: true, stdio: ["inherit", "pipe", "pipe"] });
  } else {
    child = spawn(command, argv.slice(1), { stdio: ["inherit", "pipe", "pipe"] });
  }
  let stdoutBytes = 0;
  let stderrBytes = 0;
  child.stdout?.on("data", (chunk: Buffer) => {
    stdoutBytes += chunk.length;
    process.stdout.write(chunk);
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    stderrBytes += chunk.length;
    process.stderr.write(chunk);
  });
  return await new Promise((resolve) => {
    child.on("error", (err) => {
      const text = `${err instanceof Error ? err.message : String(err)}\n`;
      stderrBytes += Buffer.byteLength(text);
      process.stderr.write(text);
      resolve({ stdoutBytes, stderrBytes, status: 127, signal: null });
    });
    child.on("close", (status, signal) => resolve({ stdoutBytes, stderrBytes, status, signal }));
  });
}

export function shouldUseControlHoldout(share: number): boolean {
  return share > 0 && Math.random() < share;
}

export async function degradeToPassthrough(
  reason: string,
  argv: readonly string[],
  err?: unknown,
  telemetryRoot?: string,
): Promise<number> {
  if (process.env.RSP_DEBUG === "1") {
    throw err instanceof Error ? err : new Error(reason);
  }
  process.stderr.write(`rsp: ${reason}, passing through\n`);
  const status = await passthrough(argv);
  if (telemetryRoot) {
    const failure = wrapperFailureIdentity(reason, argv, err);
    const {
      appendTelemetryEvent,
      RSP_ACCOUNTING_EVENTS_COLLECTION,
      RSP_TELEMETRY_DEGRADATIONS_COLLECTION,
    } = await import("../telemetry.js");
    fireAndForget(appendTelemetryEvent(telemetryRoot, {
      collection: RSP_ACCOUNTING_EVENTS_COLLECTION,
      event_type: "invocation",
      ts: new Date().toISOString(),
      command: passthroughTelemetryCommand(argv),
      command_class: argv[0] ?? "unknown",
      loss: "lossless",
      raw_bytes: 0,
      emitted_bytes: 0,
      degradation_reason: failure.reason,
      wrapper_family: failure.family,
      wrapper_exit_code: failure.exitCode,
      stderr_head: failure.stderrHead,
    }));
    fireAndForget(appendTelemetryEvent(telemetryRoot, {
      collection: RSP_TELEMETRY_DEGRADATIONS_COLLECTION,
      ts: new Date().toISOString(),
      command: passthroughTelemetryCommand(argv),
      reason: failure.reason,
      wrapper_family: failure.family,
      wrapper_exit_code: failure.exitCode,
      stderr_head: failure.stderrHead,
      accounting_recorded: true,
    }));
  }
  return status;
}

/**
 * Run a self-disabled wrapper family as the raw command (#2746).
 *
 * Self-disabling is a fail-open, not a failure: stdout and stderr are forwarded
 * byte for byte and the exit status is the command's own. The reason lives in
 * the ledger `rsp status` reads, never in the command's own streams.
 */
export async function passthroughSelfDisabled(
  argv: readonly string[],
  telemetryRoot: string,
  state: { family: string; disabled_reason: string | null; reasons: string[] },
): Promise<number> {
  const result = await passthroughCaptured(argv);
  const {
    appendTelemetryEvent,
    RSP_ACCOUNTING_EVENTS_COLLECTION,
    RSP_TELEMETRY_DEGRADATIONS_COLLECTION,
  } = await import("../telemetry.js");
  const degradation = {
    ts: new Date().toISOString(),
    command: passthroughTelemetryCommand(argv),
    reason: "overhead-ceiling-self-disabled",
    wrapper_family: state.family,
    wrapper_exit_code: result.status ?? 0,
    stderr_head: state.disabled_reason ?? state.reasons.join(","),
  };
  fireAndForget(appendTelemetryEvent(telemetryRoot, {
    collection: RSP_ACCOUNTING_EVENTS_COLLECTION,
    event_type: "invocation",
    command_class: argv[0] ?? "unknown",
    loss: "lossless",
    raw_bytes: result.stdoutBytes + result.stderrBytes,
    emitted_bytes: result.stdoutBytes + result.stderrBytes,
    degradation_reason: degradation.reason,
    ...degradation,
  }));
  fireAndForget(appendTelemetryEvent(telemetryRoot, {
    collection: RSP_TELEMETRY_DEGRADATIONS_COLLECTION,
    accounting_recorded: true,
    ...degradation,
  }));
  if (result.signal) {
    process.kill(process.pid, result.signal);
    return 128;
  }
  return result.status ?? 0;
}

export async function passthroughDisabledDirectory(argv: readonly string[]): Promise<number> {
  if (process.env.RSP_DEBUG === "1") {
    process.stderr.write(`rsp: ${rspDisabledReason()}, passing through\n`);
  }
  return await passthrough(argv);
}

export function rspDisabledReason(): string {
  return "rsp is not enabled in this directory; run /red-setup";
}

export function isWrapperCommand(command: string | undefined): boolean {
  return command === "git" || command === "gh" || command === "vitest" || command === "cargo" || command === "cat" ||
    command === "exec" || command === "proxy" || command === "gh-api-json";
}

export function telemetryCommand(args: ParsedArgs): string {
  return passthroughTelemetryCommand(args.positional);
}

export function passthroughTelemetryCommand(argv: readonly string[]): string {
  if (argv[0] !== "exec") return argv.join(" ");
  try {
    const separator = argv.indexOf("--");
    const parts = separator >= 0 ? argv.slice(separator + 1) : argv.slice(1);
    return parts.length === 1 ? parts[0]! : parts.join(" ");
  } catch {
    return argv.join(" ");
  }
}

export function firstLine(text: string): string {
  return text.split(/\r?\n/, 1)[0]?.trim() ?? "";
}

function appendControlHoldoutTelemetry(
  telemetryRoot: string,
  args: ParsedArgs,
  result: { stdoutBytes: number; stderrBytes: number },
  wrapperMs: number,
  holdoutShare: number,
): void {
  const bytes = result.stdoutBytes + result.stderrBytes;
  const event = {
    event_type: "control_holdout",
    control_holdout: true,
    holdout_share: holdoutShare,
    ts: new Date().toISOString(),
    command: telemetryCommand(args),
    command_class: args.command ?? "unknown",
    wrapper: args.command,
    loss: "lossless",
    elided: false,
    raw_bytes: bytes,
    emitted_bytes: bytes,
    wrapper_ms: wrapperMs,
  };
  appendTelemetryEventSync(telemetryRoot, {
    collection: "rsp_accounting_events_v1",
    ...event,
  });
  appendTelemetryEventSync(telemetryRoot, {
    collection: "rsp_telemetry_invocations_v1",
    ...event,
    accounting_recorded: true,
  });
}

function wrapperFailureIdentity(
  fallbackReason: string,
  argv: readonly string[],
  err: unknown,
): { reason: string; family: string; exitCode: number; stderrHead: string } {
  const family = argv[0] ?? "unknown";
  const stderrHead = firstDiagnosticLine(err) || fallbackReason;
  const unavailable = errorCode(err) === "ENOENT" ||
    errorCode(err) === "MODULE_NOT_FOUND" ||
    /(?:command not found|cannot find package|cannot find module|module not found|not provisioned)/i.test(stderrHead);
  return {
    reason: unavailable ? "wrapper-unavailable" : "wrapper-crash",
    family,
    exitCode: numericErrorStatus(err) ?? 1,
    stderrHead: truncateOneLine(stderrHead, 240),
  };
}

function firstDiagnosticLine(err: unknown): string {
  if (err instanceof Error) return firstLine(err.message);
  return firstLine(String(err ?? ""));
}

function truncateOneLine(text: string, maxChars: number): string {
  const line = firstLine(text).replace(/\s+/g, " ").trim();
  if (line.length <= maxChars) return line;
  return `${line.slice(0, Math.max(0, maxChars - 1))}…`;
}

function errorCode(err: unknown): string {
  if (typeof err !== "object" || err === null || !("code" in err)) return "";
  const code = (err as { code?: unknown }).code;
  return typeof code === "string" ? code : "";
}

function numericErrorStatus(err: unknown): number | null {
  if (typeof err !== "object" || err === null) return null;
  for (const key of ["status", "exitCode", "exit_code"]) {
    const value = (err as Record<string, unknown>)[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return null;
}

function fireAndForget(promise: Promise<unknown>): void {
  promise.catch(() => undefined);
}

async function passthrough(argv: readonly string[]): Promise<number> {
  if (argv[0] === "exec" || argv[0] === "proxy") return await passthroughShell(argv);
  const command = argv[0];
  if (!command) return 2;
  const child = spawn(command, argv.slice(1), { stdio: "inherit" });
  return await new Promise((resolve) => {
    child.on("error", (err) => {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
      resolve(127);
    });
    child.on("close", (status, signal) => {
      if (signal) {
        process.kill(process.pid, signal);
        resolve(128);
        return;
      }
      resolve(status ?? 0);
    });
  });
}

async function passthroughShell(argv: readonly string[]): Promise<number> {
  let commandLine: string;
  try {
    if (argv[0] === "proxy") {
      const { parseProxyCommandLine } = await import("../proxy.js");
      commandLine = parseProxyCommandLine(argv);
    } else {
      const { parseExecCommandLine } = await import("../exec-wrapper.js");
      commandLine = parseExecCommandLine(argv);
    }
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    return 2;
  }
  const child = spawn(commandLine, { shell: true, stdio: "inherit" });
  return await new Promise((resolve) => {
    child.on("error", (err) => {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
      resolve(127);
    });
    child.on("close", (status, signal) => {
      if (signal) {
        process.kill(process.pid, signal);
        resolve(128);
        return;
      }
      resolve(status ?? 0);
    });
  });
}
