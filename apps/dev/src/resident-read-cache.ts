export const RESIDENT_CACHE_TTL_MS = 15_000;

interface CacheEntry {
  value: unknown;
  at: number;
}

/**
 * Short-TTL in-memory read cache for the GitHub-backed MCP read tools.
 * Repeated calls within `ttlMs` cost zero GitHub requests. Mutating tool
 * paths call `invalidate` to evict the affected keys immediately.
 */
export class ResidentReadCache {
  private store = new Map<string, CacheEntry>();
  readonly ttlMs: number;

  constructor(ttlMs = RESIDENT_CACHE_TTL_MS) {
    this.ttlMs = ttlMs;
  }

  get(key: string, now = Date.now()): unknown {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (now - entry.at > this.ttlMs) {
      this.store.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key: string, value: unknown, now = Date.now()): void {
    this.store.set(key, { value, at: now });
  }

  invalidate(...keys: string[]): void {
    for (const key of keys) this.store.delete(key);
  }
}

export const QUEUE_STATUS_KEY = "queue_status";
export const claimStatusKey = (issue: number): string => `claim_status:${issue}`;
export const cascadeStatusKey = (issue: number): string => `cascade_status:${issue}`;
