import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  SubscribeRequestSchema,
  UnsubscribeRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import {
  createCastleLaneWriters,
  createEnginePaths,
  createLaneFollower,
  listCastleLaneFiles,
  type EnginePaths,
} from "@reddb-io/worker/engine";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  LANE_EVENTS_RESOURCE_URI,
  registerLaneEventSubscription,
} from "../src/lane-subscription.js";

/** Minimal stand-in for the low-level MCP server the wiring drives. */
function fakeServer() {
  const handlers = new Map<unknown, (request: unknown) => unknown>();
  const capabilities: unknown[] = [];
  const updated: Array<{ uri: string }> = [];
  return {
    handlers,
    capabilities,
    updated,
    registerCapabilities(cap: unknown) {
      capabilities.push(cap);
    },
    setRequestHandler(schema: unknown, handler: (request: unknown) => unknown) {
      handlers.set(schema, handler);
    },
    async sendResourceUpdated(params: { uri: string }) {
      updated.push(params);
    },
  };
}

describe("lane event MCP subscription", () => {
  let dir: string;
  let paths: EnginePaths;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "lane-sub-"));
    paths = createEnginePaths(join(dir, ".red"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("declares the subscribe capability and lists the lane resource", async () => {
    const server = fakeServer();
    const handle = registerLaneEventSubscription(
      server,
      createLaneFollower({ list: () => listCastleLaneFiles(paths, ["worker"]) }),
    );

    expect(server.capabilities).toContainEqual({
      resources: { subscribe: true },
    });
    const list = (await server.handlers.get(ListResourcesRequestSchema)!(
      {},
    )) as { resources: Array<{ uri: string }> };
    expect(list.resources.map((r) => r.uri)).toContain(
      LANE_EVENTS_RESOURCE_URI,
    );
    expect(LANE_EVENTS_RESOURCE_URI).toBe("redskilled://lanes/events");
    handle.stop();
  });

  it("drives a resource-updated notification from a synthetic lane append", async () => {
    const server = fakeServer();
    const handle = registerLaneEventSubscription(
      server,
      createLaneFollower({ list: () => listCastleLaneFiles(paths, ["worker"]) }),
    );

    await server.handlers.get(SubscribeRequestSchema)!({
      params: { uri: LANE_EVENTS_RESOURCE_URI },
    });

    const writers = createCastleLaneWriters(paths, {
      clock: () => "2026-07-23T00:00:00.000Z",
    });
    await writers.worker("w1").append({
      kind: "worker.completed",
      worker_id: "w1",
      issue: 42,
    });
    await handle.poll();

    expect(server.updated).toContainEqual({ uri: LANE_EVENTS_RESOURCE_URI });

    const read = server.handlers.get(ReadResourceRequestSchema)!;
    const result = (await read({
      params: { uri: LANE_EVENTS_RESOURCE_URI },
    })) as { contents: Array<{ uri: string; text: string }> };
    expect(result.contents[0].uri).toBe(LANE_EVENTS_RESOURCE_URI);
    expect(result.contents[0].text).toContain("worker.completed");
    handle.stop();
  });

  it("stops delivering after unsubscribe", async () => {
    const server = fakeServer();
    const handle = registerLaneEventSubscription(
      server,
      createLaneFollower({ list: () => listCastleLaneFiles(paths, ["worker"]) }),
    );

    await server.handlers.get(SubscribeRequestSchema)!({
      params: { uri: LANE_EVENTS_RESOURCE_URI },
    });
    await server.handlers.get(UnsubscribeRequestSchema)!({
      params: { uri: LANE_EVENTS_RESOURCE_URI },
    });

    const writers = createCastleLaneWriters(paths, {
      clock: () => "2026-07-23T00:00:00.000Z",
    });
    await writers.worker("w1").append({
      kind: "worker.completed",
      worker_id: "w1",
      issue: 42,
    });
    await handle.poll();

    expect(server.updated).toHaveLength(0);
    handle.stop();
  });
});
