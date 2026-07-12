#!/usr/bin/env node
import { existsSync, readdirSync } from "node:fs";
import type { RspElisionStore } from "./elision-store.js";
import type { ResidentResponseMetrics } from "./resident-client.js";

interface ParsedArgs {
  command?: string;
  handle?: string;
  storeUri?: string;
  query?: string;
  level: "lossless" | "brief" | "terse";
  positional: string[];
}

async function main(argv = process.argv.slice(2)): Promise<number> {
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
    return await runFastGitStatus();
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
      idleMs: numericValueAfter(args.positional, "--idle-ms"),
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
    });
    return 0;
  }

  const { existsSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const residentPaths = resolveResidentPaths(process.cwd());
  if (!args.storeUri && config.storeUri.startsWith("file://") && !existsSync(fileURLToPath(config.storeUri))) {
    if (wrapperCommand) return await degradeToPassthrough("store not provisioned", args.positional, undefined, residentPaths.rootDir);
    process.stdout.write("error: rsp repo store is not provisioned - run /red-setup\n");
    return 1;
  }
  const openResidentStore = () => Promise.resolve(new ResidentRspElisionStore(residentPaths, {
    storeUri: config.storeUri,
    ttlDays: config.ttlDays,
    byteBudget: config.byteBudget,
    telemetryTtlDays: config.telemetryTtlDays,
    telemetryByteBudget: config.telemetryByteBudget,
  }));
  const warmResidentStore = () => ensureResidentServer(residentPaths, {
    storeUri: config.storeUri,
    ttlDays: config.ttlDays,
    byteBudget: config.byteBudget,
    telemetryTtlDays: config.telemetryTtlDays,
    telemetryByteBudget: config.telemetryByteBudget,
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
    if (!args.command) {
      const store = await openReadStore();
      closeStore = () => store.close();
      const stats = await store.stats();
      process.stdout.write(renderStats(stats));
      return 0;
    }

    if (args.command === "git") {
      try {
        await suppressRspStderr(warmResidentStore);
      } catch (err) {
        return await degradeToPassthrough("resident unavailable", args.positional, err, residentPaths.rootDir);
      }
      if (isFastGitStatus(args.positional)) return await runFastGitStatus();
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
        return await degradeToPassthrough("resident unavailable", args.positional, err, residentPaths.rootDir);
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
        return await degradeToPassthrough("resident unavailable", args.positional, err, residentPaths.rootDir);
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

async function runFastGitStatus(): Promise<number> {
  if (isEmptyUnbornGitRepo(process.cwd())) {
    process.stdout.write("git empty\n");
    return 0;
  }

  const { spawnSync } = await import("node:child_process");
  const clean = spawnSync("git", ["diff-index", "--quiet", "HEAD", "--"], { stdio: "ignore" });
  if (clean.status === 0) {
    process.stdout.write("git empty\n");
    return 0;
  }

  const status = spawnSync("git", ["status", "--porcelain=v1"], { encoding: "buffer" });
  if ((status.status ?? 0) !== 0) {
    process.stdout.write(status.stdout);
    process.stderr.write(status.stderr);
    return status.status ?? 1;
  }
  process.stdout.write(status.stdout.length === 0 ? "git empty\n" : status.stdout);
  return 0;
}

function isEmptyUnbornGitRepo(cwd: string): boolean {
  try {
    if (!existsSync(`${cwd}/.git`) || existsSync(`${cwd}/.git/index`)) return false;
    return readdirSync(cwd).every((entry) => entry === ".git");
  } catch {
    return false;
  }
}

type ElisionStoreLike = Pick<RspElisionStore, "mint" | "close"> & {
  lastResponseMetrics?: () => ResidentResponseMetrics | undefined;
};

interface WrappedCommandResult {
  stdout: Buffer;
  stderr: Buffer;
  status: number | null;
  signal: NodeJS.Signals | null;
  mintedHandle?: `el:${string}`;
  bytesElided?: number;
  rawOutput?: Buffer;
}

class LazyRspElisionStore implements ElisionStoreLike {
  private store?: Promise<ElisionStoreLike>;
  private metrics?: ResidentResponseMetrics;

  constructor(private readonly openStore: () => Promise<ElisionStoreLike>) {}

  async mint(...args: Parameters<RspElisionStore["mint"]>): ReturnType<RspElisionStore["mint"]> {
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

async function emitWrappedResult(
  args: ParsedArgs,
  result: WrappedCommandResult,
  started: bigint,
  store: LazyRspElisionStore,
): Promise<number> {
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  const wrapperMs = Number(process.hrtime.bigint() - started) / 1_000_000;
  await appendInvocationTelemetry(args, result, wrapperMs, store.lastResponseMetrics());
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

function renderStats(stats: { records: number; bytes: number; oldest: string | null; budget: number }): string {
  return [
    `records: ${stats.records}`,
    `bytes: ${stats.bytes}`,
    `oldest: ${stats.oldest ?? "none"}`,
    `budget: ${stats.budget}`,
    "",
  ].join("\n");
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
