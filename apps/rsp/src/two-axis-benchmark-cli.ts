#!/usr/bin/env node
import { writeTwoAxisBenchmarkReport } from "./two-axis-benchmark.js";

interface Args {
  out?: string;
  summary?: string;
}

async function main(argv = process.argv.slice(2)): Promise<number> {
  const args = parseArgs(argv);
  const report = await writeTwoAxisBenchmarkReport({ toonPath: args.out, summaryPath: args.summary });
  process.stdout.write(report.toon);
  if (!report.toon.endsWith("\n")) process.stdout.write("\n");
  return 0;
}

function parseArgs(argv: readonly string[]): Args {
  const out: Args = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--out") out.out = argv[++i];
    else if (arg === "--summary") out.summary = argv[++i];
    else throw new Error(`unknown argument: ${arg}`);
  }
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().then((code) => process.exit(code), (err) => {
    process.stderr.write(`rsp two-axis benchmark: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
