// cache — a kept answer, and how old it is.
//
// ADR 0132 Amendment 2, third responsibility. Counts, issue bodies and pull
// request states are read far more often than they change, so the cheapest call
// is the one not made.
//
// **The age travels with the value.** Everything else in this system already
// works this way — the liveness verdict, the queue depth, the worker display —
// because a consumer that cannot see staleness cannot tell a fresh answer from
// a remembered one, and will render the second as the first.
//
// **This is also the precondition for semi-offline.** There is nothing to fall
// back to unless something was kept, so the cache is not an optimization bolted
// onto the breaker; it is the half that makes the breaker survivable.
//
// PURE. The store is handed in and handed back; nothing here reads a clock or a
// socket.

/** A value, when it was fetched, and how long it may be believed. */
export interface GithubCacheEntry<T> {
  readonly value: T;
  /** Epoch ms of the fetch that produced `value`. */
  readonly fetchedAtMs: number;
  /** How long this KIND of answer stays useful, decided by the caller. */
  readonly ttlMs: number;
}

/** What a reader gets back: the value, plus what it must render about its age. */
export interface GithubCacheHit<T> {
  readonly value: T;
  readonly ageMs: number;
  /** True once `ageMs` passed the entry's TTL — the value is still returned. */
  readonly stale: boolean;
}

export type GithubCache = Readonly<Record<string, GithubCacheEntry<unknown>>>;

/**
 * How long each kind of answer may be believed.
 *
 * Chosen by rate of change, not by importance. A repository's activity counts
 * move constantly and matter little; an issue's body changes rarely and matters
 * a great deal — a long TTL on the second is safe precisely because it is
 * rarely wrong, and a short one on the first is cheap precisely because the
 * answer is cheap to re-ask.
 */
export const GITHUB_CACHE_TTL_MS = {
  /** Open PR/issue counts for a dashboard header. */
  counts: 180_000,
  /** One issue's body and labels. */
  issue: 60_000,
  /** One pull request's mergeability and head sha. */
  pull: 30_000,
} as const;

export type GithubCacheKind = keyof typeof GITHUB_CACHE_TTL_MS;

/** The key an entry is stored under. PURE. */
export function githubCacheKey(kind: GithubCacheKind, repo: string, id: string | number = ""): string {
  return id === "" ? `${kind}:${repo}` : `${kind}:${repo}:${id}`;
}

/**
 * Read an entry, stale or not. PURE.
 *
 * **A stale entry is returned, never dropped.** Dropping it would leave a caller
 * with nothing exactly when the network or the budget is the reason it is stale
 * — which is the moment the remembered answer is worth most. The caller decides
 * what to do with `stale`; this module refuses to decide for it.
 */
export function readGithubCache<T>(
  cache: GithubCache,
  key: string,
  nowMs: number,
): GithubCacheHit<T> | null {
  const entry = cache[key] as GithubCacheEntry<T> | undefined;
  if (entry === undefined) return null;
  const ageMs = Math.max(0, nowMs - entry.fetchedAtMs);
  return { value: entry.value, ageMs, stale: ageMs >= entry.ttlMs };
}

/** Store a freshly fetched value. PURE — returns the next cache. */
export function writeGithubCache<T>(
  cache: GithubCache,
  key: string,
  value: T,
  kind: GithubCacheKind,
  nowMs: number,
): GithubCache {
  return { ...cache, [key]: { value, fetchedAtMs: nowMs, ttlMs: GITHUB_CACHE_TTL_MS[kind] } };
}

/**
 * Drop entries older than `maxAgeMs`, whatever their TTL. PURE.
 *
 * TTL says when a value stops being current; this says when it stops being
 * worth keeping at all. A process that never forgets is a process whose memory
 * grows with its uptime.
 */
export function pruneGithubCache(cache: GithubCache, nowMs: number, maxAgeMs: number): GithubCache {
  const next: Record<string, GithubCacheEntry<unknown>> = {};
  for (const [key, entry] of Object.entries(cache)) {
    if (nowMs - entry.fetchedAtMs < maxAgeMs) next[key] = entry;
  }
  return next;
}
