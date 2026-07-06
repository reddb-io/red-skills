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
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import type { FailureMarkers } from "../core/envelope-emit.js";
import type { OrphanDir, StaleClaimDir } from "../core/boot.js";
import { updateState } from "../core/state.js";

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

/** Monotonic per-process counter so concurrent stale-claim reclaims (even from
 * the same pid) each rename to a UNIQUE temp dir — the atomic rename of the
 * shared claim dir is what serialises the winners, so the temp targets must not
 * collide. */
let claimReclaimSeq = 0;

/**
 * Atomically claim `dir` as a fresh lock directory. A plain `mkdir` (NOT
 * recursive) is the POSIX-atomic primitive: it fails with `EEXIST` when another
 * caller already holds the lock, so exactly one of N racing callers wins. The
 * recursive `ensureDir` (`mkdir -p`) is idempotent and CANNOT serve as a lock —
 * the prior check-then-act `pathExists` + `ensureDir` claim let two simultaneous
 * boots both pass the existence check and both create the dir, claiming the same
 * issue and opening duplicate PRs (#434). Only the leaf is exclusive; the parent
 * (`<tmpDir>/claims`) is created recursively first. On a win the holder's `pid`
 * is written to `<dir>/pid` so the boot-time stale-claim sweep can reclaim the
 * lock if the holder dies (the sweep reads exactly this file).
 */
export async function tryAcquireClaimDir(dir: string, pid: number): Promise<boolean> {
  await mkdir(dirname(dir), { recursive: true });
  const claimOnce = async (): Promise<"acquired" | "held"> => {
    try {
      await mkdir(dir); // non-recursive → EEXIST when already held
      return "acquired";
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") return "held";
      throw err;
    }
  };

  if ((await claimOnce()) === "held") {
    if (await claimPathHeldByLivePid(dir)) return false;
    // Dead holder → reclaim ATOMICALLY. The prior `rm` + re-`mkdir` was a TOCTOU:
    // two boots that both observed the dead pid would both rm the dir and both
    // mkdir it, each believing it held the lock — the #434 duplicate-claim race
    // reappeared on the recovery path that fires after any worker crash (#568).
    // rename(2) is atomic, so of N racing reclaimers exactly one rename of the
    // SAME stale dir succeeds; the losers get ENOENT and bail. Only the winner
    // deletes it and re-claims through the exclusive mkdir, which still
    // serialises against any fresh claimer that slipped in after the rename.
    const stealing = `${dir}.stale-${pid}-${claimReclaimSeq++}`;
    await rm(stealing, { recursive: true, force: true }).catch(() => {});
    try {
      await rename(dir, stealing);
    } catch {
      return false; // lost the steal race — another reclaimer already moved it
    }
    await rm(stealing, { recursive: true, force: true });
    if ((await claimOnce()) !== "acquired") return false; // a fresh claimer won the re-mkdir
  }
  await writeFile(join(dir, "pid"), String(pid), "utf8");
  return true;
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
  await rm(path, { recursive: true, force: true });
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

/** Append one line (newline-terminated) to a file, creating the parent dir.
 * Used for the per-iteration afk.log heartbeat boundary. */
export async function appendLine(path: string, line: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, `${line}\n`, "utf8");
}

/** Persist the terminal failure marker files into an iteration dir
 * (record_failure_markers): snapshot-branch.ref + failure.reason. Each value
 * already carries its trailing newline; an absent field writes no file. */
export async function writeFailureMarkers(attemptDir: string, markers: FailureMarkers): Promise<void> {
  await mkdir(attemptDir, { recursive: true });
  if (markers.snapshotBranchRef !== undefined) {
    await writeFile(join(attemptDir, "snapshot-branch.ref"), markers.snapshotBranchRef, "utf8");
  }
  if (markers.failureReason !== undefined) {
    await writeFile(join(attemptDir, "failure.reason"), markers.failureReason, "utf8");
  }
}

/** Persist the `envelope.posted` signal into the iteration state file. Best
 * effort: a malformed/absent state file degrades to writing a minimal object. */
export async function writeEnvelopePosted(attemptDir: string, posted: boolean): Promise<void> {
  await updateState(join(attemptDir, "afk.state.json"), { "envelope.posted": posted });
}

/** Read the `envelope.posted` flag from an attempt state file (false when
 * absent/malformed). */
export async function readEnvelopePosted(attemptDir: string): Promise<boolean> {
  const text = await readText(join(attemptDir, "afk.state.json"));
  if (text === null) return false;
  try {
    const parsed = JSON.parse(text) as { envelope?: { posted?: unknown } };
    return parsed.envelope?.posted === true;
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

/** Liveness probe (kill -0) for a recorded pid string. A blank/non-numeric pid
 * counts as dead, matching the bash `[[ -z "$cp" ]] || ! kill -0` guard. */
function pidAlive(raw: string | null): boolean {
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
    if (!pidAlive(raw)) out.push({ path: dir });
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
