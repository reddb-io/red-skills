import { existsSync, mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { LIVENESS_LANE_FILENAME } from "@reddb-io/red-castle";
import { decode, encode } from "@reddb-io/toon";
import {
  appendCastleHistoryRecord,
  castleStateSnapshotPath,
  createEnginePaths,
  writeCastleStateSnapshot,
} from "@reddb-io/red-castle/engine";
import {
  afkPaths,
  resolveRunSettings,
  collectMonitorInputs,
  collectStatuslineWorkers,
  readFleetState,
  resolveAttemptProbeArming,
  buildMinimalBootDeps,
  withTimeout,
  collectStatuslineAfk,
  collectStatuslineDocs,
  parseGitHubRepoSlugFromRemoteUrl,
  inferGitHubRepoSlug,
  resolveAttemptHead,
} from "../src/runtime/wire.js";
import { runBoot } from "../src/core/boot.js";
import type { ExecOutput } from "../src/runtime/exec.js";

export {
  afkPaths,
  appendCastleHistoryRecord,
  buildMinimalBootDeps,
  castleStateSnapshotPath,
  collectMonitorInputs,
  collectStatuslineAfk,
  collectStatuslineDocs,
  collectStatuslineWorkers,
  createEnginePaths,
  decode,
  dirname,
  encode,
  existsSync,
  inferGitHubRepoSlug,
  join,
  mkdirSync,
  mkdtempSync,
  parseGitHubRepoSlugFromRemoteUrl,
  readFleetState,
  readFileSync,
  resolveAttemptProbeArming,
  resolveAttemptHead,
  resolveRunSettings,
  rmSync,
  runBoot,
  tmpdir,
  withTimeout,
  writeCastleStateSnapshot,
  writeFileSync,
};
export type { ExecOutput };

export function scratch(): string {
  return mkdtempSync(join(tmpdir(), "afk-wire-"));
}

export function writeRenderableAttempt(root: string, worker: string, issue: number, startedAt: string): string {
  const attemptDir = join(root, ".red", "tmp", "workers", worker, `${issue}-a1`);
  mkdirSync(attemptDir, { recursive: true });
  writeFileSync(
    join(attemptDir, "afk.state.toon"),
    JSON.stringify({
      worker_id: worker,
      pid: process.pid,
      runner: "codex",
      started_at: startedAt,
      current: { number: issue, title: `issue ${issue}`, started_at: startedAt },
    }),
  );
  writeFileSync(
    join(attemptDir, LIVENESS_LANE_FILENAME),
    `${JSON.stringify({ at: Date.now() - 5_000, kind: "iteration-start" })}\n`,
  );
  return attemptDir;
}

/** Write a fake `gh` script to a temp dir and return its path. The script
 * outputs `[]` for any invocation so all count functions return 0 quickly. */
export function fakeBinDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "fake-gh-"));
  writeFileSync(join(dir, "gh"), "#!/bin/sh\necho '[]'\n", { mode: 0o755 });
  return dir;
}

/** Run `fn` with a fake `gh` binary prepended to PATH, then restore PATH. */
export async function withFakeGh<T>(fn: () => Promise<T>): Promise<T> {
  const dir = fakeBinDir();
  const orig = process.env.PATH;
  process.env.PATH = `${dir}:${orig ?? ""}`;
  try {
    return await fn();
  } finally {
    process.env.PATH = orig;
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Write a fake `gh` script that fails the way an exhausted GitHub quota does:
 * a 403 rate-limit body on stderr and a non-zero exit. */
export function rateLimitedBinDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "quota-gh-"));
  writeFileSync(
    join(dir, "gh"),
    "#!/bin/sh\necho 'gh: API rate limit exceeded for user ID 1. (HTTP 403)' 1>&2\nexit 1\n",
    { mode: 0o755 },
  );
  return dir;
}

/** Run `fn` with a rate-limited fake `gh` on PATH, then restore PATH. */
export async function withRateLimitedGh<T>(fn: () => Promise<T>): Promise<T> {
  const dir = rateLimitedBinDir();
  const orig = process.env.PATH;
  process.env.PATH = `${dir}:${orig ?? ""}`;
  try {
    return await fn();
  } finally {
    process.env.PATH = orig;
    rmSync(dir, { recursive: true, force: true });
  }
}

export function nowS(): number {
  return Math.floor(Date.now() / 1000);
}

export function detachedSpawnRecorder() {
  const calls: Array<{ command: string; args: readonly string[] }> = [];
  const spawn = (command: string, args: readonly string[]) => {
    calls.push({ command, args });
    return { unref() { /* test double */ } };
  };
  return { calls, spawn };
}

export function readToonCache<T>(path: string): T {
  return decode(readFileSync(path, "utf8")) as T;
}
