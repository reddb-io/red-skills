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
  rmdir,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, join, normalize, sep } from "node:path";
import type { FailureMarkers } from "../core/envelope-emit.js";
import { ENVELOPE_REF_FILE, FAILURE_REASON_FILE } from "../core/prev-failure.js";
import type { OrphanDir, StaleClaimDir } from "../core/boot.js";
import { readState, updateState, workerStatePath } from "../core/state.js";
import { allWorkersRoots } from "../core/worker-paths.js";

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


export async function writeWorkerPid(pidFile: string, pid: number): Promise<void> {
  await mkdir(dirname(pidFile), { recursive: true });
  await writeFile(pidFile, String(pid), "utf8");
}

/** True when `dir` is a claim-lock dir whose recorded `pid` file names a live
 * process — the issue is actively owned by a running worker. Exported for the
 * boot orphan sweep (#644): a dead attempt dir naming issue N does not prove
 * the ISSUE is orphaned when another live worker holds its claim. */
export async function claimPathHeldByLivePid(dir: string): Promise<boolean> {
  try {
    const st = await stat(dir);
    if (!st.isDirectory()) return false;
  } catch {
    return false;
  }
  return pidAlive(await readText(join(dir, "pid")));
}

export async function removeDir(path: string): Promise<void> {
  await assertSweepRemovalSafe(path);
  await rm(path, { recursive: true, force: true });
}

function normalizedParts(path: string): string[] {
  return normalize(path).split(sep).filter(Boolean);
}

function isLivePid(raw: string | null): boolean {
  if (raw === null) return false;
  const trimmed = raw.trim();
  if (!/^[1-9][0-9]*$/.test(trimmed)) return false;
  try {
    process.kill(Number(trimmed), 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function pidFileNamesLiveProcess(path: string): Promise<boolean> {
  try {
    return isLivePid(await readFile(path, "utf8"));
  } catch {
    return false;
  }
}

function isRedTmpRoot(path: string): boolean {
  const parts = normalizedParts(path);
  return parts.length >= 2 && parts.at(-2) === ".red" && parts.at(-1) === "tmp";
}

function supervisorArtifactDir(path: string): string | null {
  const parts = normalizedParts(path);
  const name = parts.at(-1) ?? "";
  const parent = parts.at(-2) ?? "";
  const grandparent = parts.at(-3) ?? "";
  const tmpIndex = parts.findIndex((part, idx) => part === "tmp" && parts[idx - 1] === ".red");
  if (tmpIndex >= 0 && parts[tmpIndex + 1] === "supervisors" && parts[tmpIndex + 2]) {
    const prefixParts = parts.slice(0, tmpIndex + 3);
    return `${path.startsWith(sep) ? sep : ""}${prefixParts.join(sep)}`;
  }
  if (name.startsWith("afk-supervisor.") && (parent === "castle" || parent === "afk") && grandparent === "state") {
    return dirname(path);
  }
  if (name.startsWith("afk-supervisor.") && parent === "tmp" && grandparent === ".red") return dirname(path);
  if ((name === "castle" || name === "afk") && parent === "state") return path;
  return null;
}

function liveWorkerDirFor(path: string): string | null {
  const parts = normalizedParts(path);
  const tmpIndex = parts.findIndex((part, idx) => part === "tmp" && parts[idx - 1] === ".red");
  if (tmpIndex < 0) return null;
  const namespace = parts[tmpIndex + 1];
  if (!["workers", "go-workers", "scout-workers"].includes(namespace ?? "")) return null;
  const worker = parts[tmpIndex + 2];
  if (!worker) return null;
  const prefixParts = parts.slice(0, tmpIndex + 3);
  return `${path.startsWith(sep) ? sep : ""}${prefixParts.join(sep)}`;
}

async function assertSweepRemovalSafe(path: string): Promise<void> {
  if (isRedTmpRoot(path)) {
    throw new Error(`refusing to remove .red/tmp root: ${path}`);
  }

  const supervisorDir = supervisorArtifactDir(path);
  if (supervisorDir && await pidFileNamesLiveProcess(join(supervisorDir, "afk-supervisor.pid"))) {
    throw new Error(`refusing to remove live supervisor artifact: ${path}`);
  }

  const workerDir = liveWorkerDirFor(path);
  if (workerDir && await pidFileNamesLiveProcess(join(workerDir, "worker.pid"))) {
    const target = normalize(path);
    const workerRoot = normalize(workerDir);
    if (target === workerRoot || target === join(workerRoot, "worker.pid")) {
      throw new Error(`refusing to remove live worker artifact: ${path}`);
    }
  }
}

export async function writeHandoff(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, "utf8");
}

/**
 * Write the machine-readable validation sidecar `$ITER_DIR/validation.jsonl`
 * (SKILL.md §Validation Sidecar) — one `red.afk.validation.v1` JSON record per
 * line, newline-terminated. Consumed by the optional Memory bridge; not rendered
 * into the issue comment. Creates the parent dir.
 */
export async function writeValidationSidecar(path: string, lines: string[]): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, lines.length > 0 ? `${lines.join("\n")}\n` : "", "utf8");
}

