import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeToonlLines, parseRecords } from "@reddb-io/toon";

type ToonlRecord = Record<string, string | number | boolean | null>;
import { afterEach, describe, expect, it } from "vitest";
import {
  LANE_RETENTION_REGISTRY,
  laneOverCeiling,
  laneOverCeilingSync,
  sweepLaneTemps,
  trimLaneKeepLast,
  type LaneRetentionStat,
  type LaneRetentionStatSync,
} from "./lane-retention.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function encodedLane(ids: readonly string[]): string {
  const writer = encodeToonlLines({ trailer: false });
  return ids.map((id, index) => writer.push({ id, ordinal: index } satisfies ToonlRecord)).join("");
}

describe("shared lane retention", () => {
  it("declares the state-tier lane policies with the amortized half-full target", () => {
    expect(LANE_RETENTION_REGISTRY["process-deaths"]).toEqual({
      maxBytes: 4 * 1024 * 1024,
      maxAgeMs: 14 * 24 * 60 * 60 * 1_000,
      targetRatio: 0.5,
    });
    expect(LANE_RETENTION_REGISTRY["github-spend"].maxBytes).toBe(8 * 1024 * 1024);
    expect(LANE_RETENTION_REGISTRY["github-balance"].maxBytes).toBe(64 * 1024);
    expect(LANE_RETENTION_REGISTRY["github-balance-history"].maxBytes).toBe(2 * 1024 * 1024);
    expect(LANE_RETENTION_REGISTRY["castle-singleton-events"].maxBytes).toBe(2 * 1024 * 1024);
    expect(LANE_RETENTION_REGISTRY["rsp-telemetry-corrections"].maxBytes).toBe(1024 * 1024);
    expect(LANE_RETENTION_REGISTRY["death-attributions"].maxAgeMs).toBe(14 * 24 * 60 * 60 * 1_000);
    expect(LANE_RETENTION_REGISTRY["worker-log"].maxLines).toBe(50_000);
    expect(LANE_RETENTION_REGISTRY["worker-liveness"].maxBytes).toBe(1024 * 1024);
  });

  it("checks an append ceiling with exactly one stat in async and exit-handler paths", async () => {
    let asyncStats = 0;
    const asyncStat: LaneRetentionStat = async () => {
      asyncStats += 1;
      return { size: 90 };
    };
    expect(await laneOverCeiling("lane.toonl", 11, { maxBytes: 100 }, asyncStat)).toBe(true);
    expect(asyncStats).toBe(1);

    let syncStats = 0;
    const syncStat: LaneRetentionStatSync = () => {
      syncStats += 1;
      return { size: 90 };
    };
    expect(laneOverCeilingSync("lane.toonl", 10, { maxBytes: 100 }, syncStat)).toBe(false);
    expect(syncStats).toBe(1);
  });

  it("keeps a tq-trimmed lane decodable with its header intact when tq is present", async () => {
    if (spawnSync("tq", ["--version"], { stdio: "ignore" }).status !== 0) return;
    const root = await mkdtemp(join(tmpdir(), "lane-retention-tq-"));
    roots.push(root);
    const lane = join(root, "events.toonl");
    await writeFile(lane, encodedLane(["one", "two", "three"]), "utf8");

    expect(await trimLaneKeepLast(lane, 2)).toBe("tq");

    const raw = await readFile(lane, "utf8");
    expect(raw.startsWith("[]")).toBe(true);
    expect(parseRecords(raw).map((row) => row.id)).toEqual(["two", "three"]);
  });

  it("falls back to JS and keeps the replacement lane decodable with its header intact", async () => {
    const root = await mkdtemp(join(tmpdir(), "lane-retention-js-"));
    roots.push(root);
    const lane = join(root, "events.toonl");
    await writeFile(lane, encodedLane(["one", "two", "three"]), "utf8");

    expect(await trimLaneKeepLast(lane, 2, { runTq: async () => false })).toBe("js");

    const raw = await readFile(lane, "utf8");
    expect(raw.startsWith("[]")).toBe(true);
    expect(parseRecords(raw).map((row) => row.id)).toEqual(["two", "three"]);
  });

  it("sweeps only rotate, retaining, and rsp drain temps owned by dead pids", async () => {
    const root = await mkdtemp(join(tmpdir(), "lane-retention-sweep-"));
    roots.push(root);
    const liveRotate = join(root, "host.toonl.rotate-222");
    const deadRotate = join(root, "host.toonl.rotate-111");
    const deadRetaining = join(root, "deaths.toonl.retaining-111");
    const deadDrain = join(root, "rsp-telemetry.spool.toonl.111.1783958744462.drain");
    const liveDrain = join(root, "rsp-telemetry.spool.toonl.222.1783958744463.drain");
    const unrelated = join(root, "notes.tmp-111");
    await Promise.all([
      writeFile(liveRotate, "live"),
      writeFile(deadRotate, "dead"),
      writeFile(deadRetaining, "dead"),
      writeFile(deadDrain, "dead"),
      writeFile(liveDrain, "live"),
      writeFile(unrelated, "not a lane temp"),
    ]);

    const result = await sweepLaneTemps(root, { isPidAlive: (pid) => pid === 222 });

    expect(result.removed.sort()).toEqual([deadDrain, deadRetaining, deadRotate].sort());
    expect(result.preserved.sort()).toEqual([liveDrain, liveRotate].sort());
    await expect(readFile(liveRotate, "utf8")).resolves.toBe("live");
    await expect(readFile(liveDrain, "utf8")).resolves.toBe("live");
    await expect(readFile(unrelated, "utf8")).resolves.toBe("not a lane temp");
  });
});
