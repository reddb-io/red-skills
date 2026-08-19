import { readFile } from "node:fs/promises";
import { parseRecords } from "@reddb-io/toon";
import { LANE_RETENTION_REGISTRY } from "@reddb-io/shared/lane-retention.js";
import type { AgentStreamEvent } from "./AgentStreamEmitter.js";
import {
  appendCastleLaneRecord,
  CASTLE_LANE_FILENAMES,
} from "./engine/lane-writers.js";

/**
 * The liveness lane — a dedicated, append-only activity record for one attempt,
 * written **only by the substrate's own control flow** (ADR 0083 §3).
 *
 * Motivation (the poisoned-firehose class): today's stall detection keys off a
 * firehose file whose mtime the agent's *own* relayed heartbeat/usage records
 * refresh, so a stalled worker looks alive forever. The lane is the
 * un-poisonable counterpart. Its write surface accepts a closed set of
 * substrate control-flow signals (`LivenessSignalKind`) — iteration boundaries
 * and tool-lifecycle callbacks the substrate itself executes. It deliberately
 * has **no** variant for agent-emitted output (text / reasoning / usage /
 * heartbeat, which flow through `AgentStreamEvent`), and there is no adapter
 * from `AgentStreamEvent` to `LivenessSignalKind`, so relayed events cannot
 * reach the lane.
 */
export type LivenessSignalKind =
  "iteration-start" | "iteration-end" | "tool-start" | "tool-end";

/** One append-only lane record. `at` is epoch-ms from the lane's injected clock. */
export interface LivenessRecord {
  readonly at: number;
  readonly kind: LivenessSignalKind;
}

/**
 * Canonical filename for the lane inside an attempt state directory. Kept
 * distinct from the firehose (`log.toonl`) and proof-of-life (`afk.state.toon`)
 * so nothing that writes those can refresh the lane by accident.
 *
 * The filename keeps its `.jsonl` suffix for compatibility, but the content is
 * now TOONL under the shared `red.castle.lane.v1` family — readers sniff by
 * content, not by extension. See {@link parseLivenessRecords}.
 */
export const LIVENESS_LANE_FILENAME = CASTLE_LANE_FILENAMES.liveness;

export interface LivenessLaneOptions {
  /** Absolute path to the lane file (append-only TOONL, one record per line). */
  readonly path: string;
  /**
   * Wall clock in epoch-ms. Injected so tests can drive recency with a fake
   * clock. Defaults to `Date.now`.
   */
  readonly clock?: () => number;
}

/**
 * The append-only writer for one attempt's liveness lane.
 *
 * The **only** way to refresh the lane is {@link LivenessLane.record}, which
 * accepts a `LivenessSignalKind` — a substrate control-flow signal. There is no
 * method that accepts agent output, so the substrate cannot be tricked into
 * refreshing the lane from relayed heartbeat/usage events.
 */
export class LivenessLane {
  readonly path: string;
  private readonly clock: () => number;
  constructor(options: LivenessLaneOptions) {
    this.path = options.path;
    this.clock = options.clock ?? (() => Date.now());
  }

  /**
   * Append one substrate control-flow signal to the lane. Returns the record
   * that was written. The lane directory is created lazily on first write.
   */
  async record(kind: LivenessSignalKind): Promise<LivenessRecord> {
    const record: LivenessRecord = { at: this.clock(), kind };
    await appendCastleLaneRecord(this.path, {
      at: new Date(record.at).toISOString(),
      kind: "worker.heartbeat",
      payload: { signal: kind },
    }, { retentionPolicy: LANE_RETENTION_REGISTRY["worker-liveness"] });
    return record;
  }
}

/**
 * Parse the lane body into records, skipping blank/corrupt lines rather than
 * throwing — a torn final write must not blind the evaluator.
 *
 * The lane is TOONL now, but files written before the upgrade are legacy JSONL,
 * and one file can even hold JSONL lines followed by a TOONL segment. So we
 * sniff **per line**: a line that `JSON.parse`s is a legacy JSONL record; a line
 * that does not (a TOONL schema header or a positional row) is buffered and
 * decoded as a TOONL segment by the library. Contiguous non-JSON lines form one
 * segment; a JSONL line (or end of input) flushes the pending segment so record
 * order is preserved.
 */
