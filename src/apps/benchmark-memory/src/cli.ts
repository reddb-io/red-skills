#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { readBuildInfo, renderVersion } from "@reddb-io/build-info";
import { parseLooseArgs, type LooseParsedArgs } from "@reddb-io/shared/args.js";
import {
  evaluateCompetitiveBaseline,
  evaluateCompetitiveEval,
  evaluateCompetitiveEvalV2,
  evaluateCompetitiveInteropReport,
  renderBaselineJson,
  renderComparisonTable,
  renderCompetitiveEvalHuman,
  renderCompetitiveEvalJson,
  renderCompetitiveEvalV2Human,
  renderCompetitiveEvalV2Json,
  renderCompetitiveInteropHuman,
  renderCompetitiveInteropJson,
} from "../../memory/src/competitive-baseline.js";
import { buildCompetitiveEvalViewerArtifact } from "../../memory/src/competitive-eval-viewer.js";
import {
  agentmemoryBaselineCommandFromEnv,
  createAgentmemoryCliBaselineAdapter,
  createNeo4jAgentMemoryCliBaselineAdapter,
  defaultCliExecutor,
  neo4jAgentMemoryBaselineCommandFromEnv,
  type LiveBaselineRunResult,
} from "../../memory/src/live-baseline-adapters.js";
import { formatMarkdownReport, runBenchRecall } from "../../memory/src/bench-recall.js";
import {
  DEFAULT_WORKLOAD,
  formatLatencyReport,
  loadWorkloadOverrides,
  runBenchLatency,
  type OpClass,
  type WorkloadConfig,
} from "../../memory/src/bench-latency.js";

type ParsedArgs = LooseParsedArgs;

const USAGE = `benchmark-memory

Usage:
  benchmark-memory --version [--json]
  benchmark-memory bench recall      [--root <dir>] [--corpus <dir>] [--k 1,5,10] [--out <file>] [--report <file>] [--json]
  benchmark-memory bench latency     [--root <dir>] [--workload <dir>] [--iterations N] [--warmup N] [--seed N] [--ops working-get,session-recall,long-term-recall] [--out <file>] [--report <file>] [--json]
  benchmark-memory references eval    [--v2] [--json] [--human] [--out <file>]
  benchmark-memory references viewer  [--out <file>]
  benchmark-memory references baseline [--json] [--human]
  benchmark-memory references interop [--json] [--human]
`;

async function main(argv = process.argv.slice(2)): Promise<number> {
  const args = parseLooseArgs(argv);
  if (args.command === "--version" || args.command === "-v" || args.command === "version" || args.flags.version === true) {
    const info = readBuildInfo("benchmark-memory");
    process.stdout.write(args.flags.json ? `${JSON.stringify(info)}\n` : `${renderVersion(info)}\n`);
    return 0;
  }
  if (!args.command || args.command === "help" || args.command === "--help" || args.command === "-h") {
    process.stdout.write(USAGE);
    return 0;
  }
  if (args.command === "bench") return runBench(args);
  if (args.command === "references") return runReferences(args);
  if (args.command === "baseline") return runBaseline(args);
  if (args.command === "eval") return runEval(args);
  if (args.command === "eval-viewer") return runEvalViewer(args);
  if (args.command === "interop") return runInterop(args);
  throw new Error(`unknown command: ${args.command}\n\n${USAGE}`);
}

async function runReferences(args: ParsedArgs): Promise<number> {
  const subcommand = args.positional[0];
  const nested: ParsedArgs = {
    command: subcommand,
    positional: args.positional.slice(1),
    flags: args.flags,
  };
  if (subcommand === "baseline") return runBaseline(nested);
  if (subcommand === "eval") return runEval(nested);
  if (subcommand === "viewer") return runEvalViewer(nested);
  if (subcommand === "interop") return runInterop(nested);
  throw new Error(`usage: benchmark-memory references (baseline|eval|viewer|interop) ...`);
}