export async function readText(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}

/**
 * Glob the worker state files `.../workers/*\/*\/afk.state.toon` under a workers
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
      const stateFile = workerStatePath(join(workerPath, attempt));
      if (await pathExists(stateFile)) out.push(stateFile);
    }
  }
  return out;
}

/** Append one line (newline-terminated) to a file, creating the parent dir.
 * Used for the per-iteration afk.log heartbeat boundary. */
export async function appendLine(path: string, line: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, `${line}\n`, "utf8");
}

/** Persist the terminal failure marker files into the worker's issue workspace:
 * failure.reason and envelope.ref, the pair `core/prev-failure.ts` reads back on
 * an automatic re-queue (ADR 0103). Each value already carries its trailing
 * newline; an absent field writes no file. */
export async function writeFailureMarkers(attemptDir: string, markers: FailureMarkers): Promise<void> {
  await mkdir(attemptDir, { recursive: true });
  if (markers.failureReason !== undefined) {
    await writeFile(join(attemptDir, FAILURE_REASON_FILE), markers.failureReason, "utf8");
  }
  if (markers.envelopeRef !== undefined) {
    await writeFile(join(attemptDir, ENVELOPE_REF_FILE), markers.envelopeRef, "utf8");
  }
}

/** Persist the `envelope.posted` signal into the iteration state file. Best
 * effort: a malformed/absent state file degrades to writing a minimal object. */
export async function writeEnvelopePosted(attemptDir: string, posted: boolean): Promise<void> {
  await updateState(workerStatePath(attemptDir), { "envelope.posted": posted });
}

/** Read the `envelope.posted` flag from an attempt state file (false when
 * absent/malformed). */
export async function readEnvelopePosted(attemptDir: string): Promise<boolean> {
  try {
    return (await readState(workerStatePath(attemptDir))).envelope.posted === true;
  } catch {
    return false;
  }
}

/**
 * Enumerate orphaned attempt dirs under a workers root for boot's orphan
 * cleanup. Each `workers/<worker>/<issue>-a<n>` dir is stat'd for its age, and
 * its issue number is parsed from the basename (null when unparseable). The
 * caller pairs these with gh state via boot's `lookups.orphanState`.
 */
export async function listOrphanDirs(workersRoot: string, nowS: number): Promise<OrphanDir[]> {
  const out: OrphanDir[] = [];
  let workers: string[];
  try {
    workers = await readdir(workersRoot);
  } catch {
    return out;
  }
  for (const worker of workers) {
    const workerPath = join(workersRoot, worker);
    // #444: only reap attempt dirs whose parent worker is DEAD. A live worker
    // (its `worker.pid` is alive) owns its attempts; a newly-booted parallel
    // worker's orphan sweep MUST skip them — otherwise it reaps a live sibling's
    // running issue (restores it to ready-for-agent + rm -rf's the live worktree).
    // A missing/blank/dead pid → treated as dead (the conservative orphan path),
    // matching listStaleClaimDirs / listLegacyWorkDirs.
    if (pidAlive(await readText(join(workerPath, "worker.pid")))) continue;
    let attempts: string[];
    try {
      attempts = await readdir(workerPath);
    } catch {
      continue;
    }
    for (const attempt of attempts) {
      const dir = join(workerPath, attempt);
      const m = /^([1-9][0-9]*)-a[1-9][0-9]*$/.exec(attempt);
      let ageS = 0;
      try {
        const st = await stat(dir);
        // Only attempt DIRECTORIES are orphans — skip the per-worker `worker.pid`
        // file (the liveness anchor) and any stray file, so they are never listed
        // as orphans (and never `removeDir`'d via the orphan path).
        if (!st.isDirectory()) continue;
        ageS = Math.max(0, nowS - Math.floor(st.mtimeMs / 1000));
      } catch {
        continue;
      }
      out.push({ path: dir, issue: m ? Number(m[1]) : null, ageS });
    }
  }
  return out;
}

