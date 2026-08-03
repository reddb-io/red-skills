// cache.ts — kept GitHub answers, each carrying its own age.
//
// ADR 0132 Amendment 2, third item. Counts, issue bodies and pull-request states
// are read far more often than they change, and the read is what spends the
// budget. Keeping them is the cheap half; the expensive half is what a consumer
// does with a kept value it cannot date.
//
// **The value travels with its staleness, as everything else in this system
// does.** A cache that answered `7` would be indistinguishable from a tracker
// that currently holds seven open issues, and the whole class of defect this repo
// keeps hitting is a stale fact presented as a current one. Every read here comes
// back with `age_ms` and an outcome, so a surface renders the age rather than
// inventing currency it was never given.
//
// **A stale entry is labelled, never dropped.** This is deliberate and it is the
// point: the cache is the precondition for graduated degradation — *there is
// nothing to fall back to unless something was kept*. A cache that evicted on
// expiry would be empty exactly when the reserved band starts refusing the reads
// that would refill it.
//
// **The cache knows nothing about what it holds.** `kind` is an opaque label the
// caller chooses and the cache only echoes, for the same reason the daemon stores
// a count without knowing what an open pull request is (ADR 0130 rule 3). A cache
// that parsed an issue body would be carrying castle semantics.
//
// PURE apart from the mutation of the store the factory hands back; every
// instant is an argument, and nothing here reads a clock.

/** How long a kept answer is treated as current, when the caller states nothing. */
export const DEFAULT_GITHUB_CACHE_FRESH_MS = 60_000;

/**
 * How many answers one cache holds before the oldest is dropped.
 *
 * Bounded because the daemon outlives every session that talks to it: an
 * unbounded map keyed by issue number is a slow leak whose symptom arrives weeks
 * after the code that caused it.
 */
export const DEFAULT_GITHUB_CACHE_CAPACITY = 512;

/** One kept answer. `kind` is the caller's label and is never interpreted here. */
export interface GithubCacheEntry<T = unknown> {
  readonly key: string;
  readonly kind: string;
  readonly value: T;
  readonly fetched_at: string;
  /** This entry's own freshness window, when it differs from the cache's. */
  readonly fresh_ms: number;
}

/**
 * How a read came out.
 *
 * `stale` is a HIT: the value is there and is old, which is a different fact from
 * `miss` and leads to a different render. Collapsing the two is what makes a
 * degraded surface look like an empty one.
 */
export type GithubCacheOutcome = "fresh" | "stale" | "miss";

export interface GithubCacheRead<T = unknown> {
  readonly key: string;
  readonly hit: boolean;
  readonly outcome: GithubCacheOutcome;
  readonly kind: string | null;
  readonly value: T | undefined;
  readonly fetched_at: string | null;
  /** `null` when nothing was kept, or when what was kept carries no instant. */
  readonly age_ms: number | null;
  readonly fresh_ms: number;
  readonly reason: string;
}

export interface GithubCachePut<T = unknown> {
  readonly key: string;
  readonly kind: string;
  readonly value: T;
  readonly fetchedAt: string;
  /** This entry's freshness window; the cache's default when absent. */
  readonly freshMs?: number;
}

export interface GithubCache {
  /** Keep one answer, replacing whatever this key held. */
  put<T>(entry: GithubCachePut<T>): void;
  /** Read one key. Always answers — with a value and its age, or with a miss. */
  read<T>(key: string, options: { readonly now: string }): GithubCacheRead<T>;
  /** Drop one key, for a caller that has learned the answer is wrong. */
  forget(key: string): boolean;
  /** Every entry kept, oldest first — the shape a diagnostic surface renders. */
  entries(): readonly GithubCacheEntry[];
  size(): number;
}

export interface CreateGithubCacheOptions {
  readonly freshMs?: number;
  readonly capacity?: number;
}

/**
 * One cache. The store is a plain map: the daemon holds a single instance, and a
 * durable copy would be a second authority on an answer that is already cheap to
 * ask for again.
 */
