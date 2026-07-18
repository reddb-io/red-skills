import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { encodeSnapshotToon } from "@reddb-io/shared/toon-migration.js";
import type { WrappedCommandResult } from "./types.js";

export function isFastGitStatus(argv: readonly string[]): boolean {
  return argv.length === 2 && argv[0] === "git" && argv[1] === "status";
}

export async function runFastGitStatus(): Promise<WrappedCommandResult> {
  if (isEmptyUnbornGitRepo(process.cwd())) {
    return {
      stdout: renderCleanGitStatus(),
      stderr: Buffer.alloc(0),
      status: 0,
      signal: null,
    };
  }

  const clean = spawnSync("git", ["diff-index", "--quiet", "HEAD", "--"], { stdio: "ignore" });
  if (clean.status === 0) {
    return {
      stdout: renderCleanGitStatus(),
      stderr: Buffer.alloc(0),
      status: 0,
      signal: null,
    };
  }

  const status = spawnSync("git", ["status", "--porcelain=v1"], { encoding: "buffer" });
  if ((status.status ?? 0) !== 0) {
    return {
      stdout: status.stdout,
      stderr: status.stderr,
      status: status.status ?? 1,
      signal: status.signal,
    };
  }
  const stdout = status.stdout.length === 0 ? renderCleanGitStatus() : status.stdout;
  return {
    stdout,
    stderr: status.stderr,
    status: 0,
    signal: status.signal,
    rawOutput: stdout,
  };
}

export async function fastTelemetryRoot(cwd: string): Promise<string> {
  try {
    const { resolveResidentPaths } = await import("../resident-client.js");
    return resolveResidentPaths(cwd).rootDir;
  } catch {
    return cwd;
  }
}

function renderCleanGitStatus(): Buffer {
  return Buffer.from(`${encodeSnapshotToon({
    command: "git status",
    category: "no-op",
    exit_code: 0,
    noop: true,
    scope: "git status",
    empty: true,
    branch: "",
    rows: [],
    summary: "git status clean: 0 changes",
  })}\n`);
}

function isEmptyUnbornGitRepo(cwd: string): boolean {
  try {
    if (!existsSync(`${cwd}/.git`) || existsSync(`${cwd}/.git/index`)) return false;
    return readdirSync(cwd).every((entry) => entry === ".git");
  } catch {
    return false;
  }
}
