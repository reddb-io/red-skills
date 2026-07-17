import { relative } from "node:path";
import { afkPaths, resolveRepoContext } from "../runtime/wire.js";
import { listIssueStates, type GhContext } from "../runtime/gh.js";
import { applyTmpJanitorReport, collectTmpJanitorReport, type TmpJanitorApplyResult, type TmpJanitorReport } from "../runtime/tmp-janitor.js";

interface RedDoctorFlags {
  fix: boolean;
  json: boolean;
  root: string;
}

function parseFlags(args: readonly string[], cwd: string): RedDoctorFlags {
  const flags: RedDoctorFlags = { fix: false, json: false, root: cwd };
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

function renderHuman(root: string, report: TmpJanitorReport, applied?: TmpJanitorApplyResult): string {
  const expired = flattenExpired(report).map((path) => rel(root, path));
  const workers = report.staleWorkers.reclaim.map((entry) => rel(root, entry.path));
  const unknown = report.plan.unknownTmpRoots.map((name) => `.red/tmp/${name}`);
  const lines = [
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

function renderJson(root: string, report: TmpJanitorReport, applied?: TmpJanitorApplyResult): string {
  const body = {
    expiredLanes: flattenExpired(report).map((path) => rel(root, path)),
    staleWorkers: report.staleWorkers.reclaim.map((entry) => rel(root, entry.path)),
    unknownTmpRoots: report.plan.unknownTmpRoots.map((name) => `.red/tmp/${name}`),
    ...(applied
      ? {
          applied: {
            expiredLanes: applied.expiredLanes.map((path) => rel(root, path)),
            staleWorkers: applied.staleWorkers.map((path) => rel(root, path)),
            unknownTmpRoots: applied.unknownTmpRoots.map((path) => rel(root, path)),
            protectedLiveWorkers: applied.protectedLiveWorkers.map((path) => rel(root, path)),
          },
        }
      : {}),
  };
  return `${JSON.stringify(body)}\n`;
}

export async function redDoctorCommand(args: readonly string[], cwd = process.cwd()): Promise<number> {
  try {
    const flags = parseFlags(args, cwd);
    const ctx = await resolveRepoContext(flags.root);
    const paths = afkPaths(ctx.root);
    const issueStates = ctx.repo
      ? await listIssueStates({ cwd: ctx.root, repo: ctx.repo } satisfies GhContext)
      : new Map();
    const report = await collectTmpJanitorReport(paths.tmpDir, Math.floor(Date.now() / 1000), (issue) => {
      const state = issueStates.get(issue)?.state;
      return state === "CLOSED" ? "CLOSED" : state === "OPEN" ? "OPEN" : "UNKNOWN";
    });
    const applied = flags.fix ? await applyTmpJanitorReport(paths.tmpDir, report) : undefined;
    process.stdout.write(flags.json ? renderJson(ctx.root, report, applied) : renderHuman(ctx.root, report, applied));
    return 0;
  } catch (error) {
    process.stderr.write(`[red-doctor] ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}
