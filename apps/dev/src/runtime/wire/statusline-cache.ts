import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { readFileSync, writeFileSync, renameSync, mkdirSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { decode as decodeToon, type JsonValue as ToonValue } from "@reddb-io/toon";
import { encodeDevSnapshotToon } from "../../core/toon-snapshot.js";
import { LABEL_HUMAN, LABEL_QUARANTINE, LABEL_READY } from "../../core/triage-labels.js";
import * as ghx from "../gh.js";
import { GhReadError } from "../gh/read.js";
import { afkPaths, type RepoContext } from "./paths.js";
import { parsePositive } from "./settings.js";

export const STATUSLINE_CACHE_TTL_S = 900;
export const STATUSLINE_REFRESH_LOCK_TTL_S = 60;

/**
 * Resolve the effective statusline cache TTL (seconds) with precedence
 * RED_AFK_STATUSLINE_CACHE_TTL_S env > `afk.statusline_cache_ttl` config >
 * {@link STATUSLINE_CACHE_TTL_S} default (180). Typo-safe: a missing /
 * non-numeric / zero / negative value from EITHER source falls through to the
 * next source and ultimately the 180 default — never 0. A 0 TTL would make the
 * cache always-stale and refresh on every render, defeating the whole purpose.
 * Note the FLAT config key `afk.statusline_cache_ttl` — NOT nested under
 * `afk.statusline`, which is already the boolean opt-out (YAML cannot make one
 * key both a boolean and a map).
 */
export function resolveStatuslineCacheTtl(env: NodeJS.ProcessEnv, getCfg: (key: string) => string): number {
  return (
    parsePositive(env.RED_AFK_STATUSLINE_CACHE_TTL_S) ??
    parsePositive(getCfg("afk.statusline_cache_ttl")) ??
    STATUSLINE_CACHE_TTL_S
  );
}

/** Maximum milliseconds to wait for a cold-cache gh count refresh. If the gh
 * CLI hangs (network stall, rate-limit backoff) the statusline falls back to
 * 0/0 rather than blocking the render indefinitely. */
export const STATUSLINE_GH_COLD_TIMEOUT_MS = 5000;

/**
 * Race `promise` against a deadline. If the deadline fires first, resolves
 * with `fallback` immediately; the original promise is left to settle on its
 * own (no cancel). If the promise settles first, clears the timer and resolves
 * with its value.
 */
export async function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(fallback), ms);
  });
  try {
    return await Promise.race([promise, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

interface StatuslineCache {
  queue: number;
  human: number;
  quarantine?: number;
  ts: number;
}

type DetachedSpawn = (
  command: string,
  args: readonly string[],
  options: { detached: true; stdio: "ignore"; env: NodeJS.ProcessEnv },
) => Pick<ChildProcess, "unref">;

export interface StatuslineRefreshSpawnOptions {
  spawn?: DetachedSpawn;
  nowS?: number;
  argv1?: string;
}

export function statuslineCountCachePath(root: string): string {
  return afkPaths(root).statuslineCachePath;
}

export function decodeCacheDocument(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return decodeToon(text);
  }
}

export function readStatuslineCache(path: string): StatuslineCache | null {
  try {
    const parsed = decodeCacheDocument(readFileSync(path, "utf8")) as Partial<StatuslineCache>;
    return {
      queue: Number(parsed.queue ?? 0),
      human: Number(parsed.human ?? 0),
      quarantine: Number(parsed.quarantine ?? 0),
      ts: Number(parsed.ts ?? 0),
    };
  } catch {
    return null;
  }
}

export function writeStatuslineCacheAtomic(path: string, cache: StatuslineCache): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, encodeDevSnapshotToon(cache as unknown as ToonValue), "utf8");
    renameSync(tmp, path);
  } catch {
    // best-effort, like the bash `|| true`
  }
}

export function parseGitHubRepoSlugFromRemoteUrl(url: string): string {
  const trimmed = url.trim();
  const ssh = /^git@github\.com:([^/]+\/[^/]+?)(?:\.git)?$/.exec(trimmed);
  if (ssh) return ssh[1] ?? "";
  const https = /^https:\/\/github\.com\/([^/]+\/[^/]+?)(?:\.git)?\/?$/.exec(trimmed);
  if (https) return https[1] ?? "";
  return "";
}