export function createGithubCache(options: CreateGithubCacheOptions = {}): GithubCache {
  const defaultFreshMs = options.freshMs ?? DEFAULT_GITHUB_CACHE_FRESH_MS;
  const capacity = Math.max(1, options.capacity ?? DEFAULT_GITHUB_CACHE_CAPACITY);
  const store = new Map<string, GithubCacheEntry>();

  function evictOldest(): void {
    while (store.size > capacity) {
      let oldestKey: string | null = null;
      let oldestMs = Number.POSITIVE_INFINITY;
      for (const [key, entry] of store) {
        const ms = Date.parse(entry.fetched_at);
        // An entry nobody can date is the first to go: it can never be called
        // fresh again, so it is pure occupancy.
        const rank = Number.isFinite(ms) ? ms : Number.NEGATIVE_INFINITY;
        if (rank < oldestMs) {
          oldestMs = rank;
          oldestKey = key;
        }
      }
      if (oldestKey == null) return;
      store.delete(oldestKey);
    }
  }

  return {
    put<T>(entry: GithubCachePut<T>): void {
      store.delete(entry.key);
      store.set(entry.key, {
        key: entry.key,
        kind: entry.kind,
        value: entry.value,
        fetched_at: entry.fetchedAt,
        fresh_ms: entry.freshMs ?? defaultFreshMs,
      });
      evictOldest();
    },
    read<T>(key: string, readOptions: { readonly now: string }): GithubCacheRead<T> {
      const entry = store.get(key) as GithubCacheEntry<T> | undefined;
      if (entry == null) {
        return {
          key,
          hit: false,
          outcome: "miss",
          kind: null,
          value: undefined,
          fetched_at: null,
          age_ms: null,
          fresh_ms: defaultFreshMs,
          reason: `nothing was kept for ${JSON.stringify(key)}, so there is nothing to fall back to`,
        };
      }
      const ageMs = ageOf(entry.fetched_at, readOptions.now);
      if (ageMs == null) {
        return {
          key,
          hit: true,
          outcome: "stale",
          kind: entry.kind,
          value: entry.value,
          fetched_at: entry.fetched_at,
          age_ms: null,
          fresh_ms: entry.fresh_ms,
          reason:
            `${JSON.stringify(key)} was kept with no readable instant, so it cannot be presented as current`,
        };
      }
      const fresh = ageMs <= entry.fresh_ms;
      return {
        key,
        hit: true,
        outcome: fresh ? "fresh" : "stale",
        kind: entry.kind,
        value: entry.value,
        fetched_at: entry.fetched_at,
        age_ms: ageMs,
        fresh_ms: entry.fresh_ms,
        reason: fresh
          ? `kept ${humanAge(ageMs)} ago, inside the ${humanAge(entry.fresh_ms)} window`
          : `stale: kept ${humanAge(ageMs)} ago, past the ${humanAge(entry.fresh_ms)} window`,
      };
    },
    forget(key: string): boolean {
      return store.delete(key);
    },
    entries(): readonly GithubCacheEntry[] {
      return [...store.values()].sort((a, b) => (Date.parse(a.fetched_at) || 0) - (Date.parse(b.fetched_at) || 0));
    },
    size(): number {
      return store.size;
    },
  };
}

/**
 * One line a surface prints beside a cached value. PURE.
 *
 * Exists so every consumer renders the age the same way: the acceptance this
 * serves is that cached values carry their age AND that every consumer shows it,
 * and four hand-written spellings of one staleness drift into four.
 */
export function describeGithubCacheRead(read: GithubCacheRead): string {
  if (!read.hit) return read.reason;
  if (read.age_ms == null) return read.reason;
  return read.outcome === "stale"
    ? `stale (${humanAge(read.age_ms)} old)`
    : `${humanAge(read.age_ms)} old`;
}

function ageOf(fetchedAt: string, now: string): number | null {
  const fetchedMs = Date.parse(fetchedAt);
  const nowMs = Date.parse(now);
  if (!Number.isFinite(fetchedMs) || !Number.isFinite(nowMs)) return null;
  return Math.max(0, nowMs - fetchedMs);
}

function humanAge(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const seconds = Math.round(ms / 1000);
  if (seconds < 90) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return `${minutes}m`;
  return `${Math.round(minutes / 60)}h`;
}
