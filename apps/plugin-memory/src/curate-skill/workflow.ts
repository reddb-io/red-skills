import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseLooseArgs, type LooseParsedArgs } from "@reddb-io/shared/args.js";
import { readConfig, skillTelemetryEnabled } from "../config.js";
import { executeArchive, executeRestore } from "./archive-engine.js";
import { parseCuratorReport, readArchiveCandidates } from "./candidate-reader.js";
import { fileBackgroundIssue, totalCandidates } from "./issue-filer.js";
import type { ArchiveCandidate, CuratorReportEnvelope } from "./types.js";

const INIT_HINT = "memory init --mode graph --skill-telemetry";

export type CurateWorkflowParsedArgs = LooseParsedArgs;

export interface CurateWorkflowOptions {
  loadCuratorReport?: (rootDir: string, staleDays?: number) => Promise<CuratorReportEnvelope>;
  usageCommand?: string;
}

export function usage(command = "memory curate"): string {
  return `${command} — workflow engine for /curate

Usage:
  ${command} check                 [--root <dir>]
  ${command} list                  [--root <dir>] [--stale-days N]
  ${command} background            [--root <dir>] [--stale-days N] [--label <name>]
  ${command} archive --candidate <json>  [--root <dir>] [--archive-dir <rel>]
  ${command} restore <name>        [--root <dir>] [--archive-dir <rel>]`;
}

export function parseCurateWorkflowArgs(argv: string[]): CurateWorkflowParsedArgs {
  return parseLooseArgs(argv);
}

function rootOf(flags: Record<string, string | boolean>): string {
  return resolve(typeof flags.root === "string" ? flags.root : process.cwd());
}

function archiveDirOf(flags: Record<string, string | boolean>): string | undefined {
  return typeof flags["archive-dir"] === "string" ? (flags["archive-dir"] as string) : undefined;
}

async function precheck(rootDir: string): Promise<{ ok: true } | { ok: false; message: string }> {
  const config = await readConfig(rootDir);
  if (!config) {
    return {
      ok: false,
      message: `curate: memory is not initialized here — run \`${INIT_HINT}\``,
    };
  }
  if (config.mode !== "graph") {
    return {
      ok: false,
      message: `curate: skill telemetry needs graph mode (this project is "${config.mode}") — run \`${INIT_HINT}\``,
    };
  }
  if (!skillTelemetryEnabled(config)) {
    return {
      ok: false,
      message: `curate: skill telemetry is not enabled here — run \`${INIT_HINT}\``,
    };
  }
  return { ok: true };
}

function memoryCliPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const isDist = here.includes(`${"dist"}/curate-skill`) || here.endsWith("dist/curate-skill");
  return isDist ? join(here, "..", "cli.js") : join(here, "..", "cli.ts");
}

async function defaultLoadCuratorReport(
  rootDir: string,
  staleDays?: number,
): Promise<CuratorReportEnvelope> {
  const memArgs = ["curate", "skills", "--json"];
  if (staleDays !== undefined) {
    memArgs.push("--stale-days", String(staleDays));
  }
  const cliPath = memoryCliPath();
  const isTs = cliPath.endsWith(".ts");
  const proc = isTs
    ? spawnSync(process.execPath, ["--import", "tsx", cliPath, ...memArgs, "--root", rootDir], {
        encoding: "utf8",
      })
    : spawnSync(process.execPath, [cliPath, ...memArgs, "--root", rootDir], { encoding: "utf8" });
  const status = proc.status ?? 1;
  if (status !== 0) {
    throw new Error(`memory curate skills exited ${status}`);
  }
  return parseCuratorReport(proc.stdout ?? "");
}

function staleDaysOf(args: CurateWorkflowParsedArgs): number | undefined {
  return typeof args.flags["stale-days"] === "string"
    ? Number(args.flags["stale-days"])
    : undefined;
}

async function loadReport(
  args: CurateWorkflowParsedArgs,
  options: CurateWorkflowOptions,
): Promise<CuratorReportEnvelope> {
  const loader = options.loadCuratorReport ?? defaultLoadCuratorReport;
  return loader(rootOf(args.flags), staleDaysOf(args));
}

async function runCheck(args: CurateWorkflowParsedArgs): Promise<number> {
  const rootDir = rootOf(args.flags);
  const result = await precheck(rootDir);
  if (!result.ok) {
    console.error(result.message);
    return 2;
  }
  console.log("curate: skill telemetry is enabled — ready to curate");
  return 0;
}

