// statusline-git — the LOCAL git facts of the Statusline Bedrock, under their
// own ~5s micro-TTL (ADR 0141 §1).
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

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname } from "node:path";
import { type JsonValue as ToonValue } from "@reddb-io/toon";
import { encodeDevSnapshotToon } from "../../core/toon-snapshot.js";
import { git as gitExec } from "../exec.js";
import * as gitx from "../git.js";
import { afkPaths } from "./paths.js";
import { decodeCacheDocument, withTimeout } from "./statusline-cache.js";

/**
 * The bedrock's local-git freshness window. ~5s is the operator's perception
 * floor: below it a human cannot tell the difference, above it a branch switch
 * lingers on screen. It is deliberately three orders of magnitude under
 * `STATUSLINE_CACHE_TTL_S` — that TTL exists to ration a network, this one to
 * ration a fork.
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
    const parsed = decodeCacheDocument(text) as Partial<StatuslineGitCache>;
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

/**
 * The repository's basename — resolved through `--git-common-dir` so a worktree
 * under `.red/tmp/worktrees/<slug>` reads as the repo it belongs to rather than
 * as its own scratch directory name. Falls back to the path basename whenever
 * git cannot answer (not a repo, git absent).
 */
export async function resolveRepoBasename(root: string): Promise<string> {
  const fallback = basename(root);
  const commonDir = await gitExec(["rev-parse", "--path-format=absolute", "--git-common-dir"], {
    cwd: root,
  });
  if (commonDir.code !== 0) return fallback;
  const gitCommonDir = commonDir.stdout.trim();
  if (!gitCommonDir) return fallback;
  return basename(dirname(gitCommonDir)) || fallback;
}

async function readGitFactsFromSubprocesses(
  root: string,
  baseRef: string,
): Promise<StatuslineLocalGit> {
  const ctx: gitx.GitContext = { cwd: root };
  const [repoBasename, branch, sha, diff] = await Promise.all([
    resolveRepoBasename(root),
    gitx.currentBranch(ctx).catch(() => ""),
    gitx.headShortSha(ctx).catch(() => ""),
    gitx.diffstatShortstat(ctx, baseRef).catch(() => ({ added: 0, removed: 0 })),
  ]);
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
  const path = afkPaths(root).statuslineGitCachePath;
  const cached = decodeGitCache((deps.readCache ?? readCacheFile)(path));
  const ageMs = cached ? now - cached.tsMs : Number.POSITIVE_INFINITY;
  if (cached && cached.baseRef === baseRef && ageMs >= 0 && ageMs < ttlMs) return factsOf(cached);

  const write = deps.writeCache ?? writeCacheFile;
  const refresh = (deps.readGitFacts ?? readGitFactsFromSubprocesses)(root, baseRef)
    .then((facts) => {
      write(path, encodeDevSnapshotToon({ ...facts, baseRef, tsMs: now } as unknown as ToonValue));
      return facts;
    })
    .catch(() => null);
  const refreshed = await withTimeout(refresh, deps.deadlineMs ?? STATUSLINE_GIT_DEADLINE_MS, null);
  if (refreshed) return refreshed;
  return cached ? factsOf(cached) : { basename: basename(root), localAdded: 0, localRemoved: 0 };
}
