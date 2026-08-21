// statusline-local-git — the LOCAL git facts of the Statusline Bedrock, under
// their own ~5s micro-TTL (ADR 0141 §1).
//
// These facts used to ride the 15-minute remote-counter cache, which coupled a
// cheap local subprocess to a network-bound TTL: the branch you just switched to
// stayed wrong for a quarter of an hour because three `gh` calls were expensive.
// Ownership is the split — local git answers with zero network and zero daemon,
// so it gets a TTL sized to the operator's perception (~5s) rather than to
// GitHub's rate limit.
//
// The micro-TTL is what keeps that cheap: Claude Code re-renders the statusline
// on every tick, and a subprocess per tick is a subprocess per keystroke burst.
// Within the TTL the render is a single file read; past it, one bounded refresh.
// The refresh carries a deadline for the same reason the remote caches do — a
// pathological `git diff` in a huge worktree must cost the operator freshness,
// never a frozen prompt (#3546): a miss serves the last-known facts and lets the
// in-flight read rewrite the cache for the next render.
//
// It sits in `packages/shared` because the daemon draws the bedrock now and may
// not import a runtime (dependency-direction guard #4135). The git reach is
// therefore spelled here with `node:child_process` directly rather than through
// any runtime's git helpers.

import { execFile } from "node:child_process";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { decode as decodeToon, encode as encodeToon, type JsonValue as ToonValue } from "@reddb-io/toon";
import { statuslineStateDir } from "./red-paths.js";

/**
 * Race `promise` against a deadline, resolving with `fallback` when the deadline
 * wins. The loser is left to settle on its own — a refresh that outlived the
 * render still rewrites the cache for the next one, which is the whole point of
 * a deadline that costs freshness rather than correctness.
 */
export async function withStatuslineTimeout<T>(
  promise: Promise<T>,
  ms: number,
  fallback: T,
): Promise<T> {
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

/** Sniff-decode a cache document: TOON is what we write, JSON is what older
 * bundles wrote, and a reader that accepted only one would discard a live entry
 * over the encoding it happens to be in. */
export function decodeStatuslineCacheDocument(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return decodeToon(text);
  }
}

/**
 * The bedrock's local-git freshness window. ~5s is the operator's perception
 * floor: below it a human cannot tell the difference, above it a branch switch
 * lingers on screen. It is deliberately three orders of magnitude under the
 * remote-counter TTL — that one exists to ration a network, this one a fork.
 */
export const STATUSLINE_GIT_MICRO_TTL_MS = 5_000;

/**
 * The refresh deadline. A read that outlives it serves the previous facts and
 * finishes into the cache, so the next render is fresh and this one is fast.
 */
export const STATUSLINE_GIT_DEADLINE_MS = 400;

/** The local git facts the bedrock renders: no network, no daemon, no tracker. */
export interface StatuslineLocalGit {
  /** The repository's own basename — the worktree's, not the checkout dir's. */
  basename: string;
  /** Current branch, absent when HEAD is detached or the dir is not a repo. */
  branch?: string;
  /** Short HEAD sha, rendered only when there is no branch. */
  detachedSha?: string;
  /** Local branch insertions vs the base ref (committed + uncommitted). */
  localAdded: number;
  /** Local branch deletions vs the base ref (committed + uncommitted). */
  localRemoved: number;
}

interface StatuslineGitCache extends StatuslineLocalGit {
  /** The base ref the diff was measured against; a change invalidates the entry. */
  baseRef: string;
  /** Epoch milliseconds the facts were read. Milliseconds, because the TTL is. */
  tsMs: number;
}

/** Injection seams. Production passes none; the micro-TTL test fakes fs + clock. */
export interface StatuslineLocalGitDeps {
  nowMs?: () => number;
  ttlMs?: number;
  deadlineMs?: number;
  baseRef?: string;
  /** Reads the cache document, or null when there is none. */
  readCache?: (path: string) => string | null;
  /** Writes the cache document. Best-effort in production. */
  writeCache?: (path: string, text: string) => void;
  /** The ONE git-subprocess reach — the thing the micro-TTL exists to skip. */
  readGitFacts?: (root: string, baseRef: string) => Promise<StatuslineLocalGit>;
}

/** Where the micro-TTL entry lives: the statusline lane of the project's state. */
export function statuslineGitCachePath(root: string): string {
  return join(statuslineStateDir(root), "statusline-git-cache.toon");
}

function readCacheFile(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

function writeCacheFile(path: string, text: string): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, text, "utf8");
    renameSync(tmp, path);
  } catch {
    // best-effort: a cache that cannot be written costs a subprocess, not a render
  }
}

