// balance-store — one token-wide budget picture shared by every local process.

import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { decode, encode, type JsonValue } from "@reddb-io/toon";
import { LANE_RETENTION_REGISTRY } from "@reddb-io/shared/lane-retention.js";

import { GITHUB_POOLS, type GithubBalance, type GithubPoolBalance } from "./balance.js";
import type { GithubRateBudget } from "./surface.js";

export interface GithubBalanceStore {
  /** Read the latest complete snapshot. Missing or malformed state is unknown, never a full budget. */
  read(): Promise<GithubBalance | null>;
  /** Atomically replace the snapshot observed by all subsequent readers. */
  write(balance: GithubBalance): Promise<void>;
}

export interface CreateGithubBalanceStoreOptions {
  /** Durable TOON path below the daemon's state/github lane. */
  readonly path: string;
  /** Test override; production uses the registry-declared ceiling. */
  readonly maxBytes?: number;
}

/** A bounded atomic snapshot: one file, one current answer, no process-local warm-up call. */
export function createGithubBalanceStore(options: CreateGithubBalanceStoreOptions): GithubBalanceStore {
  const maxBytes = options.maxBytes ?? LANE_RETENTION_REGISTRY["github-balance"].maxBytes;
  return {
    async read(): Promise<GithubBalance | null> {
      try {
        const parsed = decode(await readFile(options.path, "utf8"));
        return isGithubBalance(parsed) ? parsed : null;
      } catch (error) {
        if (isNodeError(error) && error.code === "ENOENT") return null;
        // A torn predecessor or unreadable schema is no budget observation. The
        // writer's atomic rename makes this exceptional, but failing open as
        // "unknown" is still safer than turning corruption into "spent".
        return null;
      }
    },

    async write(balance: GithubBalance): Promise<void> {
      const rendered = `${encode(balance as unknown as JsonValue)}\n`;
      const bytes = Buffer.byteLength(rendered);
      if (bytes > maxBytes) {
        throw new Error(`GitHub balance snapshot exceeds its ${maxBytes}-byte lane ceiling`);
      }
      const directory = dirname(options.path);
      await mkdir(directory, { recursive: true });
      const temporary = `${options.path}.write-${process.pid}-${randomUUID()}`;
      try {
        await writeFile(temporary, rendered, { encoding: "utf8", mode: 0o600 });
        await rename(temporary, options.path);
      } finally {
        await rm(temporary, { force: true }).catch(() => undefined);
      }
    },
  };
}

function isGithubBalance(value: unknown): value is GithubBalance {
  if (!record(value)) return false;
  if (value.version !== 1 || value.origin !== "asked" || value.source !== "GET /rate_limit") return false;
  if (value.outcome !== "asked" && value.outcome !== "unanswered") return false;
  if (typeof value.asked_at !== "string" || !Number.isFinite(Date.parse(value.asked_at))) return false;
  if (!Number.isSafeInteger(value.request_count) || (value.request_count as number) < 0) return false;
  if (!record(value.pools) || !Array.isArray(value.unreported_pools) || typeof value.detail !== "string") return false;
  return GITHUB_POOLS.every((pool) => {
    const candidate = value.pools![pool];
    return candidate === null || isPool(candidate, pool);
  }) && value.unreported_pools.every((pool) => GITHUB_POOLS.includes(pool as GithubRateBudget));
}

function isPool(value: unknown, pool: GithubRateBudget): value is GithubPoolBalance {
  if (!record(value) || value.pool !== pool || typeof value.resource !== "string") return false;
  if (typeof value.reset_at !== "string" || !Number.isFinite(Date.parse(value.reset_at))) return false;
  return [value.limit, value.remaining, value.used].every((count) => Number.isSafeInteger(count) && (count as number) >= 0) &&
    typeof value.fraction === "number" && Number.isFinite(value.fraction);
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