function readGitFile(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

export function inferGitHubRepoSlug(root: string): string {
  const dotGit = join(root, ".git");
  const gitMarker = readGitFile(dotGit);
  const configCandidates = [join(dotGit, "config")];
  const gitDir = /^gitdir:\s*(.+)$/m.exec(gitMarker)?.[1]?.trim();
  if (gitDir) {
    const absoluteGitDir = gitDir.startsWith("/") ? gitDir : join(root, gitDir);
    configCandidates.push(join(absoluteGitDir, "config"));
    configCandidates.push(join(absoluteGitDir, "..", "..", "config"));
  }
  for (const configPath of configCandidates) {
    const config = readGitFile(configPath);
    const origin = /\[remote "origin"\][\s\S]*?\n\s*url\s*=\s*(.+)\n/.exec(`${config}\n`)?.[1];
    const slug = origin ? parseGitHubRepoSlugFromRemoteUrl(origin) : "";
    if (slug) return slug;
  }
  return "";
}

function statuslineRefreshLockPath(cachePath: string): string {
  return `${cachePath}.refresh.lock`;
}

function releaseStatuslineRefreshLock(lockPath: string): void {
  try {
    unlinkSync(lockPath);
  } catch {
    // best-effort
  }
}

function acquireStatuslineRefreshLock(lockPath: string, nowS: number): boolean {
  mkdirSync(dirname(lockPath), { recursive: true });
  // Lock payload is TOON on-disk (the stack's snapshot doctrine); the read side
  // (readStatuslineCache → decodeCacheDocument) sniff-decodes JSON-then-TOON, so
  // a legacy JSON lock written by an older bundle still reads back its `ts`.
  const payload = encodeDevSnapshotToon({ pid: process.pid, ts: nowS } as unknown as ToonValue);
  try {
    writeFileSync(lockPath, payload, { encoding: "utf8", flag: "wx" });
    return true;
  } catch {
    const existing = readStatuslineCache(lockPath);
    if (existing && nowS - existing.ts < STATUSLINE_REFRESH_LOCK_TTL_S) return false;
    releaseStatuslineRefreshLock(lockPath);
    try {
      writeFileSync(lockPath, payload, { encoding: "utf8", flag: "wx" });
      return true;
    } catch {
      return false;
    }
  }
}

export function applyStatuslineCountCacheLabelDelta(
  cachePath: string,
  remove: readonly string[],
  add: readonly string[],
  nowS: number = Math.floor(Date.now() / 1000),
): boolean {
  const cached = readStatuslineCache(cachePath);
  if (!cached) return false;
  const removed = new Set(remove);
  const added = new Set(add);
  const deltaFor = (label: string): number => (added.has(label) ? 1 : 0) - (removed.has(label) ? 1 : 0);
  const queueDelta = deltaFor(LABEL_READY);
  const humanDelta = deltaFor(LABEL_HUMAN);
  const quarantineDelta = deltaFor(LABEL_QUARANTINE);
  if (queueDelta === 0 && humanDelta === 0 && quarantineDelta === 0) return false;
  writeStatuslineCacheAtomic(cachePath, {
    queue: Math.max(0, cached.queue + queueDelta),
    human: Math.max(0, cached.human + humanDelta),
    quarantine: Math.max(0, (cached.quarantine ?? 0) + quarantineDelta),
    ts: nowS,
  });
  return true;
}

export async function editLabelsWithStatuslineCache(
  cachePath: string,
  edit: () => Promise<boolean>,
  remove: readonly string[],
  add: readonly string[],
): Promise<boolean> {
  const ok = await edit();
  if (ok) applyStatuslineCountCacheLabelDelta(cachePath, remove, add);
  return ok;
}

/**
 * Refresh the cached statusline counts, LEAVING THE CACHE UNTOUCHED when the
 * read failed. A read that could not run yields no counts to write: overwriting
 * known counts with zeroes would render "the queue is empty" as fact (#2801), so
 * a {@link GhReadError} skips the write and the previous counts keep serving
 * until a read succeeds.
 */
export async function refreshStatuslineCountCache(
  root: string,
  repo: string = inferGitHubRepoSlug(root),
  lockPath?: string,
): Promise<void> {
  try {
    const cachePath = statuslineCountCachePath(root);
    const counts = await ghx.countStatuslineQueueCounts({ cwd: root, repo }).catch((error: unknown) => {
      if (error instanceof GhReadError) return null;
      throw error;
    });
    if (counts === null) return;
    writeStatuslineCacheAtomic(cachePath, { ...counts, ts: Math.floor(Date.now() / 1000) });
  } finally {
    if (lockPath) releaseStatuslineRefreshLock(lockPath);
  }
}

export function startDetachedStatuslineCountRefresh(
  ctx: RepoContext,
  options: StatuslineRefreshSpawnOptions = {},
): boolean {
  const cachePath = statuslineCountCachePath(ctx.root);
  const nowS = options.nowS ?? Math.floor(Date.now() / 1000);
  const lockPath = statuslineRefreshLockPath(cachePath);
  const repo = ctx.repo || inferGitHubRepoSlug(ctx.root);
  const argv1 = options.argv1 ?? process.argv[1];
  if (!repo || !argv1) return false;
  if (!acquireStatuslineRefreshLock(lockPath, nowS)) return false;
  try {
    const child = (options.spawn ?? spawn)(process.execPath, [
      argv1,
      "statusline-refresh-counts",
      ctx.root,
      "--repo",
      repo,
      "--lock",
      lockPath,
    ], {
      detached: true,
      stdio: "ignore",
      env: { ...process.env, RED_AFK_STATUSLINE_REFRESH_CHILD: "1" },
    });
    child.unref();
    return true;
  } catch {
    releaseStatuslineRefreshLock(lockPath);
    return false;
  }
}
