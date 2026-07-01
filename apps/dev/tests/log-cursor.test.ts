import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  collectLogLineCounts,
  countLogLinesSinceCursor,
  readLogLineCursors,
} from "../src/runtime/log-cursor.js";

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

    const raw = await readFile(cache, "utf8");
    expect(JSON.parse(raw)).toHaveProperty(log);
    const parsed = await readLogLineCursors(cache);
    expect(parsed[log]).toEqual({ size: 5, lines: 1 });
  });
});
