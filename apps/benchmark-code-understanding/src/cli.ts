#!/usr/bin/env node
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { readBuildInfo, renderVersion } from "@reddb-io/build-info";
import { parseLooseArgs, type LooseParsedArgs } from "@reddb-io/shared/args.js";
import { buildReport, loadRunRecords, renderReportMarkdown } from "./report.js";
import { doctor, runBenchmark } from "./runner.js";
import type { ArmId, RunnerId } from "./types.js";

const USAGE = `benchmark-code-understanding

Usage:
  benchmark-code-understanding --version [--json]
  benchmark-code-understanding doctor [--json]
  benchmark-code-understanding run [--dry-run] [--runner claude|codex] [--runs N] [--arms none,redskills,codegraph] [--workdir DIR] [--out FILE] [--fail-on-unsupported-claims]
  benchmark-code-understanding report --input FILE [--json] [--human] [--out FILE] [--report FILE] [--fail-on-unsupported-claims]
`;

async function main(argv = process.argv.slice(2)): Promise<number> {
  const args = parseLooseArgs(argv);
  if (args.command === "--version" || args.command === "-v" || args.command === "version" || args.flags.version === true) {
    const info = readBuildInfo("benchmark-code-understanding");
    process.stdout.write(args.flags.json ? `${JSON.stringify(info)}\n` : `${renderVersion(info)}\n`);
    return 0;
  }
  if (!args.command || args.command === "help" || args.command === "--help" || args.command === "-h") {
    process.stdout.write(USAGE);
    return 0;
  }
  if (args.command === "doctor") return runDoctor(args);
  if (args.command === "run") return runRun(args);
  if (args.command === "report") return runReport(args);
  throw new Error(`unknown command: ${args.command}\n\n${USAGE}`);
}

async function runDoctor(args: LooseParsedArgs): Promise<number> {
  const report = await doctor(process.cwd());
  if (args.flags.json === true) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  else {
    for (const check of report.checks) {
      process.stdout.write(`${check.status.toUpperCase()}\t${check.id}\t${check.detail}\n`);
    }
  }
  return report.checks.some((check) => check.status === "fail") ? 1 : 0;
}

async function runRun(args: LooseParsedArgs): Promise<number> {
  const workspace = workspaceRoot(process.cwd());
  const benchRoot = join(workspace, ".red", "tmp", "bench", "code-understanding");
  const out = stringFlag(args, "out") ?? join(benchRoot, "runs.toonl");
  const records = await runBenchmark({
    runner: runnerFlag(args),
    corpus: "overlap",
    arms: armsFlag(args),
    runs: positiveIntFlag(args, "runs") ?? 1,
    workdir: stringFlag(args, "workdir") ?? benchRoot,
    out,
    dryRun: args.flags["dry-run"] === true,
  });
  const report = buildReport(records);
  const markdown = renderReportMarkdown(report);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n\n${markdown}`);
  return failOnUnsupportedClaims(args, report.claim_guards.unsupported_claims.length);
}

async function runReport(args: LooseParsedArgs): Promise<number> {
  const input = stringFlag(args, "input");
  if (!input) throw new Error("benchmark-code-understanding report requires --input FILE");
  const records = await loadRunRecords(input);
  const report = buildReport(records);
  const json = JSON.stringify(report, null, 2);
  const markdown = renderReportMarkdown(report);
  const wantJson = args.flags.json === true;
  const wantHuman = args.flags.human === true;
  const defaultOutput = !wantJson && !wantHuman;
  if (wantJson || defaultOutput) process.stdout.write(`${json}\n`);
  if (wantHuman || defaultOutput) {
    if (wantJson || defaultOutput) process.stdout.write("\n");
    process.stdout.write(markdown);
  }
  await maybeWrite(stringFlag(args, "out"), `${json}\n`);
  await maybeWrite(stringFlag(args, "report"), markdown);
  return failOnUnsupportedClaims(args, report.claim_guards.unsupported_claims.length);
}

function runnerFlag(args: LooseParsedArgs): RunnerId {
  const value = stringFlag(args, "runner") ?? "claude";
  if (value === "claude" || value === "codex") return value;
  throw new Error("--runner must be claude or codex");
}

function armsFlag(args: LooseParsedArgs): ArmId[] {
  const raw = stringFlag(args, "arms") ?? "none,redskills,codegraph";
  const arms = raw.split(",").map((part) => part.trim()).filter(Boolean);
  const valid = new Set(["none", "redskills", "codegraph"]);
  if (arms.length === 0 || arms.some((arm) => !valid.has(arm))) {
    throw new Error("--arms must be a comma-separated subset of none,redskills,codegraph");
  }
  return arms as ArmId[];
}

function positiveIntFlag(args: LooseParsedArgs, name: string): number | undefined {
  const raw = stringFlag(args, name);
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) throw new Error(`--${name} must be a positive integer`);
  return value;
}

function stringFlag(args: LooseParsedArgs, name: string): string | undefined {
  const value = args.flags[name];
  return typeof value === "string" ? value : undefined;
}

async function maybeWrite(path: string | undefined, body: string): Promise<void> {
  if (!path) return;
  const resolved = resolve(path);
  await mkdir(dirname(resolved), { recursive: true });
  await writeFile(resolved, body, "utf8");
}

function failOnUnsupportedClaims(args: LooseParsedArgs, unsupportedCount: number): number {
  return args.flags["fail-on-unsupported-claims"] === true && unsupportedCount > 0 ? 1 : 0;
}

function workspaceRoot(start: string): string {
  let current = resolve(start);
  while (true) {
    if (existsSync(join(current, "pnpm-workspace.yaml"))) return current;
    const parent = dirname(current);
    if (parent === current) return resolve(start);
    current = parent;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().then((code) => {
    process.exitCode = code;
  }).catch((err) => {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  });
}