function decodeGitCache(text: string | null): StatuslineGitCache | null {
  if (text === null) return null;
  try {
    const parsed = decodeStatuslineCacheDocument(text) as Partial<StatuslineGitCache>;
    const cached: StatuslineGitCache = {
      basename: typeof parsed.basename === "string" ? parsed.basename : "",
      localAdded: Number(parsed.localAdded ?? 0),
      localRemoved: Number(parsed.localRemoved ?? 0),
      baseRef: typeof parsed.baseRef === "string" ? parsed.baseRef : "",
      tsMs: Number(parsed.tsMs ?? 0),
    };
    if (typeof parsed.branch === "string" && parsed.branch !== "") cached.branch = parsed.branch;
    if (typeof parsed.detachedSha === "string" && parsed.detachedSha !== "") {
      cached.detachedSha = parsed.detachedSha;
    }
    return cached.basename === "" ? null : cached;
  } catch {
    return null;
  }
}

function factsOf(cached: StatuslineGitCache): StatuslineLocalGit {
  const facts: StatuslineLocalGit = {
    basename: cached.basename,
    localAdded: cached.localAdded,
    localRemoved: cached.localRemoved,
  };
  if (cached.branch) facts.branch = cached.branch;
  if (cached.detachedSha) facts.detachedSha = cached.detachedSha;
  return facts;
}

/** One `git -C <root> …`, resolved to its trimmed stdout or "" on any failure. */
async function git(root: string, args: readonly string[]): Promise<string> {
  return await new Promise<string>((resolve) => {
    execFile(
      "git",
      ["-C", root, ...args],
      { encoding: "utf8", maxBuffer: 1024 * 1024 },
      (error, stdout) => resolve(error ? "" : String(stdout).trim()),
    );
  });
}

/**
 * The repository's basename — resolved through `--git-common-dir` so a worktree
 * under `.red/tmp/worktrees/<slug>` reads as the repo it belongs to rather than
 * as its own scratch directory name. Falls back to the path basename whenever
 * git cannot answer (not a repo, git absent).
 */
export async function resolveStatuslineRepoBasename(root: string): Promise<string> {
  const fallback = basename(root);
  const commonDir = await git(root, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  if (!commonDir) return fallback;
  return basename(dirname(commonDir)) || fallback;
}

/** `N insertion` / `N deletion` out of a `--shortstat` line, each defaulting to 0. */
function parseShortstat(stdout: string): { added: number; removed: number } {
  const ins = /(\d+) insertion/.exec(stdout);
  const del = /(\d+) deletion/.exec(stdout);
  return { added: ins ? Number(ins[1]) : 0, removed: del ? Number(del[1]) : 0 };
}

async function readGitFactsFromSubprocesses(
  root: string,
  baseRef: string,
): Promise<StatuslineLocalGit> {
  const [repoBasename, branch, sha, mergeBase] = await Promise.all([
    resolveStatuslineRepoBasename(root),
    git(root, ["branch", "--show-current"]),
    git(root, ["rev-parse", "--short", "HEAD"]),
    git(root, ["merge-base", baseRef, "HEAD"]),
  ]);
  const diff = parseShortstat(await git(root, ["diff", "--shortstat", mergeBase || baseRef]));
  const facts: StatuslineLocalGit = {
    basename: repoBasename,
    localAdded: diff.added,
    localRemoved: diff.removed,
  };
  if (branch) facts.branch = branch;
  else if (sha) facts.detachedSha = sha;
  return facts;
}

/**
 * The bedrock's local git facts, served from the micro-TTL entry in the
 * statusline state lane. Within {@link STATUSLINE_GIT_MICRO_TTL_MS} of the last
 * read this is ONE file read and NO subprocess; past it, one bounded refresh
 * that rewrites the entry. Fail-open at every step: a broken cache, a failed
 * read, or a missed deadline degrades to the last-known facts, and with neither
 * to the path basename — never to a thrown render.
 */
export async function collectStatuslineLocalGit(
  root: string,
  deps: StatuslineLocalGitDeps = {},
): Promise<StatuslineLocalGit> {
  const now = (deps.nowMs ?? Date.now)();
  const ttlMs = deps.ttlMs ?? STATUSLINE_GIT_MICRO_TTL_MS;
  const baseRef = deps.baseRef ?? "origin/main";
  const path = statuslineGitCachePath(root);
  const cached = decodeGitCache((deps.readCache ?? readCacheFile)(path));
  const ageMs = cached ? now - cached.tsMs : Number.POSITIVE_INFINITY;
  if (cached && cached.baseRef === baseRef && ageMs >= 0 && ageMs < ttlMs) return factsOf(cached);

  const write = deps.writeCache ?? writeCacheFile;
  const refresh = (deps.readGitFacts ?? readGitFactsFromSubprocesses)(root, baseRef)
    .then((facts) => {
      write(path, encodeToon({ ...facts, baseRef, tsMs: now } as unknown as ToonValue));
      return facts;
    })
    .catch(() => null);
  const refreshed = await withStatuslineTimeout(
    refresh,
    deps.deadlineMs ?? STATUSLINE_GIT_DEADLINE_MS,
    null,
  );
  if (refreshed) return refreshed;
  return cached ? factsOf(cached) : { basename: basename(root), localAdded: 0, localRemoved: 0 };
}
