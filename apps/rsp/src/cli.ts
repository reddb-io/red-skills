#!/usr/bin/env node
import { appendFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { encode, type JsonObject } from "@reddb-io/toon";
import { readBuildInfo } from "@reddb-io/build-info";
import type { RspRuntimeConfig } from "./config.js";
import type { RspElisionStore, RspMintMeta } from "./elision-store.js";
import type { ResidentResponseMetrics } from "./resident-client.js";
import type { RspTelemetryGainsReport, RspTelemetryStats } from "./telemetry.js";

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
  if (args.command === "hook" && args.positional[1] === "claude-post-exec") {
    const { runClaudePostExecHook } = await import("./normalize.js");
    return await runClaudePostExecHook();
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
  const { resolveRspConfig } = await import("./config.js");
  const config = resolveRspConfig(process.cwd(), process.env, args.storeUri);
  const wrapperCommand = isWrapperCommand(args.command);
  if (!config.enabled) {
    if (wrapperCommand) return await degradeToPassthrough(rspDisabledReason(), args.positional);
    process.stdout.write(`${rspDisabledReason()}\n`);
    return 0;
  }
  if (args.command === "git" && isFastGitStatus(args.positional) && await residentSocketExists(process.cwd())) {
    const started = process.hrtime.bigint();
    return await emitWrappedResult(args, await runFastGitStatus(), started);
  }
  const { resolveResidentPaths, ResidentRspElisionStore, ensureResidentServer } = await import("./resident-client.js");
  if (args.command === "server") {
    const { runResidentServer } = await import("./resident-server.js");
    const socket = valueAfter(args.positional, "--socket") ?? resolveResidentPaths(process.cwd()).socketPath;
    const serverConfig = resolveRspConfig(process.cwd(), process.env, args.storeUri ?? valueAfter(args.positional, "--store-uri"));
    if (!serverConfig.enabled) {
      process.stdout.write(`${rspDisabledReason()}\n`);
      return 0;
    }
    await runResidentServer({
      socketPath: socket,
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

  const { existsSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const residentPaths = resolveResidentPaths(process.cwd());
  if (!args.storeUri && config.storeUri.startsWith("file://") && !existsSync(fileURLToPath(config.storeUri))) {
    if (wrapperCommand) return await runColdWrappedCommand(args, config, residentPaths.rootDir);
    process.stdout.write("error: rsp repo store is not provisioned - run /red-setup\n");
    return 1;
  }
  const openResidentStore = () => Promise.resolve(new ResidentRspElisionStore(residentPaths, {
    storeUri: config.storeUri,
    ttlDays: config.ttlDays,
    byteBudget: config.byteBudget,
    telemetryTtlDays: config.telemetryTtlDays,
    telemetryByteBudget: config.telemetryByteBudget,
    telemetryDrainIntervalMs: config.telemetryDrainIntervalMs,
    telemetryDrainTimeoutMs: config.telemetryDrainTimeoutMs,
    idleMs: config.idleMs,
    clientVersion: buildInfo.version,
  }));
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
      const store = await openReadStore();
      closeStore = () => store.close();
      const stats = await store.stats();
      const telemetry = hasTelemetryStats(store)
        ? await store.telemetryStats(sinceDays(args.positional, 30))
        : emptyTelemetryStats(sinceDays(args.positional, 30));
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
      try {
        await suppressRspStderr(warmResidentStore);
      } catch (err) {
        return await runColdWrappedCommand(args, config, residentPaths.rootDir, err);
      }
      if (isFastGitStatus(args.positional)) {
        const started = process.hrtime.bigint();
        return await emitWrappedResult(args, await runFastGitStatus(), started);
      }
      const { runGitWrapper } = await import("./git-wrapper.js");
      const store = new LazyRspElisionStore(() => suppressRspStderr(openResidentStore));
      closeStore = () => store.close();
      const started = process.hrtime.bigint();
      const result = await suppressRspStderr(() => runGitWrapper(args.positional, {
        level: args.level,
        store,
        heavyGitByteThreshold: config.heavyGitByteThreshold,
      }));
      return await emitWrappedResult(args, result, started, store);
    }

    if (args.command === "gh") {
      try {
        await suppressRspStderr(warmResidentStore);
      } catch (err) {
        return await runColdWrappedCommand(args, config, residentPaths.rootDir, err);
      }
      const { runGhWrapper } = await import("./gh-wrapper.js");
      const store = new LazyRspElisionStore(() => suppressRspStderr(openResidentStore));
      closeStore = () => store.close();
      const started = process.hrtime.bigint();
      const result = await suppressRspStderr(() => runGhWrapper(args.positional, { level: args.level, store }));
      return await emitWrappedResult(args, result, started, store);
    }

    if (args.command === "vitest" || args.command === "cargo") {
      try {
        await suppressRspStderr(warmResidentStore);
      } catch (err) {
        return await runColdWrappedCommand(args, config, residentPaths.rootDir, err);
      }
      const { runTestWrapper } = await import("./test-wrapper.js");
      const store = new LazyRspElisionStore(() => suppressRspStderr(openResidentStore));
      closeStore = () => store.close();
      const started = process.hrtime.bigint();
      const result = await suppressRspStderr(() => runTestWrapper(args.positional, { level: args.level, store }));
      return await emitWrappedResult(args, result, started, store);
    }

    if (args.command === "show" && args.handle) {
      const store = await openReadStore();
      closeStore = () => store.close();
      const record = await store.get(args.handle);
      if (record && "original" in record && record.original) {
        process.stdout.write(record.original);
        return 0;
      }
      if (record?.status === "expired") {
        process.stdout.write(`expired ${record.expired_at} — re-run: ${record.command}\n`);
        return 1;
      }
      process.stdout.write(`expired unknown — re-run: ${args.handle}\n`);
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

async function residentSocketExists(cwd: string): Promise<boolean> {
  const { resolveResidentPaths } = await import("./resident-client.js");
  return existsSync(resolveResidentPaths(cwd).socketPath);
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
    const store = await this.open();
    const handle = await store.mint(...args);
    this.metrics = store.lastResponseMetrics?.();
    return handle;
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
  config: Pick<RspRuntimeConfig, "heavyGitByteThreshold">,
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
        return await emitWrappedResult(args, await runFastGitStatus(), started, store);
      }
      const { runGitWrapper } = await import("./git-wrapper.js");
      const result = await runGitWrapper(args.positional, {
        level: args.level,
        store,
        heavyGitByteThreshold: config.heavyGitByteThreshold,
      });
      return await emitWrappedResult(args, result, started, store);
    }

    if (args.command === "gh") {
      const { runGhWrapper } = await import("./gh-wrapper.js");
      const result = await runGhWrapper(args.positional, { level: args.level, store });
      return await emitWrappedResult(args, result, started, store);
    }

    if (args.command === "vitest" || args.command === "cargo") {
      const { runTestWrapper } = await import("./test-wrapper.js");
      const result = await runTestWrapper(args.positional, { level: args.level, store });
      return await emitWrappedResult(args, result, started, store);
    }
  } catch (coldErr) {
    return await degradeToPassthrough("wrapper failed", args.positional, coldErr, telemetryRoot);
  } finally {
    await store.close();
  }

  return await degradeToPassthrough("wrapper failed", args.positional, err, telemetryRoot);
}

async function emitWrappedResult(
  args: ParsedArgs,
  result: WrappedCommandResult,
  started: bigint,
  store?: InvocationTelemetryStore,
): Promise<number> {
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  const wrapperMs = Number(process.hrtime.bigint() - started) / 1_000_000;
  if (store) {
    await appendInvocationTelemetry(args, result, wrapperMs, store.lastResponseMetrics());
  } else {
    appendFastInvocationTelemetry(args, result, wrapperMs);
  }
  if (result.signal) {
    process.kill(process.pid, result.signal);
    return 128;
  }
  return result.status ?? 0;
}

async function appendInvocationTelemetry(
  args: ParsedArgs,
  result: WrappedCommandResult,
  wrapperMs: number,
  metrics?: ResidentResponseMetrics,
): Promise<void> {
  const emitted = Buffer.concat([result.stdout, result.stderr]);
  const raw = Buffer.concat([result.rawOutput ?? result.stdout, result.stderr]);
  const { appendTelemetryEvent, RSP_TELEMETRY_INVOCATIONS_COLLECTION } = await import("./telemetry.js");
  await appendTelemetryEvent(process.cwd(), {
    collection: RSP_TELEMETRY_INVOCATIONS_COLLECTION,
    ts: new Date().toISOString(),
    command: args.positional.join(" "),
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
  });
}

function appendFastInvocationTelemetry(
  args: ParsedArgs,
  result: WrappedCommandResult,
  wrapperMs: number,
): void {
  try {
    const emitted = Buffer.concat([result.stdout, result.stderr]);
    const raw = Buffer.concat([result.rawOutput ?? result.stdout, result.stderr]);
    const path = join(process.cwd(), ".red", "tmp", "rsp-telemetry.spool.jsonl");
    const line = `${JSON.stringify({
      collection: "rsp_telemetry_invocations_v1",
      ts: new Date().toISOString(),
      command: args.positional.join(" "),
      wrapper: args.command,
      loss: args.level,
      elided: Boolean(result.mintedHandle || result.bytesElided),
      raw_bytes: raw.length,
      emitted_bytes: emitted.length,
      wrapper_ms: wrapperMs,
    })}\n`;
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
    const { appendTelemetryEvent, RSP_TELEMETRY_DEGRADATIONS_COLLECTION } = await import("./telemetry.js");
    await appendTelemetryEvent(telemetryRoot, {
      collection: RSP_TELEMETRY_DEGRADATIONS_COLLECTION,
      ts: new Date().toISOString(),
      command: argv.join(" "),
      reason,
    });
  }
  return status;
}

function rspDisabledReason(): string {
  return "rsp is not enabled in this directory; run /red-setup";
}

async function suppressRspStderr<T>(fn: () => Promise<T>): Promise<T> {
  const write = process.stderr.write;
  process.stderr.write = (() => true) as typeof process.stderr.write;
  try {
    return await fn();
  } finally {
    process.stderr.write = write;
  }
}

function isWrapperCommand(command: string | undefined): boolean {
  return command === "git" || command === "gh" || command === "vitest" || command === "cargo";
}

async function passthrough(argv: readonly string[]): Promise<number> {
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
  stats: { records: number; bytes: number; oldest: string | null; budget: number },
  telemetry = emptyTelemetryStats(30),
  full = false,
): string {
  const topCommands = telemetry.savings.top_commands.slice(0, full ? 10 : 3);
  const daily = full ? telemetry.savings.daily_tokens_saved : telemetry.savings.daily_tokens_saved.slice(-7);
  return [
    `records: ${stats.records}`,
    `bytes: ${stats.bytes}`,
    `oldest: ${stats.oldest ?? "none"}`,
    `budget: ${stats.budget}`,
    "savings:",
    `  window_days: ${telemetry.window_days}`,
    `  empty: ${telemetry.empty}`,
    `  invocations: ${telemetry.savings.invocations}`,
    `  elided: ${telemetry.savings.elided}`,
    `  raw_bytes: ${telemetry.savings.raw_bytes}`,
    `  emitted_bytes: ${telemetry.savings.emitted_bytes}`,
    `  bytes_saved: ${telemetry.savings.bytes_saved}`,
    `  tokens_saved: ${telemetry.savings.tokens_saved}`,
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
    `  most_recent_degradation_at: ${telemetry.health.most_recent?.timestamp ?? "none"}`,
    `  most_recent_degradation_reason: ${telemetry.health.most_recent?.reason ?? "none"}`,
    "  degradations_by_reason:",
    ...renderReasons(telemetry.health.by_reason),
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
      daily_tokens_saved: [],
      top_commands: [],
    },
    health: {
      degradations: 0,
      degradation_rate: 0,
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
