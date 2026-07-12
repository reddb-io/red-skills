#!/usr/bin/env node
import { spawn } from "node:child_process";
import { closeSync, existsSync, openSync, readSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { RspElisionStore } from "./elision-store.js";
import { resolveRspConfig } from "./config.js";
import { runGitWrapper } from "./git-wrapper.js";
import { runGhWrapper } from "./gh-wrapper.js";
import { runClaudePreExecHook } from "./intercept.js";
import { runClaudePostExecHook } from "./normalize.js";
import { configureRspRedBinary, provisionRspRepoStore } from "./setup.js";
import { runTestWrapper } from "./test-wrapper.js";

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
    return await runClaudePreExecHook();
  }
  if (args.command === "hook" && args.positional[1] === "claude-post-exec") {
    return await runClaudePostExecHook();
  }
  if (args.command === "setup") {
    const result = await provisionRspRepoStore(process.cwd());
    process.stdout.write(renderSetupResult(result));
    return 0;
  }

  await configureRspRedBinary({ mayFetch: false });

  const config = resolveRspConfig(process.cwd(), process.env, args.storeUri);
  const wrapperCommand = isWrapperCommand(args.command);
  if (!args.storeUri && config.storeUri.startsWith("file://") && !existsSync(fileURLToPath(config.storeUri))) {
    if (wrapperCommand) return await degradeToPassthrough("store not provisioned", args.positional);
    process.stdout.write("error: rsp repo store is not provisioned - run /red-setup\n");
    return 1;
  }
  if (wrapperCommand && isUnreadableFileStore(config.storeUri)) return await degradeToPassthrough("store unreadable", args.positional);
  let store: RspElisionStore;
  try {
    const openStore = () => RspElisionStore.open({
      uri: config.storeUri,
      ttlDays: config.ttlDays,
      byteBudget: config.byteBudget,
    });
    store = wrapperCommand ? await suppressRspStderr(openStore) : await openStore();
  } catch (err) {
    if (wrapperCommand) return await degradeToPassthrough("store open failed", args.positional, err);
    throw err;
  }

  try {
    if (!args.command) {
      const stats = await store.stats();
      process.stdout.write(renderStats(stats));
      return 0;
    }

    if (args.command === "git") {
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
    await store.close();
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

function isUnreadableFileStore(uri: string): boolean {
  if (!uri.startsWith("file://")) return false;
  let fd: number | undefined;
  try {
    fd = openSync(fileURLToPath(uri), "r");
    const header = Buffer.alloc(64);
    const bytesRead = readSync(fd, header, 0, header.length, 0);
    return !header.subarray(0, bytesRead).includes("RDDB");
  } catch {
    return true;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
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
