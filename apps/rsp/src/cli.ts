#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { RspElisionStore } from "./elision-store.js";
import { resolveRspConfig } from "./config.js";
import { ResidentRspElisionStore, resolveResidentPaths } from "./resident-client.js";

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
  if (args.command === "server") {
    const { runResidentServer } = await import("./resident-server.js");
    const socket = valueAfter(args.positional, "--socket") ?? resolveResidentPaths(process.cwd()).socketPath;
    const storeUri = args.storeUri ?? valueAfter(args.positional, "--store-uri");
    if (!storeUri) throw new Error("rsp server requires --store-uri");
    await runResidentServer({
      socketPath: socket,
      storeUri,
      ttlDays: numericValueAfter(args.positional, "--ttl-days") ?? 7,
      byteBudget: numericValueAfter(args.positional, "--byte-budget") ?? 64 * 1024 * 1024,
    });
    return 0;
  }

  const config = resolveRspConfig(process.cwd(), process.env, args.storeUri);
  const residentPaths = resolveResidentPaths(process.cwd());
  const wrapperCommand = isWrapperCommand(args.command);
  if (!args.storeUri && config.storeUri.startsWith("file://") && !existsSync(fileURLToPath(config.storeUri))) {
    if (wrapperCommand) return await degradeToPassthrough("store not provisioned", args.positional);
    process.stdout.write("error: rsp repo store is not provisioned - run /red-setup\n");
    return 1;
  }
  const openResidentStore = () => Promise.resolve(new ResidentRspElisionStore(residentPaths, {
    storeUri: config.storeUri,
    ttlDays: config.ttlDays,
    byteBudget: config.byteBudget,
  }));
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
      if (isFastGitStatus(args.positional)) return await runFastGitStatus();
      const { runGitWrapper } = await import("./git-wrapper.js");
      const store = new LazyRspElisionStore(() => suppressRspStderr(openResidentStore));
      closeStore = () => store.close();
      const result = await suppressRspStderr(() => runGitWrapper(args.positional, {
        level: args.level,
        store,
        heavyGitByteThreshold: config.heavyGitByteThreshold,
      }));
      process.stdout.write(result.stdout);
      process.stderr.write(result.stderr);
      if (result.signal) {
        process.kill(process.pid, result.signal);
        return 128;
      }
      return result.status ?? 0;
    }

    if (args.command === "gh") {
      const { runGhWrapper } = await import("./gh-wrapper.js");
      const store = new LazyRspElisionStore(() => suppressRspStderr(openResidentStore));
      closeStore = () => store.close();
      const result = await suppressRspStderr(() => runGhWrapper(args.positional, { level: args.level, store }));
      process.stdout.write(result.stdout);
      process.stderr.write(result.stderr);
      if (result.signal) {
        process.kill(process.pid, result.signal);
        return 128;
      }
      return result.status ?? 0;
    }

    if (args.command === "vitest" || args.command === "cargo") {
      const { runTestWrapper } = await import("./test-wrapper.js");
      const store = new LazyRspElisionStore(() => suppressRspStderr(openResidentStore));
      closeStore = () => store.close();
      const result = await suppressRspStderr(() => runTestWrapper(args.positional, { level: args.level, store }));
      process.stdout.write(result.stdout);
      process.stderr.write(result.stderr);
      if (result.signal) {
        process.kill(process.pid, result.signal);
        return 128;
      }
      return result.status ?? 0;
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
    if (wrapperCommand) return await degradeToPassthrough("wrapper failed", args.positional, err);
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

async function runFastGitStatus(): Promise<number> {
  const child = spawn("git", ["status", "--porcelain=v1"], { stdio: ["ignore", "pipe", "pipe"] });
  let stdout = Buffer.alloc(0);
  let stderr = Buffer.alloc(0);
  child.stdout.on("data", (chunk) => {
    stdout = Buffer.concat([stdout, Buffer.from(chunk)]);
  });
  child.stderr.on("data", (chunk) => {
    stderr = Buffer.concat([stderr, Buffer.from(chunk)]);
  });
  const status = await new Promise<number | null>((resolve) => child.on("close", resolve));
  if ((status ?? 0) !== 0) {
    process.stdout.write(stdout);
    process.stderr.write(stderr);
    return status ?? 1;
  }
  process.stdout.write(stdout.length === 0 ? "git empty\n" : stdout);
  return 0;
}

type ElisionStoreLike = Pick<RspElisionStore, "mint" | "close">;

class LazyRspElisionStore implements ElisionStoreLike {
  private store?: Promise<ElisionStoreLike>;

  constructor(private readonly openStore: () => Promise<ElisionStoreLike>) {}

  async mint(...args: Parameters<RspElisionStore["mint"]>): ReturnType<RspElisionStore["mint"]> {
    return await (await this.open()).mint(...args);
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
}

async function degradeToPassthrough(reason: string, argv: readonly string[], err?: unknown): Promise<number> {
  if (process.env.RSP_DEBUG === "1") {
    throw err instanceof Error ? err : new Error(reason);
  }
  process.stderr.write(`rsp: ${reason}, passing through\n`);
  return await passthrough(argv);
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
