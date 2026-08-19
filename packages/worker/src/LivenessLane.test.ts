import { existsSync } from "node:fs";
import { appendFile, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseRecords } from "@reddb-io/toon";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentStreamEvent } from "./AgentStreamEmitter.js";
import {
  createLivenessTracker,
  LivenessLane,
  LIVENESS_LANE_FILENAME,
  parseLivenessRecords,
  readLivenessRecency,
  readLivenessRecords,
  type LivenessSignalKind,
} from "./LivenessLane.js";

const makeTmpDir = async (): Promise<string> => {
  const dir = join(
    tmpdir(),
    `liveness-lane-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  await mkdir(dir, { recursive: true });
  return dir;
};

describe("LivenessLane.record", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await makeTmpDir();
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("appends one record per substrate signal, timestamped by the injected clock", async () => {
    let t = 1000;
    const path = join(dir, LIVENESS_LANE_FILENAME);
    const lane = new LivenessLane({ path, clock: () => t });

    await lane.record("iteration-start");
    t = 2000;
    await lane.record("tool-start");
    t = 3000;
    await lane.record("tool-end");

    const records = await readLivenessRecords(path);
    expect(records).toEqual([
      { at: 1000, kind: "iteration-start" },
      { at: 2000, kind: "tool-start" },
      { at: 3000, kind: "tool-end" },
    ]);
  });

  it("emits TOONL on the wire: one schema header then one positional row per record", async () => {
    let t = 1000;
    const path = join(dir, LIVENESS_LANE_FILENAME);
    const lane = new LivenessLane({ path, clock: () => t });

    await lane.record("iteration-start");
    t = 2000;
    await lane.record("tool-start");

    const raw = await readFile(path, "utf-8");
    const lines = raw.split("\n").filter((l) => l.length > 0);
    // A leading TOONL schema header, not a JSON object per line.
    expect(lines[0]).toBe("[]{at,kind,payload}:");
    expect(() => JSON.parse(lines[0]!)).toThrow();
    expect(lines[1]).toContain("worker.heartbeat");
    expect(lines[1]).toContain("iteration-start");
    expect(lines[3]).toContain("tool-start");

    // The library round-trips the whole lane back to the shared castle family.
    expect(parseRecords(raw)).toEqual([
      {
        at: "1970-01-01T00:00:01.000Z",
        kind: "worker.heartbeat",
        payload: '{"signal":"iteration-start"}',
      },
      {
        at: "1970-01-01T00:00:02.000Z",
        kind: "worker.heartbeat",
        payload: '{"signal":"tool-start"}',
      },
    ]);
    expect(await readLivenessRecords(path)).toEqual([
      { at: 1000, kind: "iteration-start" },
      { at: 2000, kind: "tool-start" },
    ]);
  });

  it("reads a legacy JSONL line still present in the same lane file (sniffing reader)", async () => {
    const path = join(dir, LIVENESS_LANE_FILENAME);
    // A file written by the pre-upgrade JSONL writer, then appended to by the
    // new TOONL writer — the sniffing reader must recover both.
    await appendFile(
      path,
      JSON.stringify({ at: 1, kind: "iteration-start" }) + "\n",
    );
    const lane = new LivenessLane({ path, clock: () => 2 });
    await lane.record("tool-start");

    expect(await readLivenessRecords(path)).toEqual([
      { at: 1, kind: "iteration-start" },
      { at: 2, kind: "tool-start" },
    ]);
    expect(await readLivenessRecency(path)).toBe(2);
  });

  it("creates the lane directory lazily on first write", async () => {
    const nested = join(dir, "a", "b", "c");
    const path = join(nested, LIVENESS_LANE_FILENAME);
    expect(existsSync(nested)).toBe(false);
    const lane = new LivenessLane({ path, clock: () => 42 });
    await lane.record("iteration-start");
    expect(existsSync(path)).toBe(true);
  });

  it("readLivenessRecency returns the newest (max) timestamp, undefined when empty", async () => {
    const path = join(dir, LIVENESS_LANE_FILENAME);
    expect(await readLivenessRecency(path)).toBeUndefined();

    let t = 500;
    const lane = new LivenessLane({ path, clock: () => t });
    await lane.record("iteration-start");
    t = 900;
    await lane.record("iteration-end");
    expect(await readLivenessRecency(path)).toBe(900);
  });
});

describe("parseLivenessRecords", () => {
  it("skips blank and corrupt lines without dropping healthy records", () => {
    const raw = [
      JSON.stringify({ at: 1, kind: "iteration-start" }),
      "",
      "{not json",
      JSON.stringify({ at: 2 }), // missing kind
      JSON.stringify({ at: 3, kind: "tool-end" }),
    ].join("\n");
    expect(parseLivenessRecords(raw)).toEqual([
      { at: 1, kind: "iteration-start" },
      { at: 3, kind: "tool-end" },
    ]);
  });

  it("decodes a TOONL segment and preserves order across legacy JSONL lines", () => {
    const raw = [
      JSON.stringify({ at: 1, kind: "iteration-start" }), // legacy JSONL
      "[]{at,kind}:", // TOONL schema header
      "2,tool-start", // TOONL positional rows
      "3,tool-end",
    ].join("\n");
    expect(parseLivenessRecords(raw)).toEqual([
      { at: 1, kind: "iteration-start" },
      { at: 2, kind: "tool-start" },
      { at: 3, kind: "tool-end" },
    ]);
  });
});

describe("liveness lane is un-poisonable by agent output", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await makeTmpDir();
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  // The full spectrum of agent-emitted / relayed stream events, including the
  // usage/reasoning events that are the "relayed heartbeat" poisoning vector.
  const agentEvents: AgentStreamEvent[] = [
    { type: "text", message: "hi", iteration: 1, timestamp: new Date(0) },
    {
      type: "toolCall",
      name: "Bash",
      formattedArgs: "ls",
      iteration: 1,
      timestamp: new Date(0),
    },
    { type: "raw", line: "{}", iteration: 1, timestamp: new Date(0) },
    { type: "result", result: "done", iteration: 1, timestamp: new Date(0) },
    {
      type: "reasoning",
      message: "thinking",
      tokens: 10,
      iteration: 1,
      timestamp: new Date(0),
    },
    {
      type: "usage",
      inputTokens: 1,
      outputTokens: 2,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      iteration: 1,
      timestamp: new Date(0),
    },
  ];

  it("routing every agent stream event through the tracker never writes the lane; only substrate boundaries do", async () => {
    const path = join(dir, LIVENESS_LANE_FILENAME);
    let t = 100;
    const lane = new LivenessLane({ path, clock: () => t });

    const forwarded: AgentStreamEvent[] = [];
    const tracker = createLivenessTracker({
      lane,
      onAgentStreamEvent: (e) => forwarded.push(e),
    });

    // Relay every agent event. The lane file must not even exist afterwards —
    // agent output has no path to the lane.
    for (const event of agentEvents) tracker.observeAgentStreamEvent(event);
    expect(forwarded).toHaveLength(agentEvents.length); // it did reach observability
    expect(existsSync(path)).toBe(false);
    expect(await readLivenessRecency(path)).toBeUndefined();

    // Only a substrate control-flow boundary refreshes the lane.
    t = 200;
    await tracker.iterationStart();
    const afterBoundary = await readLivenessRecency(path);
    expect(afterBoundary).toBe(200);

    // More agent events after the boundary still cannot advance recency.
    t = 999;
    for (const event of agentEvents) tracker.observeAgentStreamEvent(event);
    expect(await readLivenessRecency(path)).toBe(200);
  });

  it("a broken observability sink cannot fall through to the lane", async () => {
    const path = join(dir, LIVENESS_LANE_FILENAME);
    const lane = new LivenessLane({ path, clock: () => 1 });
    const tracker = createLivenessTracker({
      lane,
      onAgentStreamEvent: () => {
        throw new Error("sink blew up");
      },
    });
    expect(() =>
      tracker.observeAgentStreamEvent({
        type: "usage",
        inputTokens: 0,
        outputTokens: 0,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
        iteration: 1,
        timestamp: new Date(0),
      }),
    ).not.toThrow();
    expect(existsSync(path)).toBe(false);
  });

  it("the lane signal kinds are disjoint from agent stream event types", () => {
    const laneKinds: LivenessSignalKind[] = [
      "iteration-start",
      "iteration-end",
      "tool-start",
      "tool-end",
    ];
    const agentTypes = new Set(agentEvents.map((e) => e.type));
    for (const kind of laneKinds) {
      expect(agentTypes.has(kind as unknown as AgentStreamEvent["type"])).toBe(
        false,
      );
    }
  });
});
