#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { connect } from "@reddb-io/sdk";
import { type JsonObject } from "@reddb-io/toon";
import { rspStateDir } from "@reddb-io/shared/red-paths.js";
import { encodeSnapshotToon } from "@reddb-io/shared/toon-migration.js";
import { readBuildInfo } from "@reddb-io/build-info";
import type { RspRuntimeConfig } from "./config.js";
import type { RspElisionStore, RspMintMeta, RspRecoveryHandle, RspStorageClassStats } from "./elision-store.js";
import { withNextSteps } from "./output-levers.js";
import { formatUsd } from "./pricing.js";
import type { ResidentResponseMetrics, RspResidentPaths } from "./resident-client.js";
import { renderStructuredError, renderUnknownFlag, structuredErrorPayload } from "./structured-error.js";
import {
  appendTelemetryEventSync,
  telemetrySpoolPath,
  type RspAccountingLaneStats,
  type RspTelemetryGainsReport,
  type RspTelemetryStats,
} from "./telemetry.js";

interface ParsedArgs {
  command?: string;
  handle?: string;
  storeUri?: string;
  query?: string;
  level: "lossless" | "brief" | "terse";
  positional: string[];
}

async function main(argv = process.argv.slice(2)): Promise<number> {
  const buildInfo = readBuildInfo("rsp");
  if (isHelpRequest(argv)) {
    process.stdout.write(renderCliHelp(argv));
    return 0;
  }
  const args = parseArgs(argv);
  if (args.command === "hook" && args.positional[1] === "claude-pre-exec") {
    const { runClaudePreExecHook } = await import("./intercept.js");
    return await runClaudePreExecHook();
  }
  if (args.command === "hook" && args.positional[1] === "codex-pre-exec") {
    const { runCodexPreExecHook } = await import("./intercept.js");
    return await runCodexPreExecHook();
  }
  if (args.command === "hook" && args.positional[1] === "claude-post-exec") {
    const { runClaudePostExecHook } = await import("./normalize.js");
    return await runClaudePostExecHook();
  }
  if (args.command === "hook" && args.positional[1] === "codex-post-exec") {
    const { runCodexPostExecHook } = await import("./normalize.js");
    return await runCodexPostExecHook();
  }
  if (args.command === "setup") {
    const { provisionRspRepoStore } = await import("./setup.js");
    const result = await provisionRspRepoStore(process.cwd());
    process.stdout.write(renderSetupResult(result));
    return 0;
  }
  if (args.command === "mcp") {
    const { runRspMcpServer } = await import("./mcp-server.js");
    await runRspMcpServer();
    return 0;
  }
  if (args.command === "wait") {
    const { runWait } = await import("./wait.js");
    return await runWait(args.positional);
  }
  if (args.command === "shell-init") {
    const shell = args.positional[1];
    if (shell !== "fish" && shell !== "bash" && shell !== "zsh") {
      process.stdout.write(renderStructuredError({
        command: args.positional.join(" ") || "shell-init",
        category: "usage",
        error: "usage rsp shell-init fish|bash|zsh",
        help: "rsp shell-init bash",
      }));
      return 2;
    }
    const { renderShellInit } = await import("./shell-init.js");
    process.stdout.write(renderShellInit(shell));
    return 0;
  }
  const { resolveRspConfig } = await import("./config.js");
  const config = resolveRspConfig(process.cwd(), process.env, args.storeUri);
  if (args.command === "doctor") {
    const { resolveResidentPaths } = await import("./resident-client.js");
    const residentPaths = resolveResidentPaths(process.cwd());
    const status = await runDoctor(config, residentPaths, sinceDays(args.positional, 1));
    process.stdout.write(renderDoctor(status));
    return status.exitCode;
  }
  const wrapperCommand = isWrapperCommand(args.command);
  if (!config.enabled) {
    if (wrapperCommand) return await passthroughDisabledDirectory(args.positional);
    process.stdout.write(`${rspDisabledReason()}\n`);
    return 0;
  }
  if (args.command === "git" && isFastGitStatus(args.positional)) {
    const started = process.hrtime.bigint();
    return await emitWrappedResult(args, await runFastGitStatus(), started, undefined, await fastTelemetryRoot(process.cwd()));
  }
  const { resolveResidentPaths, ResidentRspElisionStore, ensureResidentServer } = await import("./resident-client.js");
  const residentPaths = resolveResidentPaths(process.cwd());
  if (wrapperCommand && shouldUseControlHoldout(config.measurementHoldoutShare)) {
    return await runControlHoldout(args, residentPaths.rootDir, config.measurementHoldoutShare);
  }
  if (args.command === "server") {
    const { runResidentServer } = await import("./resident-server.js");
    const serverPaths = resolveResidentPaths(process.cwd());
    const socket = valueAfter(args.positional, "--socket") ?? serverPaths.socketPath;
    const serverConfig = resolveRspConfig(process.cwd(), process.env, args.storeUri ?? valueAfter(args.positional, "--store-uri"));
    if (!serverConfig.enabled) {
      process.stdout.write(`${rspDisabledReason()}\n`);
      return 0;
    }
    await runResidentServer({
      socketPath: socket,
      pidPath: valueAfter(args.positional, "--pid-file") ?? resolveResidentPaths(process.cwd()).pidPath,
      rootDir: serverPaths.rootDir,
      storeUri: serverConfig.storeUri,
      ttlDays: numericValueAfter(args.positional, "--ttl-days") ?? serverConfig.ttlDays,
      ephemeralTtlHours: numericValueAfter(args.positional, "--ephemeral-ttl-hours") ?? serverConfig.ephemeralTtlHours,
      byteBudget: numericValueAfter(args.positional, "--byte-budget") ?? serverConfig.byteBudget,
      telemetryTtlDays: numericValueAfter(args.positional, "--telemetry-ttl-days") ?? serverConfig.telemetryTtlDays,
      telemetryByteBudget: numericValueAfter(args.positional, "--telemetry-byte-budget") ?? serverConfig.telemetryByteBudget,
      telemetryDrainIntervalMs: numericValueAfter(args.positional, "--telemetry-drain-interval-ms") ??
        serverConfig.telemetryDrainIntervalMs,
      telemetryDrainTimeoutMs: numericValueAfter(args.positional, "--telemetry-drain-timeout-ms") ??
        serverConfig.telemetryDrainTimeoutMs,
      idleMs: numericValueAfter(args.positional, "--idle-ms") ?? serverConfig.idleMs,
      residentVersion: valueAfter(args.positional, "--resident-version") ?? buildInfo.version,
      registryPath: valueAfter(args.positional, "--registry") ?? serverPaths.registryPath,
    });
    return 0;
  }
  if (args.command === "warm-resident") {
    const warmPaths = resolveResidentPaths(process.cwd());
    const socket = valueAfter(args.positional, "--socket") ?? warmPaths.socketPath;
    const wakeLock = valueAfter(args.positional, "--wake-lock") ?? warmPaths.wakeLockPath;
    const warmConfig = resolveRspConfig(process.cwd(), process.env, args.storeUri ?? valueAfter(args.positional, "--store-uri"));
    if (!warmConfig.enabled) return 0;
    const { warmResidentServer } = await import("./resident-client.js");
    await warmResidentServer({
      ...warmPaths,
      socketPath: socket,
      wakeLockPath: wakeLock,
    }, {
      storeUri: warmConfig.storeUri,
      ttlDays: numericValueAfter(args.positional, "--ttl-days") ?? warmConfig.ttlDays,
      ephemeralTtlHours: numericValueAfter(args.positional, "--ephemeral-ttl-hours") ?? warmConfig.ephemeralTtlHours,
      byteBudget: numericValueAfter(args.positional, "--byte-budget") ?? warmConfig.byteBudget,
      telemetryTtlDays: numericValueAfter(args.positional, "--telemetry-ttl-days") ?? warmConfig.telemetryTtlDays,
      telemetryByteBudget: numericValueAfter(args.positional, "--telemetry-byte-budget") ?? warmConfig.telemetryByteBudget,
      telemetryDrainIntervalMs: numericValueAfter(args.positional, "--telemetry-drain-interval-ms") ??
        warmConfig.telemetryDrainIntervalMs,
      telemetryDrainTimeoutMs: numericValueAfter(args.positional, "--telemetry-drain-timeout-ms") ??
        warmConfig.telemetryDrainTimeoutMs,
      idleMs: numericValueAfter(args.positional, "--idle-ms") ?? warmConfig.idleMs,
      clientVersion: buildInfo.version,
    });
    return 0;
  }
  if (args.command === "proxy") {
    const { runProxy } = await import("./proxy.js");
    return await runProxy(args.positional, { telemetryRoot: residentPaths.rootDir, level: args.level });
  }
  if (args.command === "status" || args.command === "sweep") {
    const { residentRegistryStatus, sweepResidentRegistry } = await import("./resident-client.js");
    const status = args.command === "sweep"
      ? await sweepResidentRegistry(residentPaths)
      : await residentRegistryStatus(residentPaths);
    process.stdout.write(`${encodeSnapshotToon(status as unknown as JsonObject)}\n`);
    return 0;
  }
  if (args.command === "gh-api-json") {
    const { readGhConditionalJson } = await import("./gh-conditional.js");
    const request = parseGhApiJsonArgs(args.positional);
    if (!request) {
      process.stdout.write(renderStructuredError({
        command: args.positional.join(" "),
        category: "usage",
        error: "usage rsp gh-api-json <path> [-f name=value ...]",
        help: "rsp gh-api-json repos/{owner}/{repo}",
        validFlags: ["-f", "-F"],
      }));
      return 2;
    }
    const response = await readGhConditionalJson({
      path: request.path,
      params: request.params,
      cwd: process.cwd(),
      telemetryRoot: residentPaths.rootDir,
      command: `rsp ${args.positional.join(" ")}`,
    });
    process.stdout.write(response.stdout);
    if (response.stderr) process.stderr.write(`${response.stderr}\n`);
    return response.status;
  }
  if (!args.command) {
    const dashboard = await readDashboardSnapshot(config);
    process.stdout.write(renderDashboard(dashboard));
    return 0;
  }
  if (!args.storeUri && config.storeUri.startsWith("file://") && !existsSync(fileURLToPath(config.storeUri))) {
    if (wrapperCommand) return await runColdWrappedCommand(args, config, residentPaths.rootDir);
    process.stdout.write(renderStructuredError({
      command: telemetryCommand(args) || "rsp",
      category: "real-error",
      error: "rsp repo store is not provisioned",
      help: "/red-setup",
    }));
    return 1;
  }
  const openResidentStore = (ensureResident = true) => Promise.resolve(new ResidentRspElisionStore(residentPaths, {
    storeUri: config.storeUri,
    ttlDays: config.ttlDays,
    ephemeralTtlHours: config.ephemeralTtlHours,
    byteBudget: config.byteBudget,
    telemetryTtlDays: config.telemetryTtlDays,
    telemetryByteBudget: config.telemetryByteBudget,
    telemetryDrainIntervalMs: config.telemetryDrainIntervalMs,
    telemetryDrainTimeoutMs: config.telemetryDrainTimeoutMs,
    idleMs: config.idleMs,
    clientVersion: buildInfo.version,
  }, { ensureResident }));
  const warmResidentStore = () => ensureResidentServer(residentPaths, {
    storeUri: config.storeUri,
    ttlDays: config.ttlDays,
    ephemeralTtlHours: config.ephemeralTtlHours,
    byteBudget: config.byteBudget,
    telemetryTtlDays: config.telemetryTtlDays,
    telemetryByteBudget: config.telemetryByteBudget,
    telemetryDrainIntervalMs: config.telemetryDrainIntervalMs,
    telemetryDrainTimeoutMs: config.telemetryDrainTimeoutMs,
    idleMs: config.idleMs,
    clientVersion: buildInfo.version,
  });
  const openDirectStore = async (): Promise<ElisionStoreLike & Pick<RspElisionStore, "get" | "stats">> => {
    const { RspElisionStore } = await import("./elision-store.js");
    return await RspElisionStore.open({
      uri: config.storeUri,
      ttlDays: config.ttlDays,
      ephemeralTtlHours: config.ephemeralTtlHours,
      byteBudget: config.byteBudget,
    });
  };
  const openReadStore = () => !config.storeUri.endsWith("/red-skills.rdb")
    ? openDirectStore()
    : openResidentStore();
  let closeStore: (() => Promise<void>) | undefined;
  try {
    if (args.command === "stats") {
      const { stats, telemetry } = await readStatsSnapshot(config, sinceDays(args.positional, 30));
      process.stdout.write(renderStats(stats, telemetry, statsFull(args.positional)));
      return 0;
    }

    if (args.command === "gains") {
      const store = await openReadStore();
      closeStore = () => store.close();
      if (!hasTelemetryGains(store)) {
        process.stdout.write("error: rsp gains requires the shared RedDB store\n");
        return 1;
      }
      const report = await store.telemetryGains(sinceDays(args.positional, 28));
      process.stdout.write(renderGainsReportToon(report));
      return 0;
    }

    if (args.command === "git") {
      fireAndForget(warmResidentStore());
      if (isFastGitStatus(args.positional)) {
        const started = process.hrtime.bigint();
        return await emitWrappedResult(args, await runFastGitStatus(), started, undefined, residentPaths.rootDir);
      }
      const { runGitWrapper } = await import("./git-wrapper.js");
      const store = new LazyRspElisionStore(() => openResidentStore(false));
      closeStore = () => store.close();
      const started = process.hrtime.bigint();
      const result = await runGitWrapper(args.positional, {
        level: args.level,
        store,
        heavyGitByteThreshold: config.heavyGitByteThreshold,
      });
      return await emitWrappedResult(args, result, started, store, residentPaths.rootDir);
    }

    if (args.command === "gh") {
      fireAndForget(warmResidentStore());
      const { runGhWrapper } = await import("./gh-wrapper.js");
      const store = new LazyRspElisionStore(() => openResidentStore(false));
      closeStore = () => store.close();
      const started = process.hrtime.bigint();
      const result = await runGhWrapper(args.positional, { level: args.level, store });
      return await emitWrappedResult(args, result, started, store, residentPaths.rootDir);
    }

    if (args.command === "vitest" || args.command === "cargo") {
      fireAndForget(warmResidentStore());
      const { runTestWrapper } = await import("./test-wrapper.js");
      const store = new LazyRspElisionStore(() => openResidentStore(false));
      closeStore = () => store.close();
      const started = process.hrtime.bigint();
      const result = await runTestWrapper(args.positional, { level: args.level, store });
      return await emitWrappedResult(args, result, started, store, residentPaths.rootDir);
    }

    if (args.command === "cat") {
      fireAndForget(warmResidentStore());
      const { runCatWrapper } = await import("./cat-wrapper.js");
      const store = new LazyRspElisionStore(() => openResidentStore(false));
      closeStore = () => store.close();
      const started = process.hrtime.bigint();
      const result = await runCatWrapper(args.positional, {
        level: args.level,
        store,
        heavyByteThreshold: config.heavyGitByteThreshold,
      });
      return await emitWrappedResult(args, result, started, store, residentPaths.rootDir);
    }

    if (args.command === "exec") {
      fireAndForget(warmResidentStore());
      const { runExecWrapper } = await import("./exec-wrapper.js");
      const store = new LazyRspElisionStore(() => openResidentStore(false));
      closeStore = () => store.close();
      const started = process.hrtime.bigint();
      const result = await runExecWrapper(args.positional, {
        level: args.level,
        store,
        heavyByteThreshold: config.heavyGitByteThreshold,
      });
      return await emitWrappedResult(args, result, started, store, residentPaths.rootDir);
    }

    if (args.command === "show" && args.handle) {
      const store = await openReadStore();
      closeStore = () => store.close();
      const record = await store.get(args.handle);
      if (record && "original" in record && record.original) {
        process.stdout.write(record.original);
        await appendShowAccountingEvent(residentPaths.rootDir, args.handle, true, record.original.length);
        return 0;
      }
      if (record?.status === "expired") {
        const text = renderStructuredError({
          command: `rsp show ${args.handle}`,
          category: "real-error",
          error: `expired ${record.expired_at}`,
          help: record.command,
        });
        process.stdout.write(text);
        await appendShowAccountingEvent(residentPaths.rootDir, args.handle, false, text.length);
        return 1;
      }
      const text = renderStructuredError({
        command: `rsp show ${args.handle}`,
        category: "real-error",
        error: "expired unknown",
        help: args.handle,
      });
      process.stdout.write(text);
      await appendShowAccountingEvent(residentPaths.rootDir, args.handle, false, text.length);
      return 1;
    }

    process.stdout.write(renderStructuredError({
      command: args.positional.join(" ") || "rsp",
      category: "usage",
      error: "usage rsp show el:<id>",
      help: "rsp show el:<id>",
    }));
    return 2;
  } catch (err) {
    if (isStructuredUsageRenderable(err)) {
      process.stdout.write(err.render());
      return 2;
    }
    if (wrapperCommand) return await degradeToPassthrough("wrapper failed", args.positional, err, residentPaths.rootDir);
    throw err;
  } finally {
    await closeStore?.();
  }
}

