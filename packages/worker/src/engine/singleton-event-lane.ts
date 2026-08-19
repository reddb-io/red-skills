/**
 * Durable event distribution for repo-scoped singleton owners.
 *
 * Owners append uniform records to one TOONL lane in the Castle state tier;
 * supervisors, waits, and views consume the same ordered stream. The open tail
 * remains valid after a writer crash, following the existing Castle TOONL lane
 * grammar rather than introducing a socket or RPC lifecycle.
 */
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  LANE_RETENTION_REGISTRY,
  laneOverCeiling,
  trimLaneKeepLast,
  type LaneRetentionPolicy,
} from "@reddb-io/shared/lane-retention.js";
import { encodeToonlLines, parseRecords } from "@reddb-io/toon";
import type { EnginePaths } from "./paths.js";

type ToonlRecord = Record<string, string | number | boolean | null>;

export interface SingletonEventRecord {
  readonly at: string;
  readonly singleton: string;
  readonly kind: string;
  readonly payload?: Record<string, unknown>;
}

export type SingletonEventInput = Omit<SingletonEventRecord, "at"> & {
  readonly at?: string;
};

export interface SingletonEventLaneFs {
  appendFile(path: string, data: string, encoding: "utf8"): Promise<unknown>;
  mkdir(path: string, options: { recursive: true }): Promise<unknown>;
  readFile(path: string, encoding: "utf8"): Promise<string>;
}

export interface SingletonEventLaneOptions {
  readonly fs?: SingletonEventLaneFs;
  readonly clock?: () => string;
  /** Override the production byte ceiling; exposed for tiny-lane tests. */
  readonly maxBytes?: number;
}

export interface SingletonEventReadOptions {
  /** Return at most the newest N records, preserving chronological order. */
  readonly tail?: number;
}

export interface SingletonEventLane {
  readonly path: string;
  append(event: SingletonEventInput): Promise<SingletonEventRecord>;
  read(options?: SingletonEventReadOptions): Promise<SingletonEventRecord[]>;
}

function assertNonEmpty(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`singleton event ${field} must be a non-empty string`);
  }
  return value;
}

function validateEvent(value: unknown): SingletonEventRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("singleton event must be a record");
  }
  const raw = { ...(value as Record<string, unknown>) };
  const payload = raw.payload;
  if (typeof payload === "string") {
    try {
      raw.payload = JSON.parse(payload) as Record<string, unknown>;
    } catch {
      throw new Error("singleton event payload is not valid JSON");
    }
  }
  if (
    raw.payload !== undefined &&
    (raw.payload === null ||
      typeof raw.payload !== "object" ||
      Array.isArray(raw.payload))
  ) {
    throw new Error("singleton event payload must be a record");
  }
  return {
    at: assertNonEmpty(raw.at, "at"),
    singleton: assertNonEmpty(raw.singleton, "singleton"),
    kind: assertNonEmpty(raw.kind, "kind"),
    ...(raw.payload === undefined
      ? {}
      : { payload: raw.payload as Record<string, unknown> }),
  };
}

function toRow(event: SingletonEventRecord): ToonlRecord {
  return {
    at: event.at,
    singleton: event.singleton,
    kind: event.kind,
    ...(event.payload === undefined
      ? {}
      : { payload: JSON.stringify(event.payload) }),
  };
}

function assertTail(tail: number | undefined): void {
  if (tail !== undefined && (!Number.isSafeInteger(tail) || tail < 0)) {
    throw new Error("singleton event tail must be a non-negative integer");
  }
}

function encodeRows(rows: readonly ToonlRecord[]): string {
  if (rows.length === 0) return "";
  const writer = encodeToonlLines({ trailer: false });
  return rows.map((row) => writer.push(row)).join("");
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
    const retained = rows.slice(-middle);
    if (Buffer.byteLength(encodeRows(retained)) + incomingBytes <= targetBytes) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }
  return low;
}

export function singletonEventLanePath(paths: EnginePaths): string {
  return join(paths.castleStateRoot, "singleton-events.toonl");
}

export function createSingletonEventLane(
  paths: EnginePaths,
  options: SingletonEventLaneOptions = {},
): SingletonEventLane {
  const fs = options.fs ?? { appendFile, mkdir, readFile };
  const clock = options.clock ?? (() => new Date().toISOString());
  const path = singletonEventLanePath(paths);
  const registeredPolicy = LANE_RETENTION_REGISTRY["castle-singleton-events"];
  const retentionPolicy: LaneRetentionPolicy = {
    ...registeredPolicy,
    ...(options.maxBytes === undefined ? {} : { maxBytes: options.maxBytes }),
  };

  return {
    path,

    async append(input) {
      const event = validateEvent({ at: input.at ?? clock(), ...input });
      const encoded = encodeToonlLines().push(toRow(event));
      const incomingBytes = Buffer.byteLength(encoded);
      await fs.mkdir(dirname(path), { recursive: true });
      if (await laneOverCeiling(path, incomingBytes, retentionPolicy)) {
        const ceiling = retentionPolicy.maxBytes!;
        if (incomingBytes > ceiling) {
          throw new Error(
            `singleton event exceeds its ${ceiling}-byte lane ceiling`,
          );
        }
        const raw = await fs.readFile(path, "utf8");
        const rows = parseRecords(raw);
        const halfTarget = Math.floor(
          ceiling * registeredPolicy.targetRatio,
        );
        const targetBytes = Math.max(halfTarget, incomingBytes);
        const keepLast = keepLastWithin(
          rows,
          incomingBytes,
          targetBytes,
        );
        await trimLaneKeepLast(path, keepLast);
      }
      await fs.appendFile(path, encoded, "utf8");
      return event;
    },

    async read(readOptions = {}) {
      assertTail(readOptions.tail);
      let text: string;
      try {
        text = await fs.readFile(path, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw error;
      }
      const events = parseRecords(text).map(validateEvent);
      if (readOptions.tail === undefined) return events;
      if (readOptions.tail === 0) return [];
      return events.slice(-readOptions.tail);
    },
  };
}
