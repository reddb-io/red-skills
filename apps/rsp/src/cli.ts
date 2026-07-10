#!/usr/bin/env node
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { RspElisionStore } from "./elision-store.js";
import { resolveRspConfig } from "./config.js";
import { runGitWrapper } from "./git-wrapper.js";

interface ParsedArgs {
  command?: string;
  handle?: string;
  storeUri?: string;
  level: "lossless" | "brief" | "terse";
  positional: string[];
}

async function main(argv = process.argv.slice(2)): Promise<number> {
  const args = parseArgs(argv);
  const config = resolveRspConfig(process.cwd(), process.env, args.storeUri);
  if (!args.storeUri && config.storeUri.startsWith("file://") && !existsSync(fileURLToPath(config.storeUri))) {
    process.stdout.write("error: rsp repo store is not provisioned - run /setup-red-skills\n");
    return 1;
  }
  const store = await RspElisionStore.open({
    uri: config.storeUri,
    ttlDays: config.ttlDays,
    byteBudget: config.byteBudget,
  });

  try {
    if (!args.command) {
      const stats = await store.stats();
      process.stdout.write(renderStats(stats));
      return 0;
    }

    if (args.command === "git") {
      const result = await runGitWrapper(args.positional, { level: args.level, store });
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
  } finally {
    await store.close();
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
    else positional.push(arg);
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

if (import.meta.url === `file://${process.argv[1]}`) {
  main().then((code) => process.exit(code), (err) => {
    process.stdout.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}

export { main, renderStats };
