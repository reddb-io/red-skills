import { relative } from "node:path";
import { encode as encodeToon } from "@reddb-io/toon";
import { afkPaths, collectPrecheckFacts, resolveRepoContext } from "../runtime/wire.js";
import { listIssueStates, type GhContext } from "../runtime/gh.js";
import { applyTmpJanitorReport, collectTmpJanitorReport, type TmpJanitorApplyResult, type TmpJanitorReport } from "../runtime/tmp-janitor.js";
import {
  applyOperationalProbeFixes,
  runOperationalProbes,
  type OperationalProbeFixResult,
  type OperationalProbeReport,
} from "../core/operational-probes.js";
import * as gitx from "../runtime/git.js";

interface RedDoctorFlags {
  fix: boolean;
  json: boolean;
  yes: boolean;
  root: string;
}

function parseFlags(args: readonly string[], cwd: string): RedDoctorFlags {
  const flags: RedDoctorFlags = { fix: false, json: false, yes: false, root: cwd };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (arg === "--fix") {
      flags.fix = true;
      continue;
    }
    if (arg === "--json") {
      flags.json = true;
      continue;
    }
    if (arg === "--yes" || arg === "-y") {
      flags.yes = true;
      continue;
    }
    if (arg === "--root") {
      const value = args[++i];
      if (!value) throw new Error("--root requires a value");
      flags.root = value;
      continue;
    }
    if (arg.startsWith("--root=")) {
      flags.root = arg.slice("--root=".length);
      continue;
    }
    throw new Error(`unknown red-doctor argument: ${arg}`);
  }
  return flags;
}

function rel(root: string, path: string): string {
  const out = relative(root, path);
  return out === "" ? "." : out;
}

function flattenExpired(report: TmpJanitorReport): string[] {
  return [
    ...report.plan.logs.reclaim,
    ...report.plan.scratch.reclaim,
    ...report.plan.diagnostics.reclaim,
    ...report.plan.feedbackWorktrees.reclaim,
  ].map((entry) => entry.path);
}

function renderHuman(
  root: string,
  probeReport: OperationalProbeReport,
  report: TmpJanitorReport,
  applied?: TmpJanitorApplyResult,
  probeFixes: readonly OperationalProbeFixResult[] = [],
): string {
  const expired = flattenExpired(report).map((path) => rel(root, path));
  const workers = report.staleWorkers.reclaim.map((entry) => rel(root, entry.path));
  const unknown = report.plan.unknownTmpRoots.map((name) => `.red/tmp/${name}`);
  const lines = [
    "red-doctor operational probes",
    `probes: ${probeReport.probes.length}`,
    ...probeReport.probes.map((probe) => `  ${probe.verdict} ${probe.name}`),
    `red probes: ${probeReport.findings.length}`,
    ...probeReport.findings.map((finding) => `  ${finding.name}: ${finding.evidence}`),
    ...probeReport.findings.map((finding) => `  fix: ${finding.canonicalFix}`),
    ...probeFixes.map((fix) => `  fix ${fix.probeId}: ${fix.status} (${fix.evidence})`),
    "",
    "red-doctor tmp janitor",
    `expired lanes: ${expired.length}`,
    ...expired.map((path) => `  ${path}`),
    `stale workers: ${workers.length}`,
    ...workers.map((path) => `  ${path}`),
    `unknown tmp roots: ${unknown.length}`,
    ...unknown.map((path) => `  ${path}`),
  ];
  if (applied) {
    lines.push(
      `applied expired lanes: ${applied.expiredLanes.length}`,
      `applied stale workers: ${applied.staleWorkers.length}`,
      `applied unknown tmp roots: ${applied.unknownTmpRoots.length}`,
      `protected live workers: ${applied.protectedLiveWorkers.length}`,
    );
  }
  return `${lines.join("\n")}\n`;
}

function renderToon(
  root: string,
  probeReport: OperationalProbeReport,
  report: TmpJanitorReport,
  applied?: TmpJanitorApplyResult,
  probeFixes: readonly OperationalProbeFixResult[] = [],
): string {
  return encodeToon({
    probes: probeReport.probes.map((probe) => ({
      id: probe.id,
      name: probe.name,
      verdict: probe.verdict,
    })),
    findings: probeReport.findings.map((finding) => ({
      id: finding.id,
      name: finding.name,
      verdict: finding.verdict,
      fix: finding.canonicalFix,
    })),
    tmpJanitor: {
      expiredLanes: flattenExpired(report).map((path) => rel(root, path)),
      staleWorkers: report.staleWorkers.reclaim.map((entry) => rel(root, entry.path)),
      unknownTmpRoots: report.plan.unknownTmpRoots.map((name) => `.red/tmp/${name}`),
    },
    appliedFixes: probeFixes.map((fix) => ({
      probeId: fix.probeId,
      status: fix.status,
      evidence: fix.evidence,
    })),
    appliedTmpJanitor: applied
      ? {
          expiredLanes: applied.expiredLanes.map((path) => rel(root, path)),
          staleWorkers: applied.staleWorkers.map((path) => rel(root, path)),
          unknownTmpRoots: applied.unknownTmpRoots.map((path) => rel(root, path)),
          protectedLiveWorkers: applied.protectedLiveWorkers.map((path) => rel(root, path)),
        }
      : null,
  });
}

export async function redDoctorCommand(args: readonly string[], cwd = process.cwd()): Promise<number> {
  try {
    const flags = parseFlags(args, cwd);
    const ctx = await resolveRepoContext(flags.root);
    const paths = afkPaths(ctx.root);
    const precheckFacts = await collectPrecheckFacts(ctx);
    const probeReport = await runOperationalProbes(precheckFacts);
    const issueStates = ctx.repo
      ? await listIssueStates({ cwd: ctx.root, repo: ctx.repo } satisfies GhContext)
      : new Map();
    const report = await collectTmpJanitorReport(paths.tmpDir, Math.floor(Date.now() / 1000), (issue) => {
      const state = issueStates.get(issue)?.state;
      return state === "CLOSED" ? "CLOSED" : state === "OPEN" ? "OPEN" : "UNKNOWN";
    });
    const gitCtx: gitx.GitContext = { cwd: ctx.root };
    const probeFixes = flags.fix
      ? await applyOperationalProbeFixes(probeReport, {
          confirm: async () => flags.yes,
          setRemoteUrl: async (name, url) => gitx.setRemoteUrl(gitCtx, name, url),
        })
      : [];
    const applied = flags.fix ? await applyTmpJanitorReport(paths.tmpDir, report) : undefined;
    process.stdout.write(
      flags.json
        ? renderToon(ctx.root, probeReport, report, applied, probeFixes)
        : renderHuman(ctx.root, probeReport, report, applied, probeFixes),
    );
    return 0;
  } catch (error) {
    process.stderr.write(`[red-doctor] ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}
