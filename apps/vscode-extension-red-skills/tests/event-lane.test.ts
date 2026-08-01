import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRedskilledEventLane } from "@reddb-io/redskilled/event-lane";
import { readEventLane, spliceWindow } from "../src/redskilled/event-lane.js";
import { tailFile } from "../src/redskilled/log-tail.js";

let dir = "";

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "rsk-lane-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function birth(id: string, ts: string) {
  return {
    event: "worker-birth" as const,
    ts,
    worker: {
      worker_id: id,
      project_label: "reddb-io/red-skills",
      pid: 100,
      started_at: ts,
      workspace_path: `/workspaces/${id}`,
      isolated: true,
      unit: `redskilled-${id}.service`,
      warnings: [],
    },
  };
}

describe("the host event lane", () => {
  it("decodes the TOONL the daemon actually writes", async () => {
    const path = join(dir, "redskilled.events.toonl");
    const lane = createRedskilledEventLane(path);
    await lane.record(birth("wAAAA", "2026-08-01T09:00:00.000Z"));
    await lane.record({
      event: "worker-budget-kill",
      ts: "2026-08-01T09:05:00.000Z",
      detail: "tree RSS 2.4G over the declared MemoryMax of 2G",
      worker: {
        worker_id: "wAAAA",
        project_label: "reddb-io/red-skills",
        pid: 100,
        started_at: "2026-08-01T09:00:00.000Z",
        workspace_path: "/workspaces/wAAAA",
        isolated: true,
        warnings: [],
      },
    });
    await lane.flush();

    const read = await readEventLane(path);
    expect(read.exists).toBe(true);
    expect(read.truncated).toBe(false);
    expect(read.events.map((event) => event.event)).toEqual(["worker-birth", "worker-budget-kill"]);
    expect(read.events[1]!.detail).toContain("over the declared MemoryMax");
  });

  it("reports an absent lane as an empty history, never as a failure", async () => {
    const read = await readEventLane(join(dir, "never-written.toonl"));
    expect(read).toMatchObject({ exists: false, truncated: false, events: [] });
  });

  it("keeps only the newest events when the lane is longer than the limit", async () => {
    const path = join(dir, "redskilled.events.toonl");
    const lane = createRedskilledEventLane(path);
    for (let index = 0; index < 20; index += 1) {
      await lane.record(birth(`w${String(index).padStart(4, "0")}`, `2026-08-01T09:00:${String(index).padStart(2, "0")}.000Z`));
    }
    await lane.flush();

    const read = await readEventLane(path, { limit: 5 });
    expect(read.events).toHaveLength(5);
    expect(read.events.at(-1)!.worker_id).toBe("w0019");
  });

  it("borrows the head's segment header so a long lane's tail still decodes", async () => {
    const path = join(dir, "redskilled.events.toonl");
    const lane = createRedskilledEventLane(path);
    for (let index = 0; index < 400; index += 1) {
      await lane.record(birth(`w${String(index).padStart(4, "0")}`, `2026-08-01T09:00:00.${String(index).padStart(3, "0")}Z`));
    }
    await lane.flush();

    // Force the windowed path: the whole-file threshold is below the lane's size.
    const read = await readEventLane(path, { wholeFileBytes: 1_024, tailBytes: 4_096, headBytes: 4_096 });
    expect(read.truncated).toBe(true);
    expect(read.events.length).toBeGreaterThan(0);
    expect(read.events.at(-1)!.worker_id).toBe("w0399");
    // Every decoded row is a real event, not a header borrowed onto nonsense.
    expect(read.events.every((event) => event.event === "worker-birth")).toBe(true);
  });

  it("drops the tail window's half-written first line rather than decoding half a row", () => {
    const head = "{version,ts,event}:\n  1,a,worker-birth\n";
    const tail = "1,partial-ro\n  1,c,worker-death\n";
    expect(spliceWindow(head, tail)).toBe("{version,ts,event}:\n  1,c,worker-death\n");
  });

  it("returns nothing when the window holds no complete row at all", () => {
    expect(spliceWindow("{version}:\n", "half-a-row-and-no-newline")).toBe("");
  });
});

describe("a Worker's log tail", () => {
  it("reads only the tail, and says so", async () => {
    const path = join(dir, "worker.log");
    await writeFile(path, Array.from({ length: 500 }, (_, index) => `line ${index}`).join("\n") + "\n");

    const tail = await tailFile(path, { tailBytes: 200 });
    expect(tail.exists).toBe(true);
    expect(tail.truncated).toBe(true);
    expect(tail.lines.at(-1)).toBe("line 499");
    // The partial first line the window cut is dropped, never shown half-said.
    expect(tail.lines.every((line) => /^line \d+$/.test(line))).toBe(true);
  });

  it("treats a Worker that declared no log path as an absence, not an error", async () => {
    const tail = await tailFile(null);
    expect(tail).toMatchObject({ path: null, exists: false, lines: [] });
    expect(tail.reason).toContain("declared no log path");
  });

  it("reports a missing file by its errno rather than throwing", async () => {
    const tail = await tailFile(join(dir, "gone.log"));
    expect(tail).toMatchObject({ exists: false, reason: "ENOENT" });
  });
});
