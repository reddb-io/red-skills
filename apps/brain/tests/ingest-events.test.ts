import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import type { ChannelBridge, ChannelBridgePollResult, ChannelEvent } from "@reddb-io/brain-store/channel-bridge.js";
import { ingestEvents } from "../src/ingest-events.js";
import { BrainStore } from "@reddb-io/brain-store/store.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function tempStore(): Promise<BrainStore> {
  const root = await mkdtemp(join(tmpdir(), "brain-ingest-"));
  roots.push(root);
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

describe("ingestEvents", () => {
  it("captures polled events as kind:event artifacts", async () => {
    const store = await tempStore();
    try {
      const events: ChannelEvent[] = [
        { id: "evt-1", platform: "slack", target: "#eng", message: "hello", type: "message", raw: {} },
        { id: "evt-2", platform: "slack", target: "#eng", message: "world", type: "message", raw: {} },
      ];
      const result = await ingestEvents({ bridge: fakeBridge(events), store });

      expect(result.polled).toBe(2);
      expect(result.captured).toBe(2);
      expect(result.skipped).toBe(0);

      const all = await store.listArtifacts();
      const eventArtifacts = all.filter((a) => a.kind === "event");
      expect(eventArtifacts.length).toBe(2);
    } finally {
      await store.close();
    }
  });

  it("does not create duplicates when re-polling identical events", async () => {
    const store = await tempStore();
    try {
      const events: ChannelEvent[] = [
        { id: "evt-1", platform: "slack", target: "#eng", message: "release train is green", raw: {} },
      ];

      const first = await ingestEvents({ bridge: fakeBridge(events), store });
      expect(first.captured).toBe(1);
      expect(first.skipped).toBe(0);

      const second = await ingestEvents({ bridge: fakeBridge(events), store });
      expect(second.captured).toBe(0);
      expect(second.skipped).toBe(1);

      const all = await store.listArtifacts();
      const eventArtifacts = all.filter((a) => a.kind === "event");
      expect(eventArtifacts.length).toBe(1);
    } finally {
      await store.close();
    }
  });

  it("stores hermes as sourceRunner and the provided sourceAgent", async () => {
    const store = await tempStore();
    try {
      const events: ChannelEvent[] = [
        { id: "evt-x", platform: "discord", message: "ping", raw: {} },
      ];
      await ingestEvents({ bridge: fakeBridge(events), store, sourceAgent: "test-agent" });

      const all = await store.listArtifacts();
      const artifact = all.find((a) => a.kind === "event");
      expect(artifact?.properties.source_runner).toBe("hermes");
      expect(artifact?.properties.source_agent).toBe("test-agent");
    } finally {
      await store.close();
    }
  });

  it("returns nextCursor from the poll result", async () => {
    const store = await tempStore();
    try {
      const result = await ingestEvents({ bridge: fakeBridge([], 99), store });
      expect(result.nextCursor).toBe(99);
      expect(result.polled).toBe(0);
    } finally {
      await store.close();
    }
  });

  it("passes afterCursor and sessionKey to the bridge poll", async () => {
    const store = await tempStore();
    let capturedPollInput: { afterCursor?: number | string; sessionKey?: string } | undefined;
    const bridge: ChannelBridge = {
      async poll(input) {
        capturedPollInput = { afterCursor: input?.afterCursor, sessionKey: input?.sessionKey };
        return { events: [], raw: {} };
      },
      async send() { return { ok: true, target: "", raw: {} }; },
      async channels() { return { channels: [], raw: {} }; },
      async close() {},
    };
    try {
      await ingestEvents({ bridge, store, afterCursor: 42, sessionKey: "slack:eng" });
      expect(capturedPollInput).toEqual({ afterCursor: 42, sessionKey: "slack:eng" });
    } finally {
      await store.close();
    }
  });

  it("handles an empty poll result without error", async () => {
    const store = await tempStore();
    try {
      const result = await ingestEvents({ bridge: fakeBridge([]), store });
      expect(result.polled).toBe(0);
      expect(result.captured).toBe(0);
      expect(result.skipped).toBe(0);
      expect(result.nextCursor).toBeUndefined();
    } finally {
      await store.close();
    }
  });

  it("stores event provenance metadata on each artifact", async () => {
    const store = await tempStore();
    try {
      const events: ChannelEvent[] = [
        {
          id: "evt-meta",
          cursor: 7,
          type: "message",
          platform: "slack",
          target: "#general",
          sessionKey: "slack:general",
          timestamp: "2026-06-10T09:00:00.000Z",
          message: "hello from ingest",
          raw: {},
        },
      ];
      await ingestEvents({ bridge: fakeBridge(events), store });

      const all = await store.listArtifacts();
      const artifact = all.find((a) => a.kind === "event");
      expect(artifact?.properties.metadata).toMatchObject({
        event_key: "evt:evt-meta",
        event_id: "evt-meta",
        cursor: 7,
        timestamp: "2026-06-10T09:00:00.000Z",
        platform: "slack",
        target: "#general",
        session_key: "slack:general",
        event_type: "message",
      });
    } finally {
      await store.close();
    }
  });
});
