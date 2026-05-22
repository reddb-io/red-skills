#!/usr/bin/env node
/**
 * red-curate-skill — workflow CLI consumed by the `/curate` slash command in
 * the dev plugin. Subcommands:
 *
 *   list                          — emit archive candidates as JSON
 *   archive --candidate <json>    — archive one approved candidate
 *   restore <name>                — restore one archived skill
 *   check                         — verify preconditions (graph mode + Skill
 *                                   telemetry); fail-fast with the exact
 *                                   `memory init` command on miss
 *
 * The CLI is intentionally thin — every subcommand routes into one of the
 * three pure modules under this directory (candidate-reader, archive-engine,
 * consent-gate). The Memory plugin's own CLI never invokes archive or
 * restore; this binary lives in the Memory tsx toolchain only to share types.
 */
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { readConfig, skillTelemetryEnabled } from "../config.js";
import { parseCuratorReport, readArchiveCandidates } from "./candidate-reader.js";
import { executeArchive, executeRestore } from "./archive-engine.js";
import type { ArchiveCandidate } from "./types.js";

const INIT_HINT = "memory init --mode graph --skill-telemetry";

function usage(): string {
  return `red-curate-skill — workflow engine for the /curate skill

Usage:
  red-curate-skill check                 [--root <dir>]
  red-curate-skill list                  [--root <dir>] [--stale-days N]
  red-curate-skill archive --candidate <json>  [--root <dir>] [--archive-dir <rel>]
  red-curate-skill restore <name>        [--root <dir>] [--archive-dir <rel>]`;
}

interface ParsedArgs {
  command: string | undefined;
  positional: string[];
  flags: Record<string, string | boolean>;
}

function parseArgs(argv: string[]): ParsedArgs {
  const [command, ...rest] = argv;
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const next = rest[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else {
      positional.push(arg);
    }
  }
  return { command, positional, flags };
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

/** Locate the @reddb/memory CLI from this script's location. */
function memoryCliPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // src/curate-skill/cli.ts (tsx) → ../cli.ts  OR  dist/curate-skill/cli.js → ../cli.js
  const isDist = here.includes(`${"dist"}/curate-skill`) || here.endsWith("dist/curate-skill");
  return isDist ? join(here, "..", "cli.js") : join(here, "..", "cli.ts");
}

function runMemoryCli(args: string[], rootDir: string): { stdout: string; status: number } {
  const cliPath = memoryCliPath();
  const isTs = cliPath.endsWith(".ts");
  const proc = isTs
    ? spawnSync(process.execPath, ["--import", "tsx", cliPath, ...args, "--root", rootDir], {
        encoding: "utf8",
      })
    : spawnSync(process.execPath, [cliPath, ...args, "--root", rootDir], { encoding: "utf8" });
  return { stdout: proc.stdout ?? "", status: proc.status ?? 1 };
}

async function runCheck(args: ParsedArgs): Promise<number> {
  const rootDir = rootOf(args.flags);
  const result = await precheck(rootDir);
  if (!result.ok) {
    console.error(result.message);
    return 2;
  }
  console.log("curate: skill telemetry is enabled — ready to curate");
  return 0;
}

async function runList(args: ParsedArgs): Promise<number> {
  const rootDir = rootOf(args.flags);
  const pre = await precheck(rootDir);
  if (!pre.ok) {
    console.error(pre.message);
    return 2;
  }
  const memArgs = ["curate", "skills", "--json"];
  if (typeof args.flags["stale-days"] === "string") {
    memArgs.push("--stale-days", args.flags["stale-days"] as string);
  }
  const { stdout, status } = runMemoryCli(memArgs, rootDir);
  if (status !== 0) {
    console.error(`curate: memory curate skills exited ${status}`);
    return status;
  }
  const envelope = parseCuratorReport(stdout);
  const { candidates, filtered } = readArchiveCandidates(envelope);
  console.log(
    JSON.stringify(
      {
        candidates,
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

async function runArchive(args: ParsedArgs): Promise<number> {
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

async function runRestore(args: ParsedArgs): Promise<number> {
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

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  switch (args.command) {
    case "check":
      return runCheck(args);
    case "list":
      return runList(args);
    case "archive":
      return runArchive(args);
    case "restore":
      return runRestore(args);
    case undefined:
    case "--help":
    case "-h":
      console.log(usage());
      return 0;
    default:
      console.error(`unknown subcommand: ${args.command}\n\n${usage()}`);
      return 2;
  }
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  },
);
