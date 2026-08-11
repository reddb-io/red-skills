import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  collectLogLineCounts,
  countLogLinesSinceCursor,
  readLogLineCursors,
} from "../src/runtime/log-cursor.js";
import { appendRecordToonlTaggedRow } from "../src/core/jsonl-log.js";
import { createCastleLaneWriters, createEnginePaths } from "@reddb-io/red-castle/engine";

describe("monitor log cursor", () => {
  it("counts only appended log lines after the first read", async () => {
    const root = await mkdtemp(join(tmpdir(), "afk-log-cursor-"));
    const log = join(root, "afk.log");
    const cache = join(root, "monitor-log-cursors.json");
    await writeFile(log, "a\nb\n", "utf8");

    const first = await collectLogLineCounts(cache, [log]);
    expect(first.get(log)).toEqual({ lines: 2, newLines: 2 });

    await writeFile(log, "a\nb\nc\n", "utf8");
    const second = await collectLogLineCounts(cache, [log]);
    expect(second.get(log)).toEqual({ lines: 3, newLines: 1 });

    const third = await collectLogLineCounts(cache, [log]);
    expect(third.get(log)).toEqual({ lines: 3, newLines: 0 });
  });

  it("resets safely when a log shrinks", async () => {
    const root = await mkdtemp(join(tmpdir(), "afk-log-cursor-"));
    const log = join(root, "afk.log");
    await writeFile(log, "a\nb\nc\n", "utf8");
    const first = await countLogLinesSinceCursor(log, undefined);
    expect(first?.count).toEqual({ lines: 3, newLines: 3 });

    await writeFile(log, "x\n", "utf8");
    const second = await countLogLinesSinceCursor(log, first?.cursor);
    expect(second?.count).toEqual({ lines: 1, newLines: 1 });
  });

  it("persists one cursor per observed log path", async () => {
    const root = await mkdtemp(join(tmpdir(), "afk-log-cursor-"));
    const log = join(root, "afk.log");
    const cache = join(root, "monitor-log-cursors.json");
    await writeFile(log, "line\n", "utf8");
    await collectLogLineCounts(cache, [log]);

    // The cursor cache is a TOON snapshot surface now — never raw JSON.
    const raw = await readFile(cache, "utf8");
    expect(() => JSON.parse(raw)).toThrow();
    const parsed = await readLogLineCursors(cache);
    expect(parsed).toHaveProperty(log);
    expect(parsed[log]).toEqual({ size: 5, lines: 1 });
  });

  it("counts appended TOONL records from a structured-lane cursor", async () => {
    const root = await mkdtemp(join(tmpdir(), "afk-log-cursor-"));
    const log = join(root, "log.toonl");
    const cache = join(root, "monitor-log-cursors.json");
    await appendRecordToonlTaggedRow(log, "agent", "first", {
      ts: "2026-07-15T12:00:00.000Z",
      fields: { extra: { iteration: "1", kind: "text" } },
    });

    const first = await collectLogLineCounts(cache, [log]);
    expect(first.get(log)).toEqual({ lines: 1, newLines: 1 });

    await appendRecordToonlTaggedRow(log, "agent", "second", {
      ts: "2026-07-15T12:01:00.000Z",
      fields: { extra: { iteration: "2", kind: "text" } },
    });
    const second = await collectLogLineCounts(cache, [log]);
    expect(second.get(log)).toEqual({ lines: 2, newLines: 1 });
  });

  it("rescans a writer-capped liveness lane after its cursor is invalidated", async () => {
    const root = await mkdtemp(join(tmpdir(), "afk-log-cursor-liveness-"));
    const writers = createCastleLaneWriters(createEnginePaths(join(root, ".red")), {
      clock: () => "2026-07-15T12:00:00.000Z",
      livenessMaxBytes: 640,
    });
    const writer = writers.liveness("wAB12");
    for (let beat = 1; beat <= 5; beat += 1) {
      await writer.append({
        kind: "worker.heartbeat",
        worker_id: "wAB12",
        payload: { signal: `before-${beat}` },
      });
    }
    const first = await countLogLinesSinceCursor(writer.path, undefined);

    for (let beat = 1; beat <= 5; beat += 1) {
      await writer.append({
        kind: "worker.heartbeat",
        worker_id: "wAB12",
        payload: { signal: `after-${beat}` },
      });
    }
    const second = await countLogLinesSinceCursor(writer.path, first?.cursor);

    expect(second).not.toBeNull();
    expect(second!.count.newLines).toBeGreaterThan(0);
    expect(second!.cursor.size).toBeLessThanOrEqual(640);
  });
});
