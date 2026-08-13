import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  LANE_RETENTION_REGISTRY,
  laneOverCeiling,
  trimLaneKeepLast,
} from "@reddb-io/shared/lane-retention.js";
import { encodeToonlLines } from "@reddb-io/toon";
import { parseRecords } from "@reddb-io/toon";

import { GITHUB_POOLS, type GithubBalance } from "./balance.js";
import type { GithubRateBudget } from "./surface.js";

export interface GithubBalanceHistoryRow {
  readonly ts: string;
  /**
   * WHICH bucket this row measures — `pat` or `app:<installation>`.
   *
   * Two identities on one host have two independent 5,000/hour ceilings, and a
   * series that does not say whose it is cannot be plotted, summed safely, or
   * compared over time: a consumer would read two interleaved sawtooths as one
   * impossible one. Rows written before identities existed carry no column, so
   * a reader treats an absent value as the personal token.
   */
  readonly identity: string;
  readonly pool: GithubRateBudget;
  readonly remaining: number;
  readonly used: number;
  readonly limit: number;
  readonly reset_at: number;
  readonly asked_at: string;
}

export interface GithubBalanceHistory {
  append(balance: GithubBalance): Promise<void>;
}

export interface CreateGithubBalanceHistoryOptions {
  readonly path: string;
  /** The identity whose ceiling this history measures. Defaults to the person. */
  readonly identity?: string;
  readonly clock?: () => string;
  /** Test override; production uses the registry-declared ceiling. */
  readonly maxBytes?: number;
}

/** Append the authoritative answer as one readable row per reported pool. */
export function createGithubBalanceHistory(
  options: CreateGithubBalanceHistoryOptions,
): GithubBalanceHistory {
  const clock = options.clock ?? (() => new Date().toISOString());
  const policy = LANE_RETENTION_REGISTRY["github-balance-history"];
  const maxBytes = options.maxBytes ?? policy.maxBytes;
  const identity = options.identity ?? "pat";
  let pendingWrite = Promise.resolve();
  return {
    async append(balance): Promise<void> {
      const ts = clock();
      const rows: GithubBalanceHistoryRow[] = [];
      for (const pool of GITHUB_POOLS) {
        const observed = balance.pools[pool];
        if (observed === null) continue;
        rows.push({
          ts,
          identity,
          pool,
          remaining: observed.remaining,
          used: observed.used,
          limit: observed.limit,
          reset_at: Math.floor(Date.parse(observed.reset_at) / 1_000),
          asked_at: balance.asked_at,
        });
      }
      if (rows.length === 0) return;
      const writer = encodeToonlLines({ trailer: false });
      const segment = rows.map((row) => writer.push(row)).join("");
      const incomingBytes = Buffer.byteLength(segment);
      pendingWrite = pendingWrite.then(async () => {
        await mkdir(dirname(options.path), { recursive: true });
        if (incomingBytes > maxBytes) {
          throw new Error(`GitHub balance history observation exceeds its ${maxBytes}-byte lane ceiling`);
        }
        if (await laneOverCeiling(options.path, incomingBytes, { maxBytes })) {
          const existing = await readRows(options.path);
          const targetBytes = Math.max(Math.floor(maxBytes * policy.targetRatio), incomingBytes);
          await trimLaneKeepLast(
            options.path,
            keepLastWithin(existing, incomingBytes, targetBytes),
          );
        }
        await appendFile(options.path, segment, { encoding: "utf8", mode: 0o600 });
      });
      return pendingWrite;
    },
  };
}

type ToonlRecord = Record<string, string | number | boolean | null>;

async function readRows(path: string): Promise<ToonlRecord[]> {
  try {
    const raw = await readFile(path, "utf8");
    return raw.trim() === "" ? [] : parseRecords(raw);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

function keepLastWithin(
  rows: readonly ToonlRecord[],
  incomingBytes: number,
  targetBytes: number,
): number {
  let low = 0;
  let high = rows.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    const retained = encodeRows(rows.slice(-middle));
    if (Buffer.byteLength(retained) + incomingBytes <= targetBytes) low = middle;
    else high = middle - 1;
  }
  return low;
}

function encodeRows(rows: readonly ToonlRecord[]): string {
  return rows.map((row) => encodeToonlLines({ trailer: false }).push(row)).join("");
}