export interface DeadEmptyWorkerShellReapResult {
  workerDirs: string[];
  workerPidFiles: string[];
  emptyAttemptDirs: string[];
}

/** Remove dead worker shells under every worker namespace. A shell is removable
 * only when its worker.pid is absent/corrupt/dead and the worker dir contains
 * no non-empty attempt evidence. */
export async function reapDeadEmptyWorkerShells(tmpDir: string): Promise<DeadEmptyWorkerShellReapResult> {
  const result: DeadEmptyWorkerShellReapResult = {
    workerDirs: [],
    workerPidFiles: [],
    emptyAttemptDirs: [],
  };

  for (const workersRoot of allWorkersRoots(tmpDir)) {
    const partial = await reapDeadEmptyWorkerShellsInRoot(workersRoot);
    result.workerDirs.push(...partial.workerDirs);
    result.workerPidFiles.push(...partial.workerPidFiles);
    result.emptyAttemptDirs.push(...partial.emptyAttemptDirs);
  }

  return result;
}

async function reapDeadEmptyWorkerShellsInRoot(workersRoot: string): Promise<DeadEmptyWorkerShellReapResult> {
  const result: DeadEmptyWorkerShellReapResult = {
    workerDirs: [],
    workerPidFiles: [],
    emptyAttemptDirs: [],
  };
  let workers: string[];
  try {
    workers = await readdir(workersRoot);
  } catch {
    return result;
  }

  for (const worker of workers) {
    const workerPath = join(workersRoot, worker);
    try {
      const st = await stat(workerPath);
      if (!st.isDirectory()) continue;
    } catch {
      continue;
    }

    const pidPath = join(workerPath, "worker.pid");
    if (pidAlive(await readText(pidPath))) continue;

    let entries: string[];
    try {
      entries = await readdir(workerPath);
    } catch {
      continue;
    }

    const emptyAttemptDirs: string[] = [];
    let removable = true;
    for (const entry of entries) {
      const path = join(workerPath, entry);
      if (entry === "worker.pid") {
        try {
          const st = await stat(path);
          if (!st.isFile()) removable = false;
        } catch {
          // Raced away or missing: still an empty shell candidate.
        }
        if (!removable) break;
        continue;
      }

      if (!/^[1-9][0-9]*-a[1-9][0-9]*$/.test(entry)) {
        removable = false;
        break;
      }

      try {
        const st = await stat(path);
        if (!st.isDirectory()) {
          removable = false;
          break;
        }
        if ((await readdir(path)).length > 0) {
          removable = false;
          break;
        }
      } catch {
        removable = false;
        break;
      }
      emptyAttemptDirs.push(path);
    }
    if (!removable) continue;

    const removedEmptyAttemptDirs: string[] = [];
    for (const dir of emptyAttemptDirs) {
      try {
        await rmdir(dir);
        removedEmptyAttemptDirs.push(dir);
      } catch {
        removable = false;
        break;
      }
    }
    if (!removable) continue;

    let removedPidFile = false;
    try {
      if (await pathExists(pidPath)) {
        await rm(pidPath, { force: true });
        removedPidFile = true;
      }
      await rmdir(workerPath);
    } catch {
      continue;
    }

    result.workerDirs.push(workerPath);
    if (removedPidFile) result.workerPidFiles.push(pidPath);
    result.emptyAttemptDirs.push(...removedEmptyAttemptDirs);
  }

  return result;
}