async function runList(
  args: CurateWorkflowParsedArgs,
  options: CurateWorkflowOptions,
): Promise<number> {
  const rootDir = rootOf(args.flags);
  const pre = await precheck(rootDir);
  if (!pre.ok) {
    console.error(pre.message);
    return 2;
  }
  let envelope: CuratorReportEnvelope;
  try {
    envelope = await loadReport(args, options);
  } catch (err) {
    console.error(`curate: ${(err as Error).message}`);
    return 1;
  }
  const { candidates, byCategory, filtered } = readArchiveCandidates(envelope);
  console.log(
    JSON.stringify(
      {
        candidates,
        byCategory,
        filtered,
        totals: {
          totalSkills: envelope.totalSkills,
          curatableSkills: envelope.curatableSkills,
          readOnlySkills: envelope.readOnlySkills,
        },
      },
      null,
      2,
    ),
  );
  return 0;
}

async function runBackground(
  args: CurateWorkflowParsedArgs,
  options: CurateWorkflowOptions,
): Promise<number> {
  const rootDir = rootOf(args.flags);
  const pre = await precheck(rootDir);
  if (!pre.ok) {
    console.error(pre.message);
    return 2;
  }
  let envelope: CuratorReportEnvelope;
  try {
    envelope = await loadReport(args, options);
  } catch (err) {
    console.error(`curate: ${(err as Error).message}`);
    return 1;
  }
  const { byCategory } = readArchiveCandidates(envelope);
  if (totalCandidates(byCategory) === 0) {
    console.error("curate: no candidates — no issue filed");
    return 0;
  }
  const label = typeof args.flags.label === "string" ? (args.flags.label as string) : undefined;
  const receipt = await fileBackgroundIssue(
    {
      byCategory,
      totals: {
        totalSkills: envelope.totalSkills,
        curatableSkills: envelope.curatableSkills,
        readOnlySkills: envelope.readOnlySkills,
      },
      generatedAt: envelope.generatedAt,
    },
    { cwd: rootDir, label },
  );
  console.log(`curate: filed background issue — ${receipt.output || receipt.title}`);
  return 0;
}

async function runArchive(args: CurateWorkflowParsedArgs): Promise<number> {
  const rootDir = rootOf(args.flags);
  const pre = await precheck(rootDir);
  if (!pre.ok) {
    console.error(pre.message);
    return 2;
  }
  const raw = args.flags.candidate;
  if (typeof raw !== "string") {
    console.error("curate archive: --candidate <json> is required");
    return 2;
  }
  let candidate: ArchiveCandidate;
  try {
    candidate = JSON.parse(raw) as ArchiveCandidate;
  } catch (err) {
    console.error(`curate archive: invalid --candidate JSON: ${(err as Error).message}`);
    return 2;
  }
  const result = await executeArchive(candidate, {
    rootDir,
    archiveDir: archiveDirOf(args.flags),
  });
  if (!result.ok) {
    console.error(
      `curate archive: refused — ${result.rejection.reason}: ${result.rejection.detail}`,
    );
    return 3;
  }
  console.log(
    `curate: archived "${result.receipt.name}" → ${result.receipt.archiveRoot} ` +
      `(${result.receipt.files.length} file(s), manifest at ${result.receipt.manifestPath})`,
  );
  return 0;
}

async function runRestore(args: CurateWorkflowParsedArgs): Promise<number> {
  const rootDir = rootOf(args.flags);
  const pre = await precheck(rootDir);
  if (!pre.ok) {
    console.error(pre.message);
    return 2;
  }
  const name = args.positional[0];
  if (!name) {
    console.error("curate restore: skill name is required");
    return 2;
  }
  const receipt = await executeRestore(name, {
    rootDir,
    archiveDir: archiveDirOf(args.flags),
  });
  console.log(
    `curate: restored "${receipt.name}" → ${receipt.restoredRoot} ` +
      `(${receipt.files.length} file(s) hash-verified)`,
  );
  return 0;
}

export async function runCurateWorkflow(
  args: CurateWorkflowParsedArgs,
  options: CurateWorkflowOptions = {},
): Promise<number> {
  switch (args.command) {
    case "check":
      return runCheck(args);
    case "list":
      return runList(args, options);
    case "background":
      return runBackground(args, options);
    case "archive":
      return runArchive(args);
    case "restore":
      return runRestore(args);
    case undefined:
    case "--help":
    case "-h":
      console.log(usage(options.usageCommand));
      return 0;
    default:
      console.error(`unknown curate subcommand: ${args.command}\n\n${usage(options.usageCommand)}`);
      return 2;
  }
}

export async function runCurateWorkflowFromArgv(
  argv: string[],
  options: CurateWorkflowOptions = {},
): Promise<number> {
  return runCurateWorkflow(parseCurateWorkflowArgs(argv), options);
}
