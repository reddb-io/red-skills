import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { decode, type JsonValue } from "@reddb-io/toon";
import { encodeSnapshotToon } from "@reddb-io/shared/toon-migration.js";
import type { ChannelBridge } from "@reddb-io/brain-store/channel-bridge.js";
import { ingestEvents } from "./ingest-events.js";
import type { BrainStoreLike } from "@reddb-io/brain-store/store.js";

export interface IngestionState {
  cursor?: number | string;
  lastRunAt?: string;
}

export interface ScheduledIngestInput {
  bridge: ChannelBridge;
  store: BrainStoreLike;
  state: IngestionState;
  sessionKey?: string;
  limit?: number;
  sourceAgent?: string;
}

export interface ScheduledIngestResult {
  polled: number;
  captured: number;
  skipped: number;
  state: IngestionState;
}

export async function scheduledIngest(input: ScheduledIngestInput): Promise<ScheduledIngestResult> {
  const result = await ingestEvents({
    bridge: input.bridge,
    store: input.store,
    afterCursor: input.state.cursor,
    sessionKey: input.sessionKey,
    limit: input.limit,
    sourceAgent: input.sourceAgent,
  });

  const nextState: IngestionState = {
    cursor: result.nextCursor ?? input.state.cursor,
    lastRunAt: new Date().toISOString(),
  };

  return {
    polled: result.polled,
    captured: result.captured,
    skipped: result.skipped,
    state: nextState,
  };
}

export async function loadIngestionState(path: string): Promise<IngestionState> {
  try {
    const text = await readFile(path, "utf8");
    const body = text.trim();
    if (!body) return {};
    try {
      return JSON.parse(body) as IngestionState;
    } catch {
      return decode(body) as IngestionState;
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw err;
  }
}

export async function saveIngestionState(path: string, state: IngestionState): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${encodeSnapshotToon(state as unknown as JsonValue)}\n`, "utf8");
}
