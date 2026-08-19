#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { decode } from "@reddb-io/toon";
import { writeTwoAxisBenchmarkReport, type TwoAxisBenchmarkReport } from "./two-axis-benchmark.js";
import {
  compareTwoAxisBenchmarkReports,
  TWO_AXIS_TOKEN_REGRESSION_THRESHOLD_PCT,
  type TwoAxisRegressionViolation,
} from "./two-axis-thresholds.js";

interface Args {
  out?: string;
  summary?: string;
  fixtureRoot?: string;
  corpusLabel?: string;
  corpusProvenance: string[];
  requireLargeOutputFixtures?: boolean;
  check: boolean;
}

async function main(argv = process.argv.slice(2)): Promise<number> {
  const args = parseArgs(argv);
  const baseline = args.check && args.out ? await readBenchmarkReport(args.out) : undefined;
  const report = await writeTwoAxisBenchmarkReport({
    fixtureRoot: args.fixtureRoot,
    corpusLabel: args.corpusLabel,
    corpusProvenance: args.corpusProvenance.length > 0 ? args.corpusProvenance : undefined,
    requireLargeOutputFixtures: args.requireLargeOutputFixtures,
    toonPath: args.out,
    summaryPath: args.summary,
  });
  process.stdout.write(report.toon);
  if (!report.toon.endsWith("\n")) process.stdout.write("\n");
  if (baseline) {
    const violations = compareTwoAxisBenchmarkReports(baseline, report);
    if (violations.length > 0) {
      process.stderr.write(renderViolations(violations));
      return 1;
    }
  }
  return 0;
}

function parseArgs(argv: readonly string[]): Args {
  const out: Args = { check: false, corpusProvenance: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--out") out.out = argv[++i];
    else if (arg === "--summary") out.summary = argv[++i];
    else if (arg === "--fixture-root") out.fixtureRoot = argv[++i];
    else if (arg === "--corpus-label") out.corpusLabel = argv[++i];
    else if (arg === "--corpus-provenance") out.corpusProvenance.push(argv[++i] ?? "");
    else if (arg === "--require-large-output-fixtures") out.requireLargeOutputFixtures = true;
    else if (arg === "--no-require-large-output-fixtures") out.requireLargeOutputFixtures = false;
    else if (arg === "--check") out.check = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (out.check && !out.out) throw new Error("--check requires --out");
  return out;
}

async function readBenchmarkReport(path: string): Promise<TwoAxisBenchmarkReport> {
  const decoded = decode(await readFile(path, "utf8"));
  if (!isTwoAxisBenchmarkReport(decoded)) throw new Error(`invalid rsp two-axis benchmark result: ${path}`);
  return decoded;
}

function renderViolations(violations: readonly TwoAxisRegressionViolation[]): string {
  const lines = [
    `rsp two-axis benchmark regression gate failed (${violations.length} violation${violations.length === 1 ? "" : "s"}):`,
    ...violations.map((violation) => {
      if (violation.kind === "token-regression") {
        return `- ${violation.filter} ${violation.axis}: token delta ${violation.current}% regressed from ${violation.baseline}% by more than ${TWO_AXIS_TOKEN_REGRESSION_THRESHOLD_PCT}pp`;
      }
      return `- ${violation.filter} ${violation.axis}: fidelity pass rate ${violation.current}% regressed from ${violation.baseline}%`;
    }),
  ];
  return `${lines.join("\n")}\n`;
}

function isTwoAxisBenchmarkReport(value: unknown): value is TwoAxisBenchmarkReport {
  return typeof value === "object" &&
    value !== null &&
    "benchmark" in value &&
    value.benchmark === "rsp-two-axis" &&
    "filters" in value &&
    Array.isArray(value.filters);
}

if (resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main().then((code) => process.exit(code), (err) => {
    process.stderr.write(`rsp two-axis benchmark: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
