import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, afterEach } from "vitest";
import {
  appendCastleHistoryRecord,
  createEnginePaths,
} from "@reddb-io/red-castle/engine";
import { createCastleMcpDependencies } from "../src/mcp-adapter.js";
import { createCastleMcpTools } from "@reddb-io/red-castle/mcp-server";

let tempRoot: string | undefined;

async function makeRoot(): Promise<string> {
  tempRoot = await mkdtemp(join(tmpdir(), "events-since-test-"));
  await mkdir(join(tempRoot, ".red", "state", "castle"), { recursive: true });
  await mkdir(join(tempRoot, ".red", "tmp", "workers"), { recursive: true });
  return tempRoot;
}

afterEach(async () => {
  if (tempRoot) {
    await rm(tempRoot, { recursive: true, force: true });
    tempRoot = undefined;
  }
});

/** Encode a cursor the same way the implementation does. */
function encodeCursor(at: string): string {
  return Buffer.from(JSON.stringify({ v: 1, at })).toString("base64url");
}

describe("events_since tool", () => {
  it("returns a baseline cursor and no events when cursor is omitted", async () => {
    const root = await makeRoot();
    const deps = createCastleMcpDependencies(root);
    const tools = createCastleMcpTools(deps);
    const tool = tools.find((t) => t.name === "events_since")!;

    const result = await tool.invoke({}) as Record<string, unknown>;

    expect(result).toMatchObject({
      history: [],
      lane_records: [],
      cursor: expect.any(String),
    });
    expect(typeof result.cursor).toBe("string");
    expect((result.cursor as string).length).toBeGreaterThan(0);
  });

  it("returns a terse refusal for an unknown cursor, not a full dump", async () => {
    const root = await makeRoot();
    const deps = createCastleMcpDependencies(root);
    const tools = createCastleMcpTools(deps);
    const tool = tools.find((t) => t.name === "events_since")!;

    const result = await tool.invoke({ cursor: "not-a-valid-base64url-cursor" }) as Record<string, unknown>;

    expect(result.refused).toBe(true);
    expect(result).toMatchObject({
      reason:
        "Unknown cursor format; repair: call `events_since` with `{}` because re-baseline with a fresh cursor",
      repair: {
        tool: "events_since",
        args: {},
        why: "re-baseline with a fresh cursor",
      },
    });
    expect(result).not.toHaveProperty("history");
    expect(result).not.toHaveProperty("lane_records");
  });

  it("returns a terse refusal for a validly-encoded but unknown-version cursor", async () => {
    const root = await makeRoot();
    const deps = createCastleMcpDependencies(root);
    const tools = createCastleMcpTools(deps);
    const tool = tools.find((t) => t.name === "events_since")!;

    const badCursor = Buffer.from(JSON.stringify({ v: 99, at: "2026-07-22T00:00:00.000Z" })).toString("base64url");
    const result = await tool.invoke({ cursor: badCursor }) as Record<string, unknown>;

    expect(result.refused).toBe(true);
    expect(result.reason as string).toContain("re-baseline");
  });

  it("returns a terse refusal for an expired cursor (> 7 days old)", async () => {
    const root = await makeRoot();
    const deps = createCastleMcpDependencies(root);
    const tools = createCastleMcpTools(deps);
    const tool = tools.find((t) => t.name === "events_since")!;

    const oldAt = new Date(Date.now() - 8 * 24 * 60 * 60 * 1_000).toISOString();
    const expiredCursor = encodeCursor(oldAt);
    const result = await tool.invoke({ cursor: expiredCursor }) as Record<string, unknown>;

    expect(result.refused).toBe(true);
    expect(result.reason as string).toContain("re-baseline");
  });

  it("returns only records after the cursor and a monotonically advancing next cursor", async () => {
    const root = await makeRoot();

    const past = new Date(Date.now() - 5_000).toISOString();
    const recent = new Date().toISOString();

    const paths = createEnginePaths(join(root, ".red"));
    await appendCastleHistoryRecord(paths.castleHistory, {
      ts: past,
      epoch: 1,
      worker: "w1",
      issue: 1,
      event: "done",
      duration_s: 10,
      runner: "claude",
    });
    await appendCastleHistoryRecord(paths.castleHistory, {
      ts: recent,
      epoch: 2,
      worker: "w2",
      issue: 2,
      event: "done",
      duration_s: 5,
      runner: "claude",
    });

    // Cursor points to between the two records
    const between = new Date(Date.now() - 2_500).toISOString();
    const cursor = encodeCursor(between);

    const deps = createCastleMcpDependencies(root);
    const tools = createCastleMcpTools(deps);
    const tool = tools.find((t) => t.name === "events_since")!;

    const result = await tool.invoke({ cursor }) as {
      refused?: boolean;
      history: Array<{ ts: string; issue: number }>;
      lane_records: unknown[];
      cursor: string;
    };

    expect(result.refused).toBeUndefined();
    expect(result.history).toHaveLength(1);
    expect(result.history[0]!.issue).toBe(2);
    expect(result.lane_records).toEqual([]);

    // Next cursor is a valid base64url-encoded JSON with v=1 and at >= between
    const decoded = JSON.parse(Buffer.from(result.cursor, "base64url").toString("utf8"));
    expect(decoded.v).toBe(1);
    expect(decoded.at >= between).toBe(true);
  });

  it("cursor is restart-stable: same cursor works on a new deps instance", async () => {
    const root = await makeRoot();
    const cursor = encodeCursor(new Date(Date.now() - 1_000).toISOString());

    const deps1 = createCastleMcpDependencies(root);
    const tools1 = createCastleMcpTools(deps1);
    const r1 = await tools1.find((t) => t.name === "events_since")!.invoke({ cursor }) as Record<string, unknown>;
    expect(r1.refused).toBeUndefined();

    const deps2 = createCastleMcpDependencies(root);
    const tools2 = createCastleMcpTools(deps2);
    const r2 = await tools2.find((t) => t.name === "events_since")!.invoke({ cursor }) as Record<string, unknown>;
    expect(r2.refused).toBeUndefined();
  });

  it("next cursor is monotonically advancing across two calls", async () => {
    const root = await makeRoot();
    const deps = createCastleMcpDependencies(root);
    const tools = createCastleMcpTools(deps);
    const tool = tools.find((t) => t.name === "events_since")!;

    const r1 = await tool.invoke({}) as { cursor: string };
    const r2 = await tool.invoke({ cursor: r1.cursor }) as { cursor: string };

    const d1 = JSON.parse(Buffer.from(r1.cursor, "base64url").toString("utf8"));
    const d2 = JSON.parse(Buffer.from(r2.cursor, "base64url").toString("utf8"));
    expect(d2.at >= d1.at).toBe(true);
  });
});
