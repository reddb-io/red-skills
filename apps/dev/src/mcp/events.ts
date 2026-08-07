// The event lane cursor and its bounded since-reads.
import { join } from "node:path";
import {
  composeRepair,
  type RepairAction,
} from "@reddb-io/shared/repair.js";
import {
  castleLanePath,
  createEnginePaths,
  readCastleHistoryRecords,
  readCastleLaneRecords,
  type CastleLaneRecord,
} from "@reddb-io/red-castle/engine";
import type {
  EventsSinceInput,
} from "@reddb-io/red-castle/mcp-server";


const CURSOR_VERSION = 1;
const CURSOR_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1_000;

function encodeCursor(at: string): string {
  return Buffer.from(JSON.stringify({ v: CURSOR_VERSION, at })).toString(
    "base64url",
  );
}

interface CursorRefusal {
  refused: true;
  reason: string;
  repair: RepairAction;
}

function cursorRefusal(state: string): CursorRefusal {
  const composed = composeRepair({
    state,
    repair: {
      tool: "events_since",
      args: {},
      why: "re-baseline with a fresh cursor",
    },
  });
  if (composed.repair === "none") throw new Error("invalid cursor refusal repair");
  return { refused: true, reason: composed.prose, repair: composed.repair };
}

function decodeCursor(cursor: string): { at: string } | CursorRefusal {
  let raw: unknown;
  try {
    raw = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    return cursorRefusal("Unknown cursor format");
  }
  if (
    raw === null ||
    typeof raw !== "object" ||
    Array.isArray(raw) ||
    (raw as Record<string, unknown>).v !== CURSOR_VERSION ||
    typeof (raw as Record<string, unknown>).at !== "string"
  ) {
    return cursorRefusal("Unknown cursor format");
  }
  const at = (raw as Record<string, unknown>).at as string;
  const atMs = Date.parse(at);
  if (!Number.isFinite(atMs) || Date.now() - atMs > CURSOR_MAX_AGE_MS) {
    return cursorRefusal("Cursor expired");
  }
  return { at };
}

async function readAllWorkerLaneRecordsSince(
  paths: ReturnType<typeof createEnginePaths>,
  since: string,
): Promise<CastleLaneRecord[]> {
  const { readdir } = await import("node:fs/promises");
  let ids: string[];
  try {
    ids = (await readdir(paths.workersRoot, { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return [];
  }
  const records: CastleLaneRecord[] = [];
  for (const id of ids) {
    const lanePath = castleLanePath(paths, "worker", id);
    const workerRecords = await readCastleLaneRecords(lanePath);
    records.push(...workerRecords.filter((r) => r.at >= since));
  }
  return records;
}

export async function eventsSinceImpl(
  root: string,
  input: EventsSinceInput,
): Promise<unknown> {
  if (input.cursor === undefined) {
    return { history: [], lane_records: [], cursor: encodeCursor(new Date().toISOString()) };
  }
  const decoded = decodeCursor(input.cursor);
  if ("refused" in decoded) return decoded;

  const { at: since } = decoded;
  const paths = createEnginePaths(join(root, ".red"));
  const [historyRecords, laneRecords] = await Promise.all([
    readCastleHistoryRecords(paths.castleHistory),
    readAllWorkerLaneRecordsSince(paths, since),
  ]);

  return {
    history: historyRecords.filter((r) => r.ts >= since),
    lane_records: laneRecords,
    cursor: encodeCursor(new Date().toISOString()),
  };
}

/**
 * Wrap the GitHub-backed read deps with a short-TTL cache. Repeated calls
 * within the TTL cost zero GitHub requests. Mutating tools invalidate the
 * affected keys so the next read reflects the new state immediately.
 *
 * Exported for unit-testing the cache wiring with fake deps.
 */
