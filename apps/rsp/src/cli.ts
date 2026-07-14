#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { connect } from "@reddb-io/sdk";
import { encode, type JsonObject } from "@reddb-io/toon";
import { readBuildInfo } from "@reddb-io/build-info";
import type { RspRuntimeConfig } from "./config.js";
import type { RspElisionStore, RspMintMeta, RspStorageClassStats } from "./elision-store.js";
import { formatUsd } from "./pricing.js";
import type { ResidentResponseMetrics } from "./resident-client.js";
import type { RspAccountingLaneStats, RspTelemetryGainsReport, RspTelemetryStats } from "./telemetry.js";

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
      process.stdout.write("error: usage rsp shell-init fish|bash|zsh\n");
      return 2;
    }
    const { renderShellInit } = await import("./shell-init.js");
    process.stdout.write(renderShellInit(shell));
    return 0;
  }
  const { resolveRspConfig } = await import("./config.js");
  const config = resolveRspConfig(process.cwd(), process.env, args.storeUri);
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

  const residentPaths = resolveResidentPaths(process.cwd());
  if (args.command === "status" || args.command === "sweep") {
    const { residentRegistryStatus, sweepResidentRegistry } = await import("./resident-client.js");
    const status = args.command === "sweep"
      ? await sweepResidentRegistry(residentPaths)
      : await residentRegistryStatus(residentPaths);
    process.stdout.write(`${encode(status as unknown as JsonObject)}\n`);
    return 0;
  }
  if (!args.storeUri && config.storeUri.startsWith("file://") && !existsSync(fileURLToPath(config.storeUri))) {
    if (wrapperCommand) return await runColdWrappedCommand(args, config, residentPaths.rootDir);
    process.stdout.write("error: rsp repo store is not provisioned - run /red-setup\n");
    return 1;
  }
  const openResidentStore = (ensureResident = true) => Promise.resolve(new ResidentRspElisionStore(residentPaths, {
    storeUri: config.storeUri,
    ttlDays: config.ttlDays,
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
      byteBudget: config.byteBudget,
    });
  };
  const openReadStore = () => !config.storeUri.endsWith("/red-skills.rdb")
    ? openDirectStore()
    : openResidentStore();
  let closeStore: (() => Promise<void>) | undefined;
  try {
    if (!args.command || args.command === "stats") {
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
        const text = `expired ${record.expired_at} — re-run: ${record.command}\n`;
        process.stdout.write(text);
        await appendShowAccountingEvent(residentPaths.rootDir, args.handle, false, Buffer.byteLength(text, "utf8"));
        return 1;
      }
      const text = `expired unknown — re-run: ${args.handle}\n`;
      process.stdout.write(text);
      await appendShowAccountingEvent(residentPaths.rootDir, args.handle, false, Buffer.byteLength(text, "utf8"));
      return 1;
    }

    process.stdout.write("error: usage rsp show el:<id>\n");
    return 2;
  } catch (err) {
    if (wrapperCommand) return await degradeToPassthrough("wrapper failed", args.positional, err, residentPaths.rootDir);
    throw err;
  } finally {
    await closeStore?.();
  }
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
      stdout: Buffer.from("git empty\n"),
      stderr: Buffer.alloc(0),
      status: 0,
      signal: null,
    };
  }

  const { spawnSync } = await import("node:child_process");
  const clean = spawnSync("git", ["diff-index", "--quiet", "HEAD", "--"], { stdio: "ignore" });
  if (clean.status === 0) {
    return {
      stdout: Buffer.from("git empty\n"),
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
  const stdout = status.stdout.length === 0 ? Buffer.from("git empty\n") : status.stdout;
  return {
    stdout,
    stderr: status.stderr,
    status: 0,
    signal: status.signal,
    rawOutput: stdout,
  };
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
    const spoolPath = join(telemetryRoot, ".red", "tmp", "rsp-telemetry.spool.jsonl");
    const stat = statSync(spoolPath);
    const staleMs = config.telemetryDrainIntervalMs * 2;
    if (stat.size < config.telemetryByteBudget && !spoolHasEventOlderThan(spoolPath, Date.now() - staleMs)) return;
    const rootDir = fastResidentRoot(telemetryRoot);
    const socketDir = fastResidentSocketDir(rootDir);
    const socketPath = join(socketDir, "rsp.sock");
    const pidPath = join(socketDir, "rsp.pid");
    const registryPath = join(rootDir, ".red", "tmp", "rsp-resident.pid.json");
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
    const path = join(telemetryRoot, ".red", "tmp", "rsp-telemetry.spool.jsonl");
    const accountingLine = JSON.stringify({
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
    const legacyLine = JSON.stringify({
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
    const line = `${accountingLine}\n${legacyLine}\n`;
    try {
      appendFileSync(path, line, { encoding: "utf8", mode: 0o600 });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") return;
      mkdirSync(dirname(path), { recursive: true });
      appendFileSync(path, line, { encoding: "utf8", mode: 0o600 });
    }
  } catch {}
}

async function degradeToPassthrough(reason: string, argv: readonly string[], err?: unknown, telemetryRoot?: string): Promise<number> {
  if (process.env.RSP_DEBUG === "1") {
    throw err instanceof Error ? err : new Error(reason);
  }
  process.stderr.write(`rsp: ${reason}, passing through\n`);
  const status = await passthrough(argv);
  if (telemetryRoot) {
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
      degradation_reason: reason,
    }));
    fireAndForget(appendTelemetryEvent(telemetryRoot, {
      collection: RSP_TELEMETRY_DEGRADATIONS_COLLECTION,
      ts: new Date().toISOString(),
      command: passthroughTelemetryCommand(argv),
      reason,
      accounting_recorded: true,
    }));
  }
  return status;
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
  return command === "git" || command === "gh" || command === "vitest" || command === "cargo" || command === "cat" || command === "exec";
}

async function passthrough(argv: readonly string[]): Promise<number> {
  if (argv[0] === "exec") return await passthroughShell(argv);
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
    const { parseExecCommandLine } = await import("./exec-wrapper.js");
    commandLine = parseExecCommandLine(argv);
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
  const topCommands = telemetry.savings.top_commands.slice(0, full ? 10 : 3);
  const daily = full ? telemetry.savings.daily_tokens_saved : telemetry.savings.daily_tokens_saved.slice(-7);
  const storageClasses = stats.storage_classes ?? emptyStorageClassStats();
  return [
    `records: ${stats.records}`,
    `bytes: ${stats.bytes}`,
    `oldest: ${stats.oldest ?? "none"}`,
    `budget: ${stats.budget}`,
    "storage_classes:",
    ...renderStorageClasses(storageClasses),
    "savings:",
    `  window_days: ${telemetry.window_days}`,
    `  empty: ${telemetry.empty}`,
    `  invocations: ${telemetry.savings.invocations}`,
    `  elided: ${telemetry.savings.elided}`,
    `  raw_bytes: ${telemetry.savings.raw_bytes}`,
    `  emitted_bytes: ${telemetry.savings.emitted_bytes}`,
    `  bytes_saved: ${telemetry.savings.bytes_saved}`,
    `  tokens_saved: ${formatTokensSaved(telemetry.savings)}`,
    `  dollars_saved_estimate_usd: ${formatDollarsSaved(telemetry.savings)}`,
    `  pricing_model_family: ${telemetry.savings.pricing_model_family}`,
    `  pricing_input_usd_per_million_tokens: ${telemetry.savings.pricing_input_usd_per_million_tokens}`,
    `  pricing_note: ${telemetry.savings.pricing_note}`,
    "  daily_tokens_saved:",
    ...renderDaily(daily),
    ...(!full && telemetry.savings.daily_tokens_saved.length > daily.length
      ? [`    elided_days: ${telemetry.savings.daily_tokens_saved.length - daily.length}`, "    hint: --full"]
      : []),
    "  top_commands:",
    ...renderTopCommands(topCommands),
    "health:",
    `  degradations: ${telemetry.health.degradations}`,
    `  degradation_rate: ${formatRate(telemetry.health.degradation_rate)}`,
    `  show_total: ${telemetry.health.show_total}`,
    `  show_hits: ${telemetry.health.show_hits}`,
    `  show_misses: ${telemetry.health.show_misses}`,
    `  show_hit_rate: ${formatRate(telemetry.health.show_hit_rate)}`,
    `  most_recent_degradation_at: ${telemetry.health.most_recent?.timestamp ?? "none"}`,
    `  most_recent_degradation_reason: ${telemetry.health.most_recent?.reason ?? "none"}`,
    "  degradations_by_reason:",
    ...renderReasons(telemetry.health.by_reason),
    "decisions:",
    `  seen: ${telemetry.decisions.seen}`,
    `  contributed: ${telemetry.decisions.contributed}`,
    `  passed: ${telemetry.decisions.passed}`,
    `  failed_open: ${telemetry.decisions.failed_open}`,
    `  contribution_rate: ${formatRate(telemetry.decisions.contribution_rate)}`,
    "  top_pass_reasons:",
    ...renderReasons(telemetry.decisions.top_pass_reasons.slice(0, full ? 10 : 3)),
    "latency:",
    `  wrapper_ms_p50: ${formatNullable(telemetry.latency.wrapper_ms_p50)}`,
    `  wrapper_ms_p95: ${formatNullable(telemetry.latency.wrapper_ms_p95)}`,
    `  store_open_count_sum: ${telemetry.latency.store_open_count_sum}`,
    `  store_elapsed_ms_sum: ${telemetry.latency.store_elapsed_ms_sum}`,
    `  store_elapsed_ms_avg: ${formatNullable(telemetry.latency.store_elapsed_ms_avg)}`,
    "",
  ].join("\n");
}

function renderGainsReportToon(report: RspTelemetryGainsReport): string {
  return `${encode(report as unknown as JsonObject)}\n`;
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

function renderStorageClasses(stats: RspStorageClassStats): string[] {
  return (["derivable", "re-executable", "ephemeral"] as const).map((storageClass) =>
    `  ${storageClass}: records: ${stats[storageClass].records} bytes: ${stats[storageClass].bytes}`
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
    derivable: { records: 0, bytes: 0 },
    "re-executable": { records: 0, bytes: 0 },
    ephemeral: { records: 0, bytes: 0 },
  };
}

function renderSetupResult(result: { configChanged: boolean; storeCreated: boolean }): string {
  return [
    `config: ${result.configChanged ? "updated" : "unchanged"}`,
    `store: ${result.storeCreated ? "created" : "existing"}`,
    "",
  ].join("\n");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().then((code) => process.exit(code), (err) => {
    process.stdout.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}

export { main, renderSetupResult, renderStats };
