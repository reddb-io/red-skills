#!/usr/bin/env node
import { RspElisionStore } from "./elision-store.js";
import { resolveRspConfig } from "./config.js";

interface ParsedArgs {
  command?: string;
  handle?: string;
  storeUri?: string;
}

async function main(argv = process.argv.slice(2)): Promise<number> {
  const args = parseArgs(argv);
  const config = resolveRspConfig(process.cwd(), process.env, args.storeUri);
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
  const out: ParsedArgs = {};
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--store-uri") out.storeUri = argv[++i];
    else positional.push(arg);
  }
  out.command = positional[0];
  out.handle = positional[1];
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
