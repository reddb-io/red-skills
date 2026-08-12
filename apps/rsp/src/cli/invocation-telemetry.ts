import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { rspStateDir } from "@reddb-io/shared/red-paths.js";
import type { RspRuntimeConfig } from "../config.js";
import {
  DEFAULT_RSP_OVERHEAD_CEILING,
  noteSelfStateBytesRead,
  overheadCounters,
  overheadTelemetryFields,
  recordOverheadSample,
  type RspOverheadCeiling,
  type RspOverheadSample,
} from "../overhead-budget.js";
import type { ResidentResponseMetrics } from "../resident-client.js";
import { appendTelemetryEventSync, telemetrySpoolPath } from "../telemetry.js";
import { telemetryCommand } from "./passthrough.js";
import type { InvocationTelemetryStore, ParsedArgs, WrappedCommandResult } from "./types.js";

export async function emitWrappedResult(
  args: ParsedArgs,
  result: WrappedCommandResult,
  started: bigint,
  store?: InvocationTelemetryStore,
  telemetryRoot = process.cwd(),
  coldNudgeConfig?: RspRuntimeConfig,
  ceiling: RspOverheadCeiling = coldNudgeConfig?.overhead ?? DEFAULT_RSP_OVERHEAD_CEILING,
): Promise<number> {
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  const wrapperMs = Number(process.hrtime.bigint() - started) / 1_000_000;
  // Both sides of the ledger, on every invocation: what rsp saved, and what it
  // cost to save it (#2746). The cold-drain nudge runs first because its spool
  // probe is self-state rsp reads on this invocation's clock.
  if (store && coldNudgeConfig) nudgeColdTelemetryDrain(telemetryRoot, coldNudgeConfig);
  const overhead = invocationOverheadSample(args, result, wrapperMs);
  recordOverheadSample(telemetryRoot, overhead, ceiling);
  if (store) {
    fireAndForget(
      appendInvocationTelemetry(telemetryRoot, args, result, overhead, ceiling, store.lastResponseMetrics()),
    );
  } else {
    appendFastInvocationTelemetry(telemetryRoot, args, result, overhead, ceiling);
  }
  if (result.signal) {
    process.kill(process.pid, result.signal);
    return 128;
  }
  return result.status ?? 0;
}

/**
 * The overhead this invocation imposed, drawn from the ambient counters every
 * self-state read and every spawned child reports into.
 */
export function invocationOverheadSample(
  args: ParsedArgs,
  result: WrappedCommandResult,
  wrapperMs: number,
): RspOverheadSample {
  const counters = overheadCounters();
  const emitted = result.stdout.length + result.stderr.length;
  const raw = (result.rawOutput?.length ?? result.stdout.length) + result.stderr.length;
  return {
    family: args.command ?? "unknown",
    wrapperMs,
    childMs: counters.childMs,
    selfStateBytesRead: counters.selfStateBytesRead,
    bytesSaved: Math.max(0, raw - emitted),
  };
}

export function fireAndForget(promise: Promise<unknown>): void {
  promise.catch(() => undefined);
}

export async function appendShowAccountingEvent(
  telemetryRoot: string,
  handle: string,
  hit: boolean,
  emittedBytes: number,
): Promise<void> {
  const { appendTelemetryEvent, RSP_ACCOUNTING_EVENTS_COLLECTION } = await import("../telemetry.js");
  await appendTelemetryEvent(telemetryRoot, {
    collection: RSP_ACCOUNTING_EVENTS_COLLECTION,
    event_type: "show",
    ts: new Date().toISOString(),
    command: "rsp show",
    command_class: "show",
    handle,
    hit,
    loss: "lossless",
    raw_bytes: hit ? emittedBytes : 0,
    emitted_bytes: emittedBytes,
  });
}

function nudgeColdTelemetryDrain(telemetryRoot: string, config: RspRuntimeConfig): void {
  try {
    const spoolPath = telemetrySpoolPath(telemetryRoot);
    const stat = statSync(spoolPath);
    const staleMs = config.telemetryDrainIntervalMs * 2;
    if (stat.size < config.telemetryByteBudget && !spoolHasEventOlderThan(spoolPath, Date.now() - staleMs)) return;
    const rootDir = fastResidentRoot(telemetryRoot);
    const socketDir = fastResidentSocketDir(rootDir);
    const socketPath = join(socketDir, "rsp.sock");
    const pidPath = join(socketDir, "rsp.pid");
    const registryPath = join(rspStateDir(rootDir), "rsp-resident.pid.toon");
    const wakeLockPath = join(rootDir, ".red", "tmp", "rsp", "wake.lock");
    const child = spawn(process.execPath, [
      ...process.execArgv,
      process.argv[1] ?? "",
      "warm-resident",
      "--socket",
      socketPath,
      "--pid-file",
      pidPath,
      "--store-uri",
      config.storeUri,
      "--ttl-days",
      String(config.ttlDays),
      "--ephemeral-ttl-hours",
      String(config.ephemeralTtlHours),
      "--byte-budget",
      String(config.byteBudget),
      "--telemetry-ttl-days",
      String(config.telemetryTtlDays),
      "--telemetry-byte-budget",
      String(config.telemetryByteBudget),
      "--telemetry-drain-interval-ms",
      String(config.telemetryDrainIntervalMs),
      "--telemetry-drain-timeout-ms",
      String(config.telemetryDrainTimeoutMs),
      "--idle-ms",
      String(config.idleMs),
      "--registry",
      registryPath,
      "--wake-lock",
      wakeLockPath,
    ], {
      cwd: rootDir,
      detached: true,
      stdio: "ignore",
      env: { ...process.env, RSP_RESIDENT_WARMER: "1" },
    });
    child.unref();
  } catch {}
}

