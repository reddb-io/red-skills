// attribution.ts — what THIS process believes it spent, by operation key.
//
// This is deliberately not a balance. `GithubBalance` remains the authoritative
// answer from `GET /rate_limit`; this append-only ledger is local evidence about
// calls that passed through the routed client. A mismatch between the two is a
// finding (for example, another process used the token), never a reason to turn
// these observations into GitHub's balance.

import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  LANE_RETENTION_REGISTRY,
  laneOverCeiling,
  trimLaneKeepLast,
  type LaneRetentionPolicy,
} from "@reddb-io/shared/lane-retention.js";
import { encodeToonlLines, parseRecords } from "@reddb-io/toon";

import type { GithubRateBudget } from "./surface.js";

type ToonlRecord = Record<string, string | number | boolean | null>;

/** The two routing facts attribution consumes, without re-stating policy. */
export interface GithubAttributedOperation {
  readonly key: string;
  readonly budget: GithubRateBudget;
}

/** One completed routed call, priced by the transport that observed it. */
export interface GithubSpendObservation {
  readonly version: 1;
  readonly observed_at: string;
  readonly operation_key: string;
  readonly pool: GithubRateBudget;
  /** Process/work owner when the transport can name one (for example a Worker). */
  readonly actor?: string;
  readonly cost: number;
}

/** One operation/pool row in a spend report. */
export interface GithubOperationSpend {
  readonly operation_key: string;
  readonly pool: GithubRateBudget;
  readonly actor?: string;
  readonly count: number;
  readonly cost: number;
}

/** A reproducible projection over the durable local observation ledger. */
export interface GithubSpendAttributionReport {
  readonly version: 1;
  /** Keeps this document structurally and semantically distinct from a balance. */
  readonly origin: "process-attribution";
  /** The report uses the half-open interval `[from, to)`. */
  readonly window: { readonly from: string; readonly to: string };
  /** `null` means every pool was included. */
  readonly pool: GithubRateBudget | null;
  readonly total_count: number;
  readonly total_cost: number;
  readonly operations: readonly GithubOperationSpend[];
  /** Invalid or torn JSONL records ignored while rebuilding the report. */
  readonly unreadable_records: number;
}

export interface GithubAttributionLedger {
  /** Append one transport-observed call to durable storage. */
  record(input: {
    readonly operation: GithubAttributedOperation;
    readonly cost: number;
    readonly actor?: string;
    readonly observedAt?: string;
  }): Promise<void>;
  /** Aggregate durable observations for a half-open time window. */
  report(input: {
    readonly from: string;
    readonly to: string;
    readonly pool?: GithubRateBudget;
  }): Promise<GithubSpendAttributionReport>;
}

export interface CreateGithubAttributionLedgerOptions {
  /** Durable TOONL path. The caller owns where project/host state lives. */
  readonly path: string;
  readonly now?: () => string;
  /** Override the production byte ceiling; exposed for tiny-lane tests. */
  readonly maxBytes?: number;
}

/**
 * Create an append-only, restart-durable spend ledger.
 *
 * The transport supplies `cost`: REST/Search hooks normally observe one request,
 * while GraphQL observes the response's point cost. Requiring the value here is
 * what prevents the ledger from silently equating one GraphQL call with one
 * point. The operation supplies both key and pool from the routing table, so a
 * caller cannot price a GraphQL operation against REST by accident.
 */