export function parseLivenessRecords(raw: string): LivenessRecord[] {
  const records: LivenessRecord[] = [];
  let toonlBuffer: string[] = [];

  const pushIfValid = (rec: Record<string, unknown>): void => {
    if (typeof rec.at === "number" && typeof rec.kind === "string") {
      records.push({ at: rec.at, kind: rec.kind as LivenessSignalKind });
      return;
    }
    if (typeof rec.at === "string" && rec.kind === "worker.heartbeat") {
      const payload =
        typeof rec.payload === "string"
          ? safeJsonObject(rec.payload)
          : rec.payload;
      if (
        payload &&
        typeof payload === "object" &&
        !Array.isArray(payload) &&
        typeof (payload as Record<string, unknown>).signal === "string"
      ) {
        const at = Date.parse(rec.at);
        if (Number.isFinite(at)) {
          records.push({
            at,
            kind: (payload as Record<string, unknown>)
              .signal as LivenessSignalKind,
          });
        }
      }
    }
  };

  const flushToonl = (): void => {
    if (toonlBuffer.length === 0) return;
    const block = toonlBuffer.join("\n");
    toonlBuffer = [];
    try {
      for (const rec of parseRecords(block)) pushIfValid(rec);
    } catch {
      // Skip a corrupt/partial TOONL segment — never let it hide healthy rows.
    }
  };

  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      // Not JSON → a TOONL header or positional row; defer to the TOONL decoder.
      toonlBuffer.push(trimmed);
      continue;
    }
    // A JSONL record interrupts any pending TOONL segment; decode it first.
    flushToonl();
    pushIfValid(parsed as Partial<LivenessRecord>);
  }
  flushToonl();
  return records;
}

function safeJsonObject(raw: string): Record<string, unknown> | undefined {
  try {
    const value = JSON.parse(raw) as unknown;
    if (value && typeof value === "object" && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

/** Read and parse every lane record. Returns `[]` when the lane file is absent. */
export async function readLivenessRecords(
  path: string,
): Promise<LivenessRecord[]> {
  try {
    const raw = await readFile(path, "utf-8");
    return parseLivenessRecords(raw);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
}

/**
 * The newest lane timestamp (max `at`), or `undefined` when the lane has no
 * records. Uses max rather than last-line so an out-of-order append can never
 * report a *stale* recency.
 */
export async function readLivenessRecency(
  path: string,
): Promise<number | undefined> {
  const records = await readLivenessRecords(path);
  if (records.length === 0) return undefined;
  return records.reduce((max, r) => (r.at > max ? r.at : max), records[0]!.at);
}

/**
 * The substrate integration seam. Consumers (a follow-up slice — this one adds
 * the API only) wire the substrate's control-flow boundaries to the lane and
 * route the agent's output stream to observability. The two paths are kept
 * separate on purpose: control-flow boundaries refresh the lane;
 * {@link LivenessTracker.observeAgentStreamEvent} forwards agent output to an
 * external sink and **never** touches the lane.
 */
export interface LivenessTracker {
  /** Substrate re-invoked the agent for a new iteration. */
  iterationStart(): Promise<LivenessRecord>;
  /** Substrate finished collecting one iteration's result. */
  iterationEnd(): Promise<LivenessRecord>;
  /** Substrate observed a tool invocation begin (tool-lifecycle callback). */
  toolStart(): Promise<LivenessRecord>;
  /** Substrate observed a tool invocation complete (tool-lifecycle callback). */
  toolEnd(): Promise<LivenessRecord>;
  /**
   * Forward an agent-emitted stream event to the external observability sink
   * only. This routes agent output (including relayed heartbeat/usage events)
   * **away** from the liveness lane — it does not and cannot refresh it.
   */
  observeAgentStreamEvent(event: AgentStreamEvent): void;
}

export interface LivenessTrackerOptions {
  readonly lane: LivenessLane;
  /**
   * Optional passthrough for agent stream events to an external observability
   * sink. Present so the split is explicit: agent output flows here, never to
   * the lane.
   */
  readonly onAgentStreamEvent?: (event: AgentStreamEvent) => void;
}

/** Build a {@link LivenessTracker} bound to a lane. */
export function createLivenessTracker(
  options: LivenessTrackerOptions,
): LivenessTracker {
  const { lane, onAgentStreamEvent } = options;
  return {
    iterationStart: () => lane.record("iteration-start"),
    iterationEnd: () => lane.record("iteration-end"),
    toolStart: () => lane.record("tool-start"),
    toolEnd: () => lane.record("tool-end"),
    observeAgentStreamEvent: (event) => {
      if (!onAgentStreamEvent) return;
      try {
        onAgentStreamEvent(event);
      } catch {
        // Swallow — a broken forwarder must not kill the run, and must never
        // fall through to the lane.
      }
    },
  };
}
