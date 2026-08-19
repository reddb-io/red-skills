import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { decode } from "@reddb-io/toon";
import { afterEach, describe, expect, it } from "vitest";
import type { ChannelBridge, ChannelBridgePollResult, ChannelEvent } from "@reddb-io/brain-store/channel-bridge.js";
import {
  loadIngestionState,
  saveIngestionState,
  scheduledIngest,
  type IngestionState,
} from "../src/scheduled-ingestion.js";
import { BrainStore } from "@reddb-io/brain-store/store.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function tempDir(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "brain-sched-"));
  roots.push(root);
  return root;
}

async function tempStore(root: string): Promise<BrainStore> {
  return BrainStore.open({ uri: `file://${join(root, "brain.rdb")}` });
}

function fakeBridge(events: ChannelEvent[], nextCursor?: number | string): ChannelBridge {
  return {
    async poll(): Promise<ChannelBridgePollResult> {
      return { events, nextCursor, raw: {} };
    },
    async send() {
      return { ok: true, target: "", raw: {} };
    },
    async channels() {
      return { channels: [], raw: {} };
    },
    async close() {},
  };
}

describe("scheduledIngest", () => {
  it("advances cursor to nextCursor from the bridge poll", async () => {
    const root = await tempDir();
    const store = await tempStore(root);
    try {
      const result = await scheduledIngest({
        bridge: fakeBridge([], 42),
        store,
        state: {},
      });
      expect(result.state.cursor).toBe(42);
    } finally {
      await store.close();
    }
  });

  it("passes saved cursor as afterCursor on successive runs", async () => {
    const root = await tempDir();
    const store = await tempStore(root);
    const capturedCursors: Array<number | string | undefined> = [];
    const bridge: ChannelBridge = {
      async poll(input) {
        capturedCursors.push(input?.afterCursor);
        return { events: [], nextCursor: (input?.afterCursor ?? 0) as number + 10, raw: {} };
      },
      async send() { return { ok: true, target: "", raw: {} }; },
      async channels() { return { channels: [], raw: {} }; },
      async close() {},
    };
    try {
      const first = await scheduledIngest({ bridge, store, state: {} });
      expect(capturedCursors[0]).toBeUndefined();
      expect(first.state.cursor).toBe(10);

      const second = await scheduledIngest({ bridge, store, state: first.state });
      expect(capturedCursors[1]).toBe(10);
      expect(second.state.cursor).toBe(20);
    } finally {
      await store.close();
    }
  });

  it("retains cursor when nextCursor is absent from the bridge", async () => {
    const root = await tempDir();
    const store = await tempStore(root);
    try {
      const first = await scheduledIngest({ bridge: fakeBridge([], 77), store, state: {} });
      expect(first.state.cursor).toBe(77);

      const second = await scheduledIngest({ bridge: fakeBridge([]), store, state: first.state });
      expect(second.state.cursor).toBe(77);
    } finally {
      await store.close();
    }
  });

  it("captures events and deduplicates across runs", async () => {
    const root = await tempDir();
    const store = await tempStore(root);
    try {
      const events: ChannelEvent[] = [
        { id: "evt-1", platform: "slack", target: "#eng", message: "hello", raw: {} },
      ];

      const first = await scheduledIngest({ bridge: fakeBridge(events), store, state: {} });
      expect(first.captured).toBe(1);
      expect(first.skipped).toBe(0);

      const second = await scheduledIngest({ bridge: fakeBridge(events), store, state: first.state });
      expect(second.captured).toBe(0);
      expect(second.skipped).toBe(1);
    } finally {
      await store.close();
    }
  });

  it("records lastRunAt on each run", async () => {
    const root = await tempDir();
    const store = await tempStore(root);
    try {
      const result = await scheduledIngest({ bridge: fakeBridge([]), store, state: {} });
      expect(result.state.lastRunAt).toBeDefined();
      expect(typeof result.state.lastRunAt).toBe("string");
    } finally {
      await store.close();
    }
  });
});

describe("loadIngestionState / saveIngestionState", () => {
  it("returns empty state when file does not exist", async () => {
    const root = await tempDir();
    const state = await loadIngestionState(join(root, "missing.json"));
    expect(state).toEqual({});
  });

  it("round-trips a state through save and load", async () => {
    const root = await tempDir();
    const path = join(root, "state.json");
    const saved: IngestionState = { cursor: 123, lastRunAt: "2026-06-10T00:00:00.000Z" };
    await saveIngestionState(path, saved);
    expect(decode(await readFile(path, "utf8"))).toEqual(saved);
    const loaded = await loadIngestionState(path);
    expect(loaded).toEqual(saved);
  });

  it("loads legacy JSON state files", async () => {
    const root = await tempDir();
    const path = join(root, "state.json");
    const saved: IngestionState = { cursor: "legacy", lastRunAt: "2026-06-10T00:00:00.000Z" };
    await writeFile(path, JSON.stringify(saved), "utf8");

    await expect(loadIngestionState(path)).resolves.toEqual(saved);
  });

  it("creates missing parent directories on save", async () => {
    const root = await tempDir();
    const path = join(root, "deep", "nested", "state.json");
    await saveIngestionState(path, { cursor: 1 });
    const loaded = await loadIngestionState(path);
    expect(loaded.cursor).toBe(1);
  });

  it("overwrites existing state on successive saves", async () => {
    const root = await tempDir();
    const path = join(root, "state.json");
    await saveIngestionState(path, { cursor: 10 });
    await saveIngestionState(path, { cursor: 20 });
    const loaded = await loadIngestionState(path);
    expect(loaded.cursor).toBe(20);
  });
});