function fastResidentRoot(cwd: string): string {
  let current = cwd;
  for (;;) {
    if (existsSync(join(current, ".git"))) return current;
    const parent = dirname(current);
    if (parent === current) return cwd;
    current = parent;
  }
}

function fastResidentSocketDir(rootDir: string): string {
  const hash = createHash("sha256").update(rootDir).digest("hex").slice(0, 20);
  const xdg = process.env.XDG_RUNTIME_DIR;
  if (xdg) {
    const candidate = join(xdg, "red-skills", hash);
    if (join(candidate, "rsp.sock").length < 108) return candidate;
  }
  const uid = typeof process.getuid === "function" ? process.getuid() : "nouid";
  return join(tmpdir(), `red-skills-${uid}`, hash);
}

function spoolHasEventOlderThan(path: string, cutoffMs: number): boolean {
  try {
    const text = readFileSync(path, "utf8");
    noteSelfStateBytesRead(Buffer.byteLength(text));
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line) as { created_at?: unknown; ts?: unknown };
        const timestamp = typeof parsed.created_at === "string" ? parsed.created_at : parsed.ts;
        if (typeof timestamp === "string") {
          const ms = Date.parse(timestamp);
          if (Number.isFinite(ms) && ms <= cutoffMs) return true;
        }
      } catch {}
    }
  } catch {}
  return false;
}

async function appendInvocationTelemetry(
  telemetryRoot: string,
  args: ParsedArgs,
  result: WrappedCommandResult,
  overhead: RspOverheadSample,
  ceiling: RspOverheadCeiling,
  metrics?: ResidentResponseMetrics,
): Promise<void> {
  const emitted = Buffer.concat([result.stdout, result.stderr]);
  const raw = Buffer.concat([result.rawOutput ?? result.stdout, result.stderr]);
  const overheadFields = overheadTelemetryFields(overhead, ceiling);
  const {
    appendTelemetryEvent,
    RSP_ACCOUNTING_EVENTS_COLLECTION,
    RSP_TELEMETRY_INVOCATIONS_COLLECTION,
  } = await import("../telemetry.js");
  await appendTelemetryEvent(telemetryRoot, {
    collection: RSP_ACCOUNTING_EVENTS_COLLECTION,
    event_type: "invocation",
    ts: new Date().toISOString(),
    command: telemetryCommand(args),
    command_class: args.command ?? "unknown",
    wrapper: args.command,
    loss: args.level,
    elided: Boolean(result.mintedHandle || result.bytesElided),
    raw_bytes: raw.length,
    emitted_bytes: emitted.length,
    ...overheadFields,
    store_open_count: metrics?.storeOpenCount,
    store_elapsed_ms: metrics?.storeElapsedMs,
  });
  await appendTelemetryEvent(telemetryRoot, {
    collection: RSP_TELEMETRY_INVOCATIONS_COLLECTION,
    ts: new Date().toISOString(),
    command: telemetryCommand(args),
    wrapper: args.command,
    loss: args.level,
    elided: Boolean(result.mintedHandle || result.bytesElided),
    raw_bytes: raw.length,
    emitted_bytes: emitted.length,
    raw_text: raw.toString("utf8"),
    emitted_text: emitted.toString("utf8"),
    ...overheadFields,
    store_open_count: metrics?.storeOpenCount,
    store_elapsed_ms: metrics?.storeElapsedMs,
    accounting_recorded: true,
  });
  if (result.degradation) {
    await appendTelemetryEvent(telemetryRoot, {
      collection: RSP_ACCOUNTING_EVENTS_COLLECTION,
      event_type: "invocation",
      ts: new Date().toISOString(),
      command: telemetryCommand(args),
      command_class: args.command ?? "unknown",
      loss: args.level,
      raw_bytes: raw.length,
      emitted_bytes: emitted.length,
      degradation_reason: result.degradation.reason,
      wrapper_family: result.degradation.family,
      wrapper_exit_code: 0,
      stderr_head: result.degradation.stderrHead,
    });
    await appendTelemetryEvent(telemetryRoot, {
      collection: "rsp_telemetry_degradations_v1",
      ts: new Date().toISOString(),
      command: telemetryCommand(args),
      reason: result.degradation.reason,
      wrapper_family: result.degradation.family,
      wrapper_exit_code: 0,
      stderr_head: result.degradation.stderrHead,
      accounting_recorded: true,
    });
  }
}

function appendFastInvocationTelemetry(
  telemetryRoot: string,
  args: ParsedArgs,
  result: WrappedCommandResult,
  overhead: RspOverheadSample,
  ceiling: RspOverheadCeiling,
): void {
  try {
    const emitted = Buffer.concat([result.stdout, result.stderr]);
    const raw = Buffer.concat([result.rawOutput ?? result.stdout, result.stderr]);
    const overheadFields = overheadTelemetryFields(overhead, ceiling);
    appendTelemetryEventSync(telemetryRoot, {
      collection: "rsp_accounting_events_v1",
      event_type: "invocation",
      ts: new Date().toISOString(),
      command: telemetryCommand(args),
      command_class: args.command ?? "unknown",
      wrapper: args.command,
      loss: args.level,
      elided: Boolean(result.mintedHandle || result.bytesElided),
      raw_bytes: raw.length,
      emitted_bytes: emitted.length,
      ...overheadFields,
    });
    appendTelemetryEventSync(telemetryRoot, {
      collection: "rsp_telemetry_invocations_v1",
      ts: new Date().toISOString(),
      command: telemetryCommand(args),
      wrapper: args.command,
      loss: args.level,
      elided: Boolean(result.mintedHandle || result.bytesElided),
      raw_bytes: raw.length,
      emitted_bytes: emitted.length,
      ...overheadFields,
      accounting_recorded: true,
    });
  } catch {}
}
