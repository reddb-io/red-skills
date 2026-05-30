// runtime/fs.ts — concrete filesystem closures backed by node:fs/promises.
//
// Covers the cheap host-side artifacts the orchestrators touch: ensuring dirs,
// the gitignore-line guard, the worker.pid write, attempt-dir create, handoff
// write, completion sweep, and the worker-state glob the monitor reads. No
// process spawn here — pure disk IO.

import { constants } from "node:fs";
import {
  access,
  appendFile,
  mkdir,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";

export async function ensureDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
}

export async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

/** Append `line` to `.gitignore` iff not already present (grep -qxF guard). */
export async function ensureGitignoreLine(gitignorePath: string, line: string): Promise<void> {
  let current = "";
  try {
    current = await readFile(gitignorePath, "utf8");
  } catch {
    current = "";
  }
  const lines = current.split("\n").map((l) => l.replace(/\r$/, ""));
  if (lines.includes(line)) return;
  const sep = current.length === 0 || current.endsWith("\n") ? "" : "\n";
  await mkdir(dirname(gitignorePath), { recursive: true });
  await appendFile(gitignorePath, `${sep}${line}\n`, "utf8");
}

export async function writeWorkerPid(pidFile: string, pid: number): Promise<void> {
  await mkdir(dirname(pidFile), { recursive: true });
  await writeFile(pidFile, String(pid), "utf8");
}

export async function removeDir(path: string): Promise<void> {
  await rm(path, { recursive: true, force: true });
}

export async function writeHandoff(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, "utf8");
}

export async function readText(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}

/**
 * Glob the worker state files `.../workers/*\/*\/afk.state.json` under a workers
 * root, returning absolute paths. Two levels deep (worker dir → attempt dir).
 */
export async function globWorkerStates(workersRoot: string): Promise<string[]> {
  const out: string[] = [];
  let workerDirs: string[];
  try {
    workerDirs = await readdir(workersRoot);
  } catch {
    return out;
  }
  for (const worker of workerDirs) {
    const workerPath = join(workersRoot, worker);
    let attempts: string[];
    try {
      attempts = await readdir(workerPath);
    } catch {
      continue;
    }
    for (const attempt of attempts) {
      const stateFile = join(workerPath, attempt, "afk.state.json");
      if (await pathExists(stateFile)) out.push(stateFile);
    }
  }
  return out;
}

/** Remove every attempt dir for a completed issue under a workers root. Returns
 * the removed dir paths (completion_sweep_issue). */
export async function completionSweep(workersRoot: string, issue: number): Promise<string[]> {
  const removed: string[] = [];
  let workerDirs: string[];
  try {
    workerDirs = await readdir(workersRoot);
  } catch {
    return removed;
  }
  const prefix = `${issue}-a`;
  for (const worker of workerDirs) {
    const workerPath = join(workersRoot, worker);
    let attempts: string[];
    try {
      attempts = await readdir(workerPath);
    } catch {
      continue;
    }
    for (const attempt of attempts) {
      if (attempt.startsWith(prefix)) {
        const dir = join(workerPath, attempt);
        await rm(dir, { recursive: true, force: true });
        removed.push(dir);
      }
    }
  }
  return removed;
}