async function runBaseline(args: ParsedArgs): Promise<number> {
  const report = evaluateCompetitiveBaseline(new Date());
  const json = args.flags.json === true;
  const human = args.flags.human === true;
  const defaultOutput = !json && !human;
  if (json || defaultOutput) process.stdout.write(renderBaselineJson(report));
  if (human || defaultOutput) {
    if (json || defaultOutput) process.stdout.write("\n");
    process.stdout.write(renderComparisonTable(report));
  }
  return report.failedAssertions.length > 0 ? 1 : 0;
}

async function runEval(args: ParsedArgs): Promise<number> {
  const json = args.flags.json === true;
  const human = args.flags.human === true;
  const defaultOutput = !json && !human;
  if (args.flags.v2 === true) {
    const now = Date.now();
    const report = await evaluateCompetitiveEvalV2({
      now,
      generatedAt: new Date().toISOString(),
      liveBaselines: await liveBaselinesFromFlags(args, now),
    });
    if (json || defaultOutput) process.stdout.write(renderCompetitiveEvalV2Json(report));
    if (human || defaultOutput) {
      if (json || defaultOutput) process.stdout.write("\n");
      process.stdout.write(renderCompetitiveEvalV2Human(report));
    }
    await maybeWrite(args, JSON.stringify(report, null, 2));
    return report.composite.status === "fail" || report.claimGuards.status === "fail" ? 1 : 0;
  }
  const report = await evaluateCompetitiveEval({
    now: Date.now(),
    generatedAt: new Date().toISOString(),
  });
  if (json || defaultOutput) process.stdout.write(renderCompetitiveEvalJson(report));
  if (human || defaultOutput) {
    if (json || defaultOutput) process.stdout.write("\n");
    process.stdout.write(renderCompetitiveEvalHuman(report));
  }
  await maybeWrite(args, JSON.stringify(report, null, 2));
  return report.claimGuards.unsupportedLiveCompetitorClaims.length > 0 ? 1 : 0;
}

async function liveBaselinesFromFlags(args: ParsedArgs, now: number): Promise<LiveBaselineRunResult[]> {
  const liveBaselines: LiveBaselineRunResult[] = [];
  if (args.flags["live-agentmemory"] === true) {
    const adapter = createAgentmemoryCliBaselineAdapter({
      command: agentmemoryBaselineCommandFromEnv(),
      executor: defaultCliExecutor,
    });
    liveBaselines.push(await adapter.run({ enabled: true, now }));
  }
  if (args.flags["live-agent-memory"] === true) {
    const adapter = createNeo4jAgentMemoryCliBaselineAdapter({
      command: neo4jAgentMemoryBaselineCommandFromEnv(),
      executor: defaultCliExecutor,
    });
    liveBaselines.push(await adapter.run({ enabled: true, now }));
  }
  return liveBaselines;
}

async function runEvalViewer(args: ParsedArgs): Promise<number> {
  const outPath = resolve(stringFlag(args, "out") ?? ".red/memory/reference-eval.html");
  const report = await evaluateCompetitiveEvalV2({ now: Date.now() });
  const artifact = buildCompetitiveEvalViewerArtifact(report);
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, artifact.html, "utf8");
  process.stdout.write(`benchmark-memory: reference eval viewer written ${outPath}\n`);
  return 0;
}

async function runInterop(args: ParsedArgs): Promise<number> {
  const report = evaluateCompetitiveInteropReport({ generatedAt: new Date().toISOString() });
  const json = args.flags.json === true;
  const human = args.flags.human === true;
  const defaultOutput = !json && !human;
  if (json || defaultOutput) process.stdout.write(renderCompetitiveInteropJson(report));
  if (human || defaultOutput) {
    if (json || defaultOutput) process.stdout.write("\n");
    process.stdout.write(renderCompetitiveInteropHuman(report));
  }
  return report.claimGuards.fullParityClaimed || report.claimGuards.unsupportedClaims.length > 0 ? 1 : 0;
}

async function runBench(args: ParsedArgs): Promise<number> {
  const sub = args.positional[0];
  if (sub === "recall") return runBenchRecallCmd(args);
  if (sub === "latency") return runBenchLatencyCmd(args);
  throw new Error(`usage: benchmark-memory bench (recall|latency) ...`);
}