export function createGithubAttributionLedger(
  options: CreateGithubAttributionLedgerOptions,
): GithubAttributionLedger {
  const now = options.now ?? (() => new Date().toISOString());
  const registeredPolicy = LANE_RETENTION_REGISTRY["github-spend"];
  const retentionPolicy: LaneRetentionPolicy = {
    ...registeredPolicy,
    ...(options.maxBytes === undefined ? {} : { maxBytes: options.maxBytes }),
  };
  // Serialize writes made by one process. Separate processes still append whole
  // JSONL records independently; rebuilding never depends on in-memory state.
  let pendingWrite: Promise<void> = Promise.resolve();

  return {
    record(input): Promise<void> {
      const observation = makeObservation(input.operation, input.cost, input.observedAt ?? now(), input.actor);
      const segment = encodeToonlLines().push(toToonlRecord(observation));
      pendingWrite = pendingWrite.then(async () => {
        await mkdir(dirname(options.path), { recursive: true });
        const incomingBytes = Buffer.byteLength(segment);
        if (await laneOverCeiling(options.path, incomingBytes, retentionPolicy)) {
          const ceiling = retentionPolicy.maxBytes!;
          if (incomingBytes > ceiling) {
            throw new Error(`GitHub spend observation exceeds its ${ceiling}-byte lane ceiling`);
          }
          const rows = await readLaneRows(options.path);
          const targetBytes = Math.max(
            Math.floor(ceiling * registeredPolicy.targetRatio),
            incomingBytes,
          );
          await trimLaneKeepLast(options.path, keepLastWithin(rows, incomingBytes, targetBytes));
        }
        await appendFile(options.path, segment, "utf8");
      });
      return pendingWrite;
    },

    async report(input): Promise<GithubSpendAttributionReport> {
      await pendingWrite;
      const from = instant(input.from, "report window start");
      const to = instant(input.to, "report window end");
      if (to <= from) throw new Error("GitHub attribution report window end must be after its start");

      const read = await readObservations(options.path);
      const grouped = new Map<string, GithubOperationSpend>();
      for (const observation of read.observations) {
        const observedAt = Date.parse(observation.observed_at);
        if (observedAt < from || observedAt >= to) continue;
        if (input.pool !== undefined && observation.pool !== input.pool) continue;
        const groupKey = `${observation.pool}\u0000${observation.operation_key}\u0000${observation.actor ?? ""}`;
        const current = grouped.get(groupKey);
        grouped.set(groupKey, {
          operation_key: observation.operation_key,
          pool: observation.pool,
          ...(observation.actor === undefined ? {} : { actor: observation.actor }),
          count: (current?.count ?? 0) + 1,
          cost: (current?.cost ?? 0) + observation.cost,
        });
      }

      const operations = [...grouped.values()].sort(
        (left, right) =>
          right.cost - left.cost ||
          right.count - left.count ||
          left.operation_key.localeCompare(right.operation_key) ||
          left.pool.localeCompare(right.pool) ||
          (left.actor ?? "").localeCompare(right.actor ?? ""),
      );
      return {
        version: 1,
        origin: "process-attribution",
        window: { from: input.from, to: input.to },
        pool: input.pool ?? null,
        total_count: operations.reduce((sum, operation) => sum + operation.count, 0),
        total_cost: operations.reduce((sum, operation) => sum + operation.cost, 0),
        operations,
        unreadable_records: read.unreadable,
      };
    },
  };
}

async function readLaneRows(path: string): Promise<ToonlRecord[]> {
  try {
    const raw = await readFile(path, "utf8");
    return raw.trim() === "" ? [] : parseRecords(raw);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return [];
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
    if (Buffer.byteLength(retained) + incomingBytes <= targetBytes) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }
  return low;
}

function encodeRows(rows: readonly ToonlRecord[]): string {
  return rows.map((row) => encodeToonlLines({ trailer: false }).push(row)).join("");
}

function makeObservation(
  operation: GithubAttributedOperation,
  cost: number,
  observedAt: string,
  actor?: string,
): GithubSpendObservation {
  instant(observedAt, "GitHub spend observation");
  if (!Number.isSafeInteger(cost) || cost < 0) {
    throw new Error(`GitHub spend observation cost must be a non-negative safe integer; received ${cost}`);
  }
  if (actor !== undefined && actor.trim() === "") {
    throw new Error("GitHub spend observation actor must be non-empty when supplied");
  }
  return {
    version: 1,
    observed_at: observedAt,
    operation_key: operation.key,
    pool: operation.budget,
    ...(actor === undefined ? {} : { actor }),
    cost,
  };
}

async function readObservations(
  path: string,
): Promise<{ readonly observations: GithubSpendObservation[]; readonly unreadable: number }> {
  let contents: string;
  try {
    contents = await readFile(path, "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return { observations: [], unreadable: 0 };
    throw error;
  }

  const observations: GithubSpendObservation[] = [];
  let unreadable = 0;
  const lines = contents.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const header = lines[index]!;
    if (header.trim() === "") continue;
    const row = lines[index + 1];
    if (!header.startsWith("[]{") || row === undefined || row.trim() === "") {
      unreadable += 1;
      continue;
    }

    let parsed: unknown;
    try {
      parsed = parseRecords(`${header}\n${row}\n`)[0];
    } catch {
      unreadable += 1;
      index += 1;
      continue;
    }
    if (!isObservation(parsed)) {
      unreadable += 1;
      index += 1;
      continue;
    }
    observations.push(parsed);
    index += 1;
  }
  return { observations, unreadable };
}

function toToonlRecord(observation: GithubSpendObservation): ToonlRecord {
  return {
    version: observation.version,
    observed_at: observation.observed_at,
    operation_key: observation.operation_key,
    pool: observation.pool,
    ...(observation.actor === undefined ? {} : { actor: observation.actor }),
    cost: observation.cost,
  };
}

function isObservation(value: unknown): value is GithubSpendObservation {
  if (!isRecord(value)) return false;
  return value.version === 1 &&
    typeof value.observed_at === "string" &&
    Number.isFinite(Date.parse(value.observed_at)) &&
    typeof value.operation_key === "string" &&
    value.operation_key !== "" &&
    (value.pool === "rest" || value.pool === "graphql" || value.pool === "search") &&
    (value.actor === undefined || (typeof value.actor === "string" && value.actor !== "")) &&
    typeof value.cost === "number" &&
    Number.isSafeInteger(value.cost) &&
    value.cost >= 0;
}

function instant(value: string, label: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error(`${label} must be an ISO-8601 instant; received ${JSON.stringify(value)}`);
  return parsed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error && "code" in value;
}