/** Liveness probe (kill -0) for a recorded pid string. A blank/non-numeric pid
 * counts as dead, matching the bash `[[ -z "$cp" ]] || ! kill -0` guard.
 * Exported so the castle FS issue-lease store (the single lease implementation)
 * can inject this host's pid-liveness verdict without importing packages/shared. */
export function pidAlive(raw: string | null): boolean {
  if (raw === null) return false;
  const trimmed = raw.trim();
  if (!/^[1-9][0-9]*$/.test(trimmed)) return false;
  try {
    process.kill(Number(trimmed), 0);
    return true;
  } catch (err) {
    // EPERM means the process exists but is owned by another user — still alive.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Discover stale claim-lock dirs under `<tmpDir>/claims/`. Each `claims/<N>/`
 * holds a `pid` file; the lock is stale (and reclaimable) when that pid is dead
 * or unreadable. Mirrors the trailing claim-lock sweep in prune_orphans (the
 * `for c in claims/...` loop: read `$c/pid`, `kill -0 $cp` else `rm -rf $c`).
 * A missing claims dir yields `[]` (nothing to sweep).
 */
export async function listStaleClaimDirs(tmpDir: string): Promise<StaleClaimDir[]> {
  const claimsRoot = join(tmpDir, "claims");
  let entries: string[];
  try {
    entries = await readdir(claimsRoot);
  } catch {
    return [];
  }
  const out: StaleClaimDir[] = [];
  for (const entry of entries) {
    const dir = join(claimsRoot, entry);
    try {
      const st = await stat(dir);
      if (!st.isDirectory()) continue;
    } catch {
      continue;
    }
    const raw = await readText(join(dir, "pid"));
    if (!pidAlive(raw)) {
      const issue = /^[1-9][0-9]*$/.test(entry) ? Number(entry) : undefined;
      out.push(issue === undefined ? { path: dir } : { path: dir, issue });
    }
  }
  return out;
}

/** Pre-cutover legacy relic name: `work-<issue-number>` (digits only). The AFK
 * orchestrator created these; a maintainer hand-work worktree is `work-<slug>`
 * (CLAUDE.md Development workflow) and must never match. */
const LEGACY_WORK_DIR_RE = /^work-[1-9][0-9]*$/;

/**
 * Discover pre-cutover flat `<tmpDir>/work-NNN` relic dirs whose orchestrator is
 * dead, for the unconditional drain-wipe (#252). Two AFK-ownership gates, both
 * required, so the sweep can only ever touch dirs the orchestrator itself made:
 *
 *   1. NAME — `work-<issue-number>` (digits). A maintainer worktree under
 *      `.red/tmp/work-<slug>` (the sanctioned home for hand work, CLAUDE.md
 *      Development workflow) is slug-named and is skipped. Guards #1052, where a
 *      fresh `work-afk-first-doctrine` worktree was silently deleted by a boot
 *      sweep because the old `startsWith("work-")` match plus "missing pid = wipe"
 *      treated any non-AFK `work-*` dir as a dead relic.
 *   2. SENTINEL — an `afk.pid` file must EXIST. Its absence means the dir was
 *      not created by the orchestrator, so it is not AFK-owned and is left alone.
 *
 * Only when both hold and the recorded pid is dead is the dir a reclaimable
 * relic. Mirrors the `for d in work-...` loop at the top of prune_orphans (minus
 * the dangling-worktree removal, which the caller handles via git when needed).
 * A missing tmp dir yields `[]`.
 */
export async function listLegacyWorkDirs(tmpDir: string): Promise<string[]> {
  let entries: string[];
  try {
    entries = await readdir(tmpDir);
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const entry of entries) {
    if (!LEGACY_WORK_DIR_RE.test(entry)) continue;
    const dir = join(tmpDir, entry);
    try {
      const st = await stat(dir);
      if (!st.isDirectory()) continue;
    } catch {
      continue;
    }
    const raw = await readText(join(dir, "afk.pid"));
    // No sentinel → not an orchestrator-created relic → untouchable. Present but
    // dead → reclaimable relic.
    if (raw === null) continue;
    if (!pidAlive(raw)) out.push(dir);
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