async function runBenchRecallCmd(args: ParsedArgs): Promise<number> {
  const rootDir = resolve(String(process.cwd()));
  const corpusDir = stringFlag(args, "corpus") ?? join(rootDir, "src/apps/memory/bench/recall");
  const kRaw = stringFlag(args, "k");
  const kValues = kRaw
    ? kRaw.split(",").map((part) => Number(part.trim())).filter((value) => Number.isFinite(value) && value > 0)
    : undefined;
  if (kRaw && (!kValues || kValues.length === 0)) {
    throw new Error("benchmark-memory bench recall: --k must be a comma-separated list of positive integers");
  }
  const report = await runBenchRecall({ corpusDir, kValues });
  await writeOutputs(args, report, formatMarkdownReport(report));
  if (args.flags.json === true) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  else process.stdout.write(`benchmark-memory bench recall: corpus=${report.corpus_size} queries=${report.query_count}\n`);
  return 0;
}

async function runBenchLatencyCmd(args: ParsedArgs): Promise<number> {
  const rootDir = resolve(String(process.cwd()));
  const workloadDir = stringFlag(args, "workload") ?? join(rootDir, "src/apps/memory/bench/latency");
  const fileOverrides = await loadWorkloadOverrides(workloadDir);
  const cliOverrides: Partial<WorkloadConfig> = {};
  const opsRaw = stringFlag(args, "ops");
  if (opsRaw !== undefined) {
    const allowed: OpClass[] = ["working-get", "session-recall", "long-term-recall"];
    const picked = opsRaw.split(",").map((part) => part.trim()).filter((part): part is OpClass => (allowed as string[]).includes(part));
    if (picked.length === 0) throw new Error(`benchmark-memory bench latency: --ops must include one of ${allowed.join(", ")}`);
    cliOverrides.op_classes = picked;
  }
  setPositiveInteger(args, cliOverrides, "iterations");
  setPositiveInteger(args, cliOverrides, "warmup", { allowZero: true });
  setPositiveInteger(args, cliOverrides, "seed", { allowZero: true });
  const workload = { ...DEFAULT_WORKLOAD, ...fileOverrides, ...cliOverrides };
  const report = await runBenchLatency({ workload });
  await writeOutputs(args, report, formatLatencyReport(report));
  if (args.flags.json === true) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  else process.stdout.write(`benchmark-memory bench latency: results=${report.results.length}\n`);
  return 0;
}

async function writeOutputs(args: ParsedArgs, json: unknown, markdown: string): Promise<void> {
  const outPath = stringFlag(args, "out");
  const reportPath = stringFlag(args, "report");
  if (outPath) await writeFileEnsured(outPath, `${JSON.stringify(json, null, 2)}\n`);
  if (reportPath) await writeFileEnsured(reportPath, markdown);
}

async function maybeWrite(args: ParsedArgs, body: string): Promise<void> {
  const outPath = stringFlag(args, "out");
  if (outPath) await writeFileEnsured(outPath, `${body}\n`);
}

async function writeFileEnsured(path: string, body: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, body, "utf8");
}

function setPositiveInteger(
  args: ParsedArgs,
  out: Partial<WorkloadConfig>,
  name: "iterations" | "warmup" | "seed",
  options: { allowZero?: boolean } = {},
): void {
  const raw = stringFlag(args, name);
  if (raw === undefined) return;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < (options.allowZero ? 0 : 1)) {
    throw new Error(`benchmark-memory bench latency: --${name} must be a ${options.allowZero ? "non-negative" : "positive"} integer`);
  }
  out[name] = Math.floor(value);
}

function stringFlag(args: ParsedArgs, name: string): string | undefined {
  const value = args.flags[name];
  return typeof value === "string" ? value : undefined;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().then((code) => {
    process.exitCode = code;
  }).catch((err: unknown) => {
    process.stderr.write(`benchmark-memory: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  });
}