async function runControlHoldout(args: ParsedArgs, telemetryRoot: string, holdoutShare: number): Promise<number> {
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

async function passthroughCaptured(argv: readonly string[]): Promise<{ stdoutBytes: number; stderrBytes: number; status: number | null; signal: NodeJS.Signals | null }> {
  const command = argv[0];
  if (!command) return { stdoutBytes: 0, stderrBytes: 0, status: 2, signal: null };
  let child;
  if (command === "exec" || command === "proxy") {
    const commandLine = command === "proxy"
      ? await import("./proxy.js").then((module) => module.parseProxyCommandLine(argv))
      : await import("./exec-wrapper.js").then((module) => module.parseExecCommandLine(argv));
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

function shouldUseControlHoldout(share: number): boolean {
  return share > 0 && Math.random() < share;
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

function valueAfter(args: readonly string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

function numericValueAfter(args: readonly string[], flag: string): number | undefined {
  const value = valueAfter(args, flag);
  if (value == null) return undefined;
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

function isFastGitStatus(argv: readonly string[]): boolean {
  return argv.length === 2 && argv[0] === "git" && argv[1] === "status";
}

async function runFastGitStatus(): Promise<WrappedCommandResult> {
  if (isEmptyUnbornGitRepo(process.cwd())) {
    return {
      stdout: renderCleanGitStatus(),
      stderr: Buffer.alloc(0),
      status: 0,
      signal: null,
    };
  }

  const { spawnSync } = await import("node:child_process");
  const clean = spawnSync("git", ["diff-index", "--quiet", "HEAD", "--"], { stdio: "ignore" });
  if (clean.status === 0) {
    return {
      stdout: renderCleanGitStatus(),
      stderr: Buffer.alloc(0),
      status: 0,
      signal: null,
    };
  }

  const status = spawnSync("git", ["status", "--porcelain=v1"], { encoding: "buffer" });
  if ((status.status ?? 0) !== 0) {
    return {
      stdout: status.stdout,
      stderr: status.stderr,
      status: status.status ?? 1,
      signal: status.signal,
    };
  }
  const stdout = status.stdout.length === 0 ? renderCleanGitStatus() : status.stdout;
  return {
    stdout,
    stderr: status.stderr,
    status: 0,
    signal: status.signal,
    rawOutput: stdout,
  };
}

function renderCleanGitStatus(): Buffer {
  return Buffer.from(`${encodeSnapshotToon({
    command: "git status",
    category: "no-op",
    exit_code: 0,
    noop: true,
    scope: "git status",
    empty: true,
    branch: "",
    rows: [],
    summary: "git status clean: 0 changes",
  })}\n`);
}

async function fastTelemetryRoot(cwd: string): Promise<string> {
  try {
    const { resolveResidentPaths } = await import("./resident-client.js");
    return resolveResidentPaths(cwd).rootDir;
  } catch {
    return cwd;
  }
}

function isEmptyUnbornGitRepo(cwd: string): boolean {
  try {
    if (!existsSync(`${cwd}/.git`) || existsSync(`${cwd}/.git/index`)) return false;
    return readdirSync(cwd).every((entry) => entry === ".git");
  } catch {
    return false;
  }
}

type ElisionStoreLike = Pick<RspElisionStore, "close"> & {
  mint(original: Uint8Array | Buffer, meta: RspMintMeta): Promise<string>;
  lastResponseMetrics?: () => ResidentResponseMetrics | undefined;
};

type InvocationTelemetryStore = {
  lastResponseMetrics: () => ResidentResponseMetrics | undefined;
};

type TelemetryStatsStore = {
  telemetryStats: (sinceDays: number) => Promise<RspTelemetryStats>;
};

type AccountingStatsStore = {
  accountingStats: (byteBudget: number) => Promise<RspAccountingLaneStats>;
};

type TelemetryGainsStore = {
  telemetryGains: (sinceDays: number) => Promise<RspTelemetryGainsReport>;
};

function hasTelemetryStats(store: unknown): store is TelemetryStatsStore {
  return typeof store === "object" &&
    store !== null &&
    "telemetryStats" in store &&
    typeof (store as { telemetryStats?: unknown }).telemetryStats === "function";
}

function hasTelemetryGains(store: unknown): store is TelemetryGainsStore {
  return typeof store === "object" &&
    store !== null &&
    "telemetryGains" in store &&
    typeof (store as { telemetryGains?: unknown }).telemetryGains === "function";
}

function hasAccountingStats(store: unknown): store is AccountingStatsStore {
  return typeof store === "object" &&
    store !== null &&
    "accountingStats" in store &&
    typeof (store as { accountingStats?: unknown }).accountingStats === "function";
}

interface WrappedCommandResult {
  stdout: Buffer;
  stderr: Buffer;
  status: number | null;
  signal: NodeJS.Signals | null;
  mintedHandle?: string;
  bytesElided?: number;
  rawOutput?: Buffer;
  degradation?: {
    reason: string;
    family: string;
    stderrHead: string;
  };
}

class LazyRspElisionStore implements ElisionStoreLike {
  private store?: Promise<ElisionStoreLike>;
  private metrics?: ResidentResponseMetrics;

  constructor(private readonly openStore: () => Promise<ElisionStoreLike>) {}

  async mint(...args: Parameters<RspElisionStore["mint"]>): Promise<string> {
    try {
      const store = await this.open();
      const handle = await store.mint(...args);
      this.metrics = store.lastResponseMetrics?.();
      return handle;
    } catch {
      return `recovery unavailable (resident cold) — re-run: ${args[1].command}`;
    }
  }

  async close(): Promise<void> {
    if (!this.store) return;
    let store: ElisionStoreLike;
    try {
      store = await this.store;
    } catch {
      return;
    }
    await store.close();
  }

  private open(): Promise<ElisionStoreLike> {
    this.store ??= this.openStore();
    return this.store;
  }

  lastResponseMetrics(): ResidentResponseMetrics | undefined {
    return this.metrics;
  }
}

class ColdRspElisionStore implements ElisionStoreLike {
  async mint(_original: Uint8Array | Buffer, meta: RspMintMeta): Promise<string> {
    return `recovery unavailable (cold store) — re-run: ${meta.command}`;
  }

  lastResponseMetrics(): ResidentResponseMetrics | undefined {
    return undefined;
  }

  async close(): Promise<void> {}
}

async function runColdWrappedCommand(
  args: ParsedArgs,
  config: RspRuntimeConfig,
  telemetryRoot: string,
  err?: unknown,
): Promise<number> {
  if (process.env.RSP_DEBUG === "1") {
    throw err instanceof Error ? err : new Error("cold store");
  }

  const store = new ColdRspElisionStore();
  const started = process.hrtime.bigint();
  try {
    if (args.command === "git") {
      if (isFastGitStatus(args.positional)) {
        return await emitWrappedResult(args, await runFastGitStatus(), started, store, telemetryRoot, config);
      }
      const { runGitWrapper } = await import("./git-wrapper.js");
      const result = await runGitWrapper(args.positional, {
        level: args.level,
        store,
        heavyGitByteThreshold: config.heavyGitByteThreshold,
      });
      return await emitWrappedResult(args, result, started, store, telemetryRoot, config);
    }

    if (args.command === "gh") {
      const { runGhWrapper } = await import("./gh-wrapper.js");
      const result = await runGhWrapper(args.positional, { level: args.level, store });
      return await emitWrappedResult(args, result, started, store, telemetryRoot, config);
    }

    if (args.command === "vitest" || args.command === "cargo") {
      const { runTestWrapper } = await import("./test-wrapper.js");
      const result = await runTestWrapper(args.positional, { level: args.level, store });
      return await emitWrappedResult(args, result, started, store, telemetryRoot, config);
    }

    if (args.command === "cat") {
      const { runCatWrapper } = await import("./cat-wrapper.js");
      const result = await runCatWrapper(args.positional, {
        level: args.level,
        store,
        heavyByteThreshold: config.heavyGitByteThreshold,
      });
      return await emitWrappedResult(args, result, started, store, telemetryRoot, config);
    }

    if (args.command === "exec") {
      const { runExecWrapper } = await import("./exec-wrapper.js");
      const result = await runExecWrapper(args.positional, {
        level: args.level,
        store,
        heavyByteThreshold: config.heavyGitByteThreshold,
      });
      return await emitWrappedResult(args, result, started, store);
    }
  } catch (coldErr) {
    if (isStructuredUsageRenderable(coldErr)) {
      process.stdout.write(coldErr.render());
      return 2;
    }
    return await degradeToPassthrough("wrapper failed", args.positional, coldErr, telemetryRoot);
  } finally {
    await store.close();
  }

  return await degradeToPassthrough("wrapper failed", args.positional, err, telemetryRoot);
}

async function readStatsSnapshot(
  config: RspRuntimeConfig,
  sinceDaysValue: number,
): Promise<{ stats: RspAccountingLaneStats; telemetry: RspTelemetryStats }> {
  const empty = {
    stats: emptyAccountingStats(config.telemetryByteBudget),
    telemetry: emptyTelemetryStats(sinceDaysValue),
  };
  if (!config.storeUri.startsWith("file://")) return empty;
  const path = fileURLToPath(config.storeUri);
  if (!existsSync(path)) return empty;
  if (!path.endsWith("red-skills.rdb")) {
    const { RspElisionStore } = await import("./elision-store.js");
    const store = await RspElisionStore.open({
      uri: config.storeUri,
      ttlDays: config.ttlDays,
      ephemeralTtlHours: config.ephemeralTtlHours,
      byteBudget: config.byteBudget,
    });
    try {
      return {
        stats: await store.stats(),
        telemetry: emptyTelemetryStats(sinceDaysValue),
      };
    } finally {
      await store.close();
    }
  }

  const { ensureReddbBinaryFromWarmCache } = await import("./elision-store.js");
  await ensureReddbBinaryFromWarmCache();
  const { readAccountingLaneStats, readTelemetryStats } = await import("./telemetry.js");
  const db = await connect(config.storeUri);
  try {
    return {
      stats: await readAccountingLaneStats(db, config.telemetryByteBudget),
      telemetry: await readTelemetryStats(db, sinceDaysValue),
    };
  } finally {
    await db.close();
  }
}

interface DashboardSnapshot {
  stats: RspAccountingLaneStats;
  telemetry: RspTelemetryStats;
  recoveryHandles: RspRecoveryHandle[];
  waits: JsonObject[];
}

type DoctorProbeName =
  | "config_gate_resolution"
  | "hook_wiring"
  | "proxy_mode"
  | "resident_liveness"
  | "store_provisioning"
  | "recent_degradation_rate";

type DoctorError = JsonObject;

interface DoctorProbe {
  name: DoctorProbeName;
  pass: boolean;
  finding: string;
  fix_command?: string;
  error?: DoctorError;
}

interface DoctorStatus {
  schema_version: "red.rsp.doctor.v1";
  status: "pass" | "fail" | "disabled";
  exitCode: 0 | 1;
  window_days: number;
  probes: DoctorProbe[];
  errors: DoctorError[];
}

interface ResidentRegistryStateLike {
  state: string;
}

async function runDoctor(
  config: RspRuntimeConfig,
  residentPaths: RspResidentPaths,
  windowDays: number,
): Promise<DoctorStatus> {
  const probes: DoctorProbe[] = [];
  const disabled = !config.enabled;
  probes.push(disabled
    ? passProbe("config_gate_resolution", "rsp disabled in this directory; run /red-setup to opt in")
    : passProbe("config_gate_resolution", "rsp.enabled resolved true for this directory"));

  if (disabled) {
    probes.push(
      passProbe("hook_wiring", "skipped because rsp is disabled"),
      passProbe("proxy_mode", "skipped because rsp is disabled"),
      passProbe("resident_liveness", "skipped because rsp is disabled"),
      passProbe("store_provisioning", "skipped because rsp is disabled"),
      passProbe("recent_degradation_rate", "skipped because rsp is disabled"),
    );
    return doctorStatus("disabled", probes, windowDays);
  }

  probes.push(await doctorHookProbe(config));
  probes.push(config.proxyEnabled
    ? passProbe("proxy_mode", "proxy routing enabled for pre-exec rewrites")
    : failProbe(
      "proxy_mode",
      "proxy routing is explicitly disabled; hook falls back to fixed wrapper capabilities",
      "rsp setup",
    ));

  const { residentRegistryStatus } = await import("./resident-client.js");
  probes.push(residentProbe(await residentRegistryStatus(residentPaths)));
  probes.push(storeProbe(config));

  if (storeExists(config)) {
    const { telemetry } = await readStatsSnapshot(config, windowDays);
    probes.push(degradationProbe(telemetry, windowDays));
  } else {
    probes.push(passProbe("recent_degradation_rate", "no telemetry store available yet; no recent degradation spike detected"));
  }

  return doctorStatus(probes.some((probe) => !probe.pass) ? "fail" : "pass", probes, windowDays);
}

async function doctorHookProbe(config: RspRuntimeConfig): Promise<DoctorProbe> {
  try {
    if (config.proxyEnabled) return passProbe("hook_wiring", "pre-exec hook would rewrite git status through rsp proxy");
    const { rewriteCommand } = await import("./intercept.js");
    const decision = rewriteCommand("git status");
    if (decision.kind === "rewrite") return passProbe("hook_wiring", `pre-exec hook would rewrite git status through ${decision.capabilityId}`);
    return failProbe("hook_wiring", `pre-exec hook passed git status through: ${decision.reason ?? "unsupported-command"}`, "rsp setup");
  } catch (err) {
    return failProbe("hook_wiring", `pre-exec hook probe failed: ${err instanceof Error ? firstLine(err.message) : "unknown error"}`, "rsp setup");
  }
}

function residentProbe(status: ResidentRegistryStateLike): DoctorProbe {
  if (status.state === "registered-alive-socket-healthy") {
    return passProbe("resident_liveness", "resident registry points at a healthy socket");
  }
  return failProbe("resident_liveness", `resident registry state is ${status.state}`, "rsp warm-resident");
}

function storeProbe(config: RspRuntimeConfig): DoctorProbe {
  if (!config.storeUri.startsWith("file://")) {
    return passProbe("store_provisioning", "non-file store URI configured; provisioning is delegated to that backend");
  }
  if (storeExists(config)) return passProbe("store_provisioning", "rsp store exists for this directory");
  return failProbe("store_provisioning", "rsp store is not provisioned", "rsp setup");
}

function degradationProbe(telemetry: RspTelemetryStats, windowDays: number): DoctorProbe {
  const dominant = telemetry.health.by_reason[0];
  if (telemetry.health.degradations === 0) {
    return passProbe("recent_degradation_rate", `0 degradations in the recent ${windowDays}d window`);
  }
  const count = telemetry.health.degradations;
  const reason = dominant?.reason ?? telemetry.health.most_recent?.reason ?? "unknown";
  const reasonCount = dominant?.count ?? count;
  return failProbe(
    "recent_degradation_rate",
    `${count} degradation(s) in the recent ${windowDays}d window; dominant reason ${reason} (${reasonCount})`,
    degradationFixCommand(reason, windowDays),
  );
}

function degradationFixCommand(reason: string, windowDays: number): string {
  if (/unavailable|not provisioned|missing/i.test(reason)) return "rsp setup";
  if (/resident|socket|registry/i.test(reason)) return "rsp warm-resident";
  return `rsp stats --since ${windowDays}d --full`;
}

function storeExists(config: RspRuntimeConfig): boolean {
  if (!config.storeUri.startsWith("file://")) return true;
  try {
    return existsSync(fileURLToPath(config.storeUri));
  } catch {
    return false;
  }
}

function passProbe(name: DoctorProbeName, finding: string): DoctorProbe {
  return { name, pass: true, finding };
}

function failProbe(name: DoctorProbeName, finding: string, fixCommand: string): DoctorProbe {
  return {
    name,
    pass: false,
    finding,
    fix_command: fixCommand,
    error: structuredErrorPayload({
      command: `rsp doctor:${name}`,
      category: "real-error",
      error: finding,
      help: fixCommand,
    }),
  };
}

function doctorStatus(status: DoctorStatus["status"], probes: DoctorProbe[], windowDays: number): DoctorStatus {
  return {
    schema_version: "red.rsp.doctor.v1",
    status,
    exitCode: status === "fail" ? 1 : 0,
    window_days: windowDays,
    probes,
    errors: probes.map((probe) => probe.error).filter((error): error is DoctorError => Boolean(error)),
  };
}

function renderDoctor(status: DoctorStatus): string {
  const { exitCode: _exitCode, ...payload } = status;
  return `${encodeSnapshotToon({
    ...payload,
    exit_code: status.exitCode,
    probes: status.probes as unknown as JsonObject[],
    errors: status.errors,
  })}\n`;
}

async function readDashboardSnapshot(config: RspRuntimeConfig): Promise<DashboardSnapshot> {
  const { stats, telemetry } = await readStatsSnapshot(config, 30);
  const [recoveryHandles, waits] = await Promise.all([
    readRecoveryHandles(config),
    import("./wait.js").then((module) => module.listWaits(process.cwd()), () => [] as JsonObject[]),
  ]);
  return { stats, telemetry, recoveryHandles, waits };
}

async function readRecoveryHandles(config: RspRuntimeConfig): Promise<RspRecoveryHandle[]> {
  if (!config.storeUri.startsWith("file://")) return [];
  const path = fileURLToPath(config.storeUri);
  if (!existsSync(path)) return [];
  const { RspElisionStore } = await import("./elision-store.js");
  const store = await RspElisionStore.open({
    uri: config.storeUri,
    ttlDays: config.ttlDays,
    ephemeralTtlHours: config.ephemeralTtlHours,
    byteBudget: config.byteBudget,
  });
  try {
    return await store.recoveryHandles(5);
  } finally {
    await store.close();
  }
}

function renderDashboard(snapshot: DashboardSnapshot): string {
  const statsView = statsPayload(snapshot.stats, snapshot.telemetry, false);
  const payload = withNextSteps({
    executable: {
      name: "rsp",
      command: "rsp",
    },
    recovery: {
      pending: snapshot.recoveryHandles.length,
      handles: snapshot.recoveryHandles as unknown as JsonObject[],
    },
    waits: {
      active: snapshot.waits.length,
      entries: snapshot.waits,
    },
    store: {
      records: snapshot.stats.records,
      bytes: snapshot.stats.bytes,
      oldest: snapshot.stats.oldest,
      budget: snapshot.stats.budget,
      storage_classes: (snapshot.stats.storage_classes ?? emptyStorageClassStats()) as unknown as JsonObject,
    },
    savings: statsView.savings,
    health: statsView.health,
    decisions: statsView.decisions,
    latency: statsView.latency,
  }, dashboardNextSteps(snapshot));
  return `${encodeSnapshotToon(payload)}\n`;
}

function dashboardNextSteps(snapshot: DashboardSnapshot): string[] {
  return [
    snapshot.recoveryHandles.length > 0 ? "rsp show <handle>" : "rsp <wrapped-command> --terse",
    snapshot.waits.length > 0 ? "rsp wait ls" : "rsp wait cmd -- \"<command>\"",
    "rsp stats --since <days>d",
  ];
}

async function emitWrappedResult(
  args: ParsedArgs,
  result: WrappedCommandResult,
  started: bigint,
  store?: InvocationTelemetryStore,
  telemetryRoot = process.cwd(),
  coldNudgeConfig?: RspRuntimeConfig,
): Promise<number> {
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  const wrapperMs = Number(process.hrtime.bigint() - started) / 1_000_000;
  if (store) {
    fireAndForget(appendInvocationTelemetry(telemetryRoot, args, result, wrapperMs, store.lastResponseMetrics()));
    if (coldNudgeConfig) nudgeColdTelemetryDrain(telemetryRoot, coldNudgeConfig);
  } else {
    appendFastInvocationTelemetry(telemetryRoot, args, result, wrapperMs);
  }
  if (result.signal) {
    process.kill(process.pid, result.signal);
    return 128;
  }
  return result.status ?? 0;
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
    const registryPath = join(rspStateDir(rootDir), "rsp-resident.pid.json");
    const wakeLockPath = join(rootDir, ".red", "tmp", "rsp.wake.lock");
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
  wrapperMs: number,
  metrics?: ResidentResponseMetrics,
): Promise<void> {
  const emitted = Buffer.concat([result.stdout, result.stderr]);
  const raw = Buffer.concat([result.rawOutput ?? result.stdout, result.stderr]);
  const {
    appendTelemetryEvent,
    RSP_ACCOUNTING_EVENTS_COLLECTION,
    RSP_TELEMETRY_INVOCATIONS_COLLECTION,
  } = await import("./telemetry.js");
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
    wrapper_ms: wrapperMs,
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
    wrapper_ms: wrapperMs,
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
  wrapperMs: number,
): void {
  try {
    const emitted = Buffer.concat([result.stdout, result.stderr]);
    const raw = Buffer.concat([result.rawOutput ?? result.stdout, result.stderr]);
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
      wrapper_ms: wrapperMs,
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
      wrapper_ms: wrapperMs,
      accounting_recorded: true,
    });
  } catch {}
}

async function degradeToPassthrough(reason: string, argv: readonly string[], err?: unknown, telemetryRoot?: string): Promise<number> {
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
    } = await import("./telemetry.js");
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

function firstLine(text: string): string {
  return text.split(/\r?\n/, 1)[0]?.trim() ?? "";
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

async function appendShowAccountingEvent(
  telemetryRoot: string,
  handle: string,
  hit: boolean,
  emittedBytes: number,
): Promise<void> {
  const { appendTelemetryEvent, RSP_ACCOUNTING_EVENTS_COLLECTION } = await import("./telemetry.js");
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

async function passthroughDisabledDirectory(argv: readonly string[]): Promise<number> {
  if (process.env.RSP_DEBUG === "1") {
    process.stderr.write(`rsp: ${rspDisabledReason()}, passing through\n`);
  }
  return await passthrough(argv);
}

function rspDisabledReason(): string {
  return "rsp is not enabled in this directory; run /red-setup";
}

function isWrapperCommand(command: string | undefined): boolean {
  return command === "git" || command === "gh" || command === "vitest" || command === "cargo" || command === "cat" ||
    command === "exec" || command === "proxy" || command === "gh-api-json";
}

async function passthrough(argv: readonly string[]): Promise<number> {
  if (argv[0] === "exec" || argv[0] === "proxy") return await passthroughShell(argv);
  const command = argv[0];
  if (!command) return 2;
  const { spawn } = await import("node:child_process");
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
      const { parseProxyCommandLine } = await import("./proxy.js");
      commandLine = parseProxyCommandLine(argv);
    } else {
      const { parseExecCommandLine } = await import("./exec-wrapper.js");
      commandLine = parseExecCommandLine(argv);
    }
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    return 2;
  }
  const { spawn } = await import("node:child_process");
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

function telemetryCommand(args: ParsedArgs): string {
  return passthroughTelemetryCommand(args.positional);
}

function passthroughTelemetryCommand(argv: readonly string[]): string {
  if (argv[0] !== "exec") return argv.join(" ");
  try {
    const separator = argv.indexOf("--");
    const parts = separator >= 0 ? argv.slice(separator + 1) : argv.slice(1);
    return parts.length === 1 ? parts[0]! : parts.join(" ");
  } catch {
    return argv.join(" ");
  }
}

function isHelpRequest(argv: readonly string[]): boolean {
  return argv[0] === "--help" || argv[0] === "-h" || argv.includes("--help") || argv.includes("-h");
}

function renderCliHelp(argv: readonly string[]): string {
  const command = argv[0] === "--help" || argv[0] === "-h" ? undefined : argv[0];
  const lines = commandHelpLines(command);
  return `${lines.join("\n")}\n`;
}

function commandHelpLines(command: string | undefined): string[] {
  switch (command) {
    case "stats":
      return scopedHelp("rsp stats [--since <days>d] [--full]", [
        "Defaults: --since 30d, --full false",
        "--since <days>d  telemetry window, default 30d",
        "--full           include wider daily/top-command/failure lists, default false",
        "--store-uri <uri> read a non-default store",
      ], ["rsp stats", "rsp stats --since 7d --full"]);
    case "gains":
      return scopedHelp("rsp gains [--since <days>d]", [
        "--since <days>d  gains window, default 28d",
        "--store-uri <uri> read a non-default shared RedDB store",
      ], ["rsp gains", "rsp gains --since 14d"]);
    case "show":
      return scopedHelp("rsp show <handle>", [
        "<handle>        elision handle such as el:<id>",
        "--store-uri <uri> read a non-default store",
      ], ["rsp show el:<id>", "rsp show <handle>"]);
    case "git":
      return scopedHelp("rsp git <status|log|diff|show|blame|branch|commit|push> [options]", [
        "--brief          compact output, default lossless",
        "--terse          aggressively summarize and mint recovery handles",
        "--query <text>   filter rendered rows",
        "--full           keep full supported wrapper detail",
      ], ["rsp git status --brief", "rsp git log --terse", "rsp git diff --query <path>"]);
    case "gh":
      return scopedHelp("rsp gh <pr|issue|run> <list|view> [options]", [
        "--brief          compact output, default lossless",
        "--terse          aggressively summarize and mint recovery handles",
        "--query <text>   filter rendered rows",
        "--full           keep full supported wrapper detail",
      ], ["rsp gh pr list --query <title-or-label>", "rsp gh issue view <number>", "rsp gh run list --limit 20"]);
    case "vitest":
      return scopedHelp("rsp vitest [run] [vitest-options]", [
        "--brief          compact output, default lossless",
        "--terse          summarize long failures and mint recovery handles",
        "--query <text>   filter failure rows",
      ], ["rsp vitest run", "rsp vitest run --query <suite-or-test>"]);
    case "cargo":
      return scopedHelp("rsp cargo test [cargo-test-options]", [
        "--brief          compact output, default lossless",
        "--terse          summarize long failures and mint recovery handles",
        "--query <text>   filter failure rows",
      ], ["rsp cargo test", "rsp cargo test --query <test-name>"]);
    case "cat":
      return scopedHelp("rsp cat [--head <n>|--tail <n>|--full] <file>", [
        "--head <n>       show first n lines, default slice 10",
        "--tail <n>       show last n lines, default slice 10",
        "--full           emit full text even when it is large",
        "--brief/--terse  reduce large text context",
      ], ["rsp cat <file>", "rsp cat --head 20 <file>", "rsp cat --tail 20 <file>"]);
    case "exec":
      return scopedHelp("rsp exec -- \"<command line>\"", [
        "--brief          compact recognized stdout, default lossless",
        "--terse          summarize large stdout and mint recovery handles",
        "--query <text>   filter supported structured summaries",
      ], ["rsp exec -- \"pnpm -C apps/rsp build\"", "rsp exec -- \"git status --short\""]);
    case "proxy":
      return scopedHelp("rsp proxy -- <command line>", [
        "--brief          compact recognized stdout, default lossless",
        "--terse          summarize recognized large stdout",
      ], ["rsp proxy -- git status", "rsp proxy -- pnpm test"]);
    case "wait":
      return [
        "usage: rsp wait <subcommand> [options]",
        "",
        "Flags and defaults:",
        "  --timeout <duration> default 30m for cmd, 60m for pr/run, 2h for release",
        "  --reason <text>     default empty",
        "  --signal-pid <pid>  optional completion signal target",
        "  --signal <signal>   default USR1",
        "  --notify-cmd <cmd>  optional completion command",
        "",
        "Examples:",
        "  rsp wait pr 123 --reason \"before merge\"",
        "  rsp wait run --branch feature/wait --latest",
        "  rsp wait release --tag \"v2.*\"",
        "  rsp wait cmd -- \"pnpm -C apps/rsp build\"",
        "  rsp wait ls",
        "",
        "Exit codes: 0 = success verdict, 1 = failure verdict, 2 = timeout/indeterminate.",
      ];
    case "doctor":
      return scopedHelp("rsp doctor [--since <days>d]", [
        "--since <days>d  recent degradation window, default 1d",
      ], ["rsp doctor", "rsp doctor --since 7d"]);
    case "status":
      return scopedHelp("rsp status", [
        "No flags. Prints resident registry status as TOON.",
      ], ["rsp status"]);
    case "sweep":
      return scopedHelp("rsp sweep", [
        "No flags. Removes stale resident registry entries and prints TOON status.",
      ], ["rsp sweep"]);
    case "setup":
      return scopedHelp("rsp setup", [
        "No flags. Provisions repo rsp configuration and store state.",
      ], ["rsp setup"]);
    case "mcp":
      return scopedHelp("rsp mcp", [
        "No flags. Starts the rsp MCP server over stdio.",
      ], ["rsp mcp"]);
    case "shell-init":
      return scopedHelp("rsp shell-init <fish|bash|zsh>", [
        "<fish|bash|zsh> target shell, no default",
      ], ["rsp shell-init bash", "rsp shell-init fish"]);
    case "server":
      return scopedHelp("rsp server [options]", [
        "--socket <path>                      default resident socket",
        "--pid-file <path>                    default resident pid file",
        "--store-uri <uri>                    default repo store",
        "--ttl-days <days>                    default from config",
        "--ephemeral-ttl-hours <hours>        default from config",
        "--byte-budget <bytes>                default from config",
        "--idle-ms <ms>                       default from config",
      ], ["rsp server", "rsp server --socket <path> --store-uri <uri>"]);
    case "warm-resident":
      return scopedHelp("rsp warm-resident [options]", [
        "--socket <path>               default resident socket",
        "--wake-lock <path>            default resident wake lock",
        "--store-uri <uri>             default repo store",
        "--idle-ms <ms>                default from config",
      ], ["rsp warm-resident", "rsp warm-resident --store-uri <uri>"]);
    case "gh-api-json":
      return scopedHelp("rsp gh-api-json <path> [-f name=value ...]", [
        "-f name=value     string GitHub API field",
        "-F name=value     typed GitHub API field",
      ], ["rsp gh-api-json repos/{owner}/{repo}", "rsp gh-api-json repos/{owner}/{repo}/pulls -f state=open"]);
    case "hook":
      return scopedHelp("rsp hook <claude-pre-exec|codex-pre-exec|claude-post-exec|codex-post-exec>", [
        "Reads hook payload from stdin. Defaults come from the calling host.",
      ], ["rsp hook codex-pre-exec", "rsp hook claude-pre-exec"]);
    case undefined:
      return [
        "usage: rsp <subcommand> [options]",
        "",
        "Bare invocation:",
        "  rsp",
        "    renders a live TOON dashboard with recovery handles, active waits, savings, and health.",
        "",
        "Subcommands:",
        "  stats, gains, show, git, gh, vitest, cargo, cat, exec, proxy, wait",
        "  doctor, status, sweep, setup, mcp, shell-init, server, warm-resident, gh-api-json, hook",
        "",
        "Global flags:",
        "  --store-uri <uri>  default repo store",
        "  --brief            compact summaries",
        "  --terse            aggressive summaries with recovery handles",
        "  --query <text>     filter supported rendered output",
        "  --help, -h         scoped help",
        "",
        "Examples:",
        "  rsp",
        "  rsp stats --since 7d",
        "  rsp git log --terse",
        "  rsp show el:<id>",
      ];
    default:
      return scopedHelp(`rsp ${command} [options]`, [
        "Unknown rsp subcommand. Use root help to list supported subcommands.",
      ], ["rsp --help"]);
  }
}

function scopedHelp(usage: string, flags: readonly string[], examples: readonly string[]): string[] {
  return [
    `usage: ${usage}`,
    "",
    "Flags and defaults:",
    ...flags.map((flag) => `  ${flag}`),
    "",
    "Examples:",
    ...examples.map((example) => `  ${example}`),
  ];
}

function parseArgs(argv: string[]): ParsedArgs {
  const out: ParsedArgs = { level: "lossless", positional: [] };
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--store-uri") out.storeUri = argv[++i];
    else if (arg === "--brief") out.level = "brief";
    else if (arg === "--terse") out.level = "terse";
    else if (arg === "--query") out.query = argv[++i];
    else if (arg.startsWith("--query=")) out.query = arg.slice("--query=".length);
    else if (positional.length === 0 && arg.startsWith("--")) throw new CliUsageError(arg);
    else positional.push(arg);
  }
  if (out.query && positional[0] !== "show" && !positional.some((arg) => arg === "--query" || arg.startsWith("--query="))) {
    positional.push("--query", out.query);
  }
  out.command = positional[0];
  out.handle = positional[1];
  out.positional = positional;
  return out;
}

class CliUsageError extends Error {
  constructor(readonly flag: string) {
    super(`unknown flag: ${flag}`);
  }

  render(): Buffer {
    return renderUnknownFlag("rsp", this.flag, ["--store-uri", "--brief", "--terse", "--query"], "rsp --help");
  }
}

function isStructuredUsageRenderable(err: unknown): err is { render: () => Buffer } {
  return typeof err === "object" && err !== null && "render" in err &&
    typeof (err as { render?: unknown }).render === "function";
}

function parseGhApiJsonArgs(argv: readonly string[]): { path: string; params: Record<string, string> } | null {
  const path = argv[1];
  if (!path) return null;
  const params: Record<string, string> = {};
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg !== "-f" && arg !== "-F") continue;
    const assignment = argv[++i] ?? "";
    const separator = assignment.indexOf("=");
    if (separator <= 0) continue;
    params[assignment.slice(0, separator)] = assignment.slice(separator + 1);
  }
  return { path, params };
}

function sinceDays(args: readonly string[], fallback: number): number {
  const raw = valueAfter(args, "--since") ?? args.find((arg) => arg.startsWith("--since="))?.slice("--since=".length);
  if (!raw) return fallback;
  const match = /^(\d+)(d)?$/.exec(raw);
  if (!match) return fallback;
  const days = Number(match[1]);
  return Number.isFinite(days) && days > 0 ? days : fallback;
}

function statsFull(args: readonly string[]): boolean {
  return args.includes("--full");
}

function renderStats(
  stats: { records: number; bytes: number; oldest: string | null; budget: number; storage_classes?: RspStorageClassStats },
  telemetry = emptyTelemetryStats(30),
  full = false,
): string {
  return `${encodeSnapshotToon(statsPayload(stats, telemetry, full))}\n`;
}

function statsPayload(
  stats: { records: number; bytes: number; oldest: string | null; budget: number; storage_classes?: RspStorageClassStats },
  telemetry: RspTelemetryStats,
  full: boolean,
): JsonObject {
  const topCommands = telemetry.savings.top_commands.slice(0, full ? 10 : 3);
  const daily = full ? telemetry.savings.daily_tokens_saved : telemetry.savings.daily_tokens_saved.slice(-7);
  const storageClasses = stats.storage_classes ?? emptyStorageClassStats();
  const recentFailures = telemetry.health.recent_failures.slice(0, full ? 20 : 5);
  const topPassReasons = telemetry.decisions.top_pass_reasons.slice(0, full ? 10 : 3);
  return {
    records: stats.records,
    bytes: stats.bytes,
    oldest: stats.oldest,
    budget: stats.budget,
    storage_classes: storageClasses as unknown as JsonObject,
    savings: {
      window_days: telemetry.window_days,
      empty: telemetry.empty,
      ...telemetry.savings,
      tokens_saved_display: formatTokensSaved(telemetry.savings),
      dollars_saved_estimate_usd_display: formatDollarsSaved(telemetry.savings),
      daily_tokens_saved: daily,
      daily_tokens_saved_elided: full ? 0 : Math.max(0, telemetry.savings.daily_tokens_saved.length - daily.length),
      top_commands: topCommands,
      top_commands_elided: full ? 0 : Math.max(0, telemetry.savings.top_commands.length - topCommands.length),
    } as unknown as JsonObject,
    health: {
      ...telemetry.health,
      degradation_rate_display: formatRate(telemetry.health.degradation_rate),
      show_hit_rate_display: formatRate(telemetry.health.show_hit_rate),
      by_reason: telemetry.health.by_reason,
      by_family: telemetry.health.by_family,
      recent_failures: recentFailures,
      recent_failures_elided: full ? 0 : Math.max(0, telemetry.health.recent_failures.length - recentFailures.length),
      most_recent_degradation_at: telemetry.health.most_recent?.timestamp ?? null,
      most_recent_degradation_reason: telemetry.health.most_recent?.reason ?? null,
    } as unknown as JsonObject,
    decisions: {
      ...telemetry.decisions,
      contribution_rate_display: formatRate(telemetry.decisions.contribution_rate),
      top_pass_reasons: topPassReasons,
      top_pass_reasons_elided: full ? 0 : Math.max(0, telemetry.decisions.top_pass_reasons.length - topPassReasons.length),
    } as unknown as JsonObject,
    latency: {
      ...telemetry.latency,
      wrapper_ms_p50_display: formatNullable(telemetry.latency.wrapper_ms_p50),
      wrapper_ms_p95_display: formatNullable(telemetry.latency.wrapper_ms_p95),
      store_elapsed_ms_avg_display: formatNullable(telemetry.latency.store_elapsed_ms_avg),
    } as unknown as JsonObject,
  };
}

function renderGainsReportToon(report: RspTelemetryGainsReport): string {
  return `${encodeSnapshotToon(report as unknown as JsonObject)}\n`;
}

function formatTokensSaved(savings: RspTelemetryStats["savings"]): string {
  if (!savings.tokens_saved_estimated) return String(savings.tokens_saved);
  return `${savings.tokens_saved_low}-${savings.tokens_saved_high} (estimate_midpoint: ${savings.tokens_saved}, range_pct: ${savings.token_estimate_range_pct})`;
}

function formatDollarsSaved(savings: RspTelemetryStats["savings"]): string {
  if (savings.dollars_saved_low_usd == null || savings.dollars_saved_high_usd == null) {
    return formatUsd(savings.dollars_saved_estimate_usd);
  }
  return `${formatUsd(savings.dollars_saved_low_usd)}-${formatUsd(savings.dollars_saved_high_usd)} (estimate_midpoint: ${formatUsd(savings.dollars_saved_estimate_usd)})`;
}

function renderDaily(series: Array<{ date: string; tokens_saved: number }>): string[] {
  if (series.length === 0) return ["    empty: true"];
  return series.map((entry) => `    ${entry.date}: ${entry.tokens_saved}`);
}

function renderTopCommands(commands: Array<{ command: string; invocations: number; bytes_saved: number; tokens_saved: number }>): string[] {
  if (commands.length === 0) return ["    empty: true"];
  return commands.map((entry) =>
    `    - command: ${entry.command} invocations: ${entry.invocations} bytes_saved: ${entry.bytes_saved} tokens_saved: ${entry.tokens_saved}`
  );
}

function renderReasons(reasons: Array<{ reason: string; count: number }>): string[] {
  if (reasons.length === 0) return ["    empty: true"];
  return reasons.map((entry) => `    ${entry.reason}: ${entry.count}`);
}

function renderFamilyCounts(families: Array<{ family: string; count: number }>): string[] {
  if (families.length === 0) return ["    empty: true"];
  return families.map((entry) => `    ${entry.family}: ${entry.count}`);
}

function renderRecentFailures(failures: RspTelemetryStats["health"]["recent_failures"]): string[] {
  if (failures.length === 0) return ["    empty: true"];
  return failures.map((entry) =>
    `    - at: ${entry.timestamp || "unknown"} family: ${entry.family} command: ${entry.command} reason: ${entry.reason} exit_code: ${
      entry.exit_code ?? "none"
    } stderr_head: ${entry.stderr_head ?? "none"}`
  );
}

function renderStorageClasses(stats: RspStorageClassStats): string[] {
  return (["derivable", "re-executable", "ephemeral"] as const).map((storageClass) =>
    `  ${storageClass}: records: ${stats[storageClass].records} bytes: ${stats[storageClass].bytes} raw_bytes: ${stats[storageClass].raw_bytes}`
  );
}

function formatNullable(value: number | null): string {
  return value == null ? "none" : String(value);
}

function formatRate(value: number): string {
  return value.toFixed(4).replace(/0+$/, "").replace(/\.$/, ".0");
}

function emptyTelemetryStats(windowDays: number): RspTelemetryStats {
  return {
    window_days: windowDays,
    empty: true,
    savings: {
      invocations: 0,
      elided: 0,
      raw_bytes: 0,
      emitted_bytes: 0,
      bytes_saved: 0,
      tokens_saved: 0,
      tokens_saved_estimated: false,
      token_estimate_range_pct: null,
      tokens_saved_low: null,
      tokens_saved_high: null,
      dollars_saved_estimate_usd: 0,
      dollars_saved_low_usd: null,
      dollars_saved_high_usd: null,
      pricing_model_family: "gpt-5",
      pricing_input_usd_per_million_tokens: 1.25,
      pricing_note: "estimate derived from byte-based token estimate when token counts are estimated",
      daily_tokens_saved: [],
      top_commands: [],
    },
    health: {
      degradations: 0,
      degradation_rate: 0,
      show_total: 0,
      show_hits: 0,
      show_misses: 0,
      show_hit_rate: 0,
      by_reason: [],
      by_family: [],
      recent_failures: [],
      most_recent: null,
    },
    latency: {
      wrapper_ms_p50: null,
      wrapper_ms_p95: null,
      store_open_count_sum: 0,
      store_elapsed_ms_sum: 0,
      store_elapsed_ms_avg: null,
    },
    decisions: {
      seen: 0,
      contributed: 0,
      passed: 0,
      failed_open: 0,
      quota_free_saved_units: 0,
      contribution_rate: 0,
      top_pass_reasons: [],
    },
  };
}

function emptyAccountingStats(byteBudget: number): RspAccountingLaneStats {
  return {
    records: 0,
    bytes: 0,
    oldest: null,
    budget: byteBudget,
    storage_classes: emptyStorageClassStats(),
  };
}

function emptyStorageClassStats(): RspStorageClassStats {
  return {
    derivable: { records: 0, bytes: 0, raw_bytes: 0 },
    "re-executable": { records: 0, bytes: 0, raw_bytes: 0 },
    ephemeral: { records: 0, bytes: 0, raw_bytes: 0 },
  };
}

function renderSetupResult(result: {
  configChanged: boolean;
  storeCreated: boolean;
  legacyStoreMigrated?: boolean;
}): string {
  const storeState = result.legacyStoreMigrated ? "migrated" : result.storeCreated ? "created" : "existing";
  return [
    `config: ${result.configChanged ? "updated" : "unchanged"}`,
    `store: ${storeState}`,
    "",
  ].join("\n");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().then((code) => process.exit(code), (err) => {
    if (isStructuredUsageRenderable(err)) {
      process.stdout.write(err.render());
      process.exit(2);
    }
    process.stdout.write(renderStructuredError({
      command: "rsp",
      category: "real-error",
      error: err instanceof Error ? err.message : String(err),
      help: "rsp --help",
    }));
    process.exit(1);
  });
}

export { main, renderSetupResult, renderStats };
