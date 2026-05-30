import { mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import {
  buildSparkline,
  historyAppend,
  historyTrim,
  parseHistoryLines,
  readDoneBuckets,
  renderSparkline,
  type HistoryRecord,
} from "../src/core/history.js";

// Mirrors plugins/dev/skills/engineering/afk/scripts/tests/fixtures/history/buckets.jsonl:
// done events at hour 1000 (×3), 1005, 1047; one done at 1048 (above window) and
// 999 (below); plus a blocked and an exhausted event that must be ignored.
const FIXTURE: Array<Pick<HistoryRecord, "event" | "epoch">> = [
  { event: "done", epoch: 1000 * 3600 + 0 },
  { event: "done", epoch: 1000 * 3600 + 100 },
  { event: "done", epoch: 1000 * 3600 + 1800 },
  { event: "done", epoch: 1005 * 3600 + 0 },
  { event: "done", epoch: 1047 * 3600 + 0 },
  { event: "done", epoch: 1048 * 3600 + 0 }, // above window
  { event: "done", epoch: 999 * 3600 + 0 }, // below window
  { event: "blocked", epoch: 1003 * 3600 + 0 },
  { event: "exhausted", epoch: 1010 * 3600 + 0 },
];

describe("history bucketing", () => {
  it("buckets done events oldest→newest, ignoring non-done and out-of-window", () => {
    const counts = readDoneBuckets(FIXTURE, 1000, 48);
    expect(counts.length).toBe(48);
    expect(counts[0]).toBe(3);
    expect(counts[5]).toBe(1);
    expect(counts[47]).toBe(1);
    expect(counts[1]).toBe(0);
    expect(counts[46]).toBe(0);
    expect(counts.reduce((a, b) => a + b, 0)).toBe(5);
  });

  it("honours a custom bucket width", () => {
    const counts = readDoneBuckets(FIXTURE, 1000, 6);
    expect(counts.length).toBe(6);
    expect(counts[0]).toBe(3);
    expect(counts[5]).toBe(1);
  });
});

describe("history sparkline rendering", () => {
  it("renders all-low glyphs and a zero caption for an empty log", () => {
    const { bar, line, total, peak } = renderSparkline(new Array(48).fill(0));
    expect(bar).toBe("·".repeat(48));
    expect(total).toBe(0);
    expect(peak).toBe(1); // max clamped to 1, matching monitor.sh
    expect(line).toBe(`48h: ${"·".repeat(48)}  (0 closed, peak 1/h, all workers)`);
  });

  it("renders the exact glyph string and caption for the fixture distribution", () => {
    const { bar, line } = buildSparkline(FIXTURE, 1047 * 3600 + 0, 48);
    // peak = 3 → idx = v*8/3: bucket0=3→█, buckets5&47=1→▂, rest 0→·
    const expected = "█" + "·".repeat(4) + "▂" + "·".repeat(41) + "▂";
    expect(bar).toBe(expected);
    expect(line).toBe(`48h: ${expected}  (5 closed, peak 3/h, all workers)`);
  });

  it("scales every glyph to the peak hour", () => {
    // peak 4 → idx = v*8/4 = v*2: counts 4,2,1,0 → █,▄,▂,·
    const { bar } = renderSparkline([4, 2, 1, 0]);
    expect(bar).toBe("█▄▂·");
  });

  it("counts only done events in the caption total", () => {
    const events: Array<Pick<HistoryRecord, "event" | "epoch">> = [
      { event: "done", epoch: 1000 * 3600 },
      { event: "blocked", epoch: 1000 * 3600 },
      { event: "exhausted", epoch: 1000 * 3600 },
    ];
    const { total, line } = buildSparkline(events, 1000 * 3600, 48);
    expect(total).toBe(1);
    expect(line).toContain("(1 closed, peak 1/h, all workers)");
  });
});

describe("history append", () => {
  it("appends one JSONL record per call with defaults and numeric fields", async () => {
    const dir = await mkdtemp(join(tmpdir(), "afk-history-"));
    const path = join(dir, "nested", "afk-history.jsonl");

    const r1 = await historyAppend(
      path,
      { ts: "2026-05-30T00:00:00+00:00", epoch: 1700000000 },
      "done",
      { worker: "wTEST", issue: 42, runner: "claude", duration_s: 600, merge_sha: "abcdef1" },
    );
    expect(r1.event).toBe("done");
    expect(r1.merge_sha).toBe("abcdef1");
    expect(r1).not.toHaveProperty("reason");
    expect(typeof r1.issue).toBe("number");
    expect(typeof r1.duration_s).toBe("number");

    const records = parseHistoryLines(await readFile(path, "utf8"));
    expect(records.length).toBe(1);
    expect(records[0]?.worker).toBe("wTEST");
    expect(records[0]?.issue).toBe(42);
  });

  it("omits empty optional fields and accumulates lines", async () => {
    const dir = await mkdtemp(join(tmpdir(), "afk-history-"));
    const path = join(dir, "afk-history.jsonl");
    const clock = { ts: "t", epoch: 1700000000 };

    await historyAppend(path, clock, "done", { worker: "wA", issue: 1, merge_sha: "deadbee" });
    await historyAppend(path, clock, "blocked", { worker: "wA", issue: 2, reason: "no-sentinel" });
    await historyAppend(path, clock, "exhausted", { worker: "wA", issue: 3 });

    const records = parseHistoryLines(await readFile(path, "utf8"));
    expect(records.length).toBe(3);
    expect(records[0]).toHaveProperty("merge_sha");
    expect(records[0]).not.toHaveProperty("reason");
    expect(records[1]).toHaveProperty("reason");
    expect(records[1]).not.toHaveProperty("merge_sha");
    expect(records[2]).not.toHaveProperty("merge_sha");
    expect(records[2]).not.toHaveProperty("reason");
    expect(records[2]?.duration_s).toBe(0); // default applied
  });

  it("round-trips a done event into bucket 0 via the reader", async () => {
    const dir = await mkdtemp(join(tmpdir(), "afk-history-"));
    const path = join(dir, "afk-history.jsonl");
    const nowEpoch = 1700000000;
    await historyAppend(path, { ts: "t", epoch: nowEpoch }, "done", { worker: "wRT", issue: 1 });
    const records = parseHistoryLines(await readFile(path, "utf8"));
    const { total } = buildSparkline(records, nowEpoch, 48);
    expect(total).toBe(1);
  });

  it("rejects an empty event", async () => {
    const dir = await mkdtemp(join(tmpdir(), "afk-history-"));
    const path = join(dir, "afk-history.jsonl");
    await expect(historyAppend(path, { ts: "t", epoch: 1 }, "")).rejects.toThrow(/event/);
  });
});

describe("history trim", () => {
  it("caps to the bound, keeps newest, and returns the cap", async () => {
    const dir = await mkdtemp(join(tmpdir(), "afk-history-"));
    const path = join(dir, "afk-history.jsonl");
    const clock = (epoch: number) => ({ ts: "t", epoch });
    for (let i = 1; i <= 20; i += 1) {
      await historyAppend(path, clock(i), "done", {});
    }
    const echoed = await historyTrim(path, 5);
    expect(echoed).toBe(5);
    const records = parseHistoryLines(await readFile(path, "utf8"));
    expect(records.length).toBe(5);
    expect(records[0]?.epoch).toBe(16); // newest 5 survive (16..20)
  });

  it("stays silent and untouched when under bound", async () => {
    const dir = await mkdtemp(join(tmpdir(), "afk-history-"));
    const path = join(dir, "afk-history.jsonl");
    for (let i = 1; i <= 3; i += 1) {
      await historyAppend(path, { ts: "t", epoch: i }, "done", {});
    }
    expect(await historyTrim(path, 100)).toBeNull();
    expect(parseHistoryLines(await readFile(path, "utf8")).length).toBe(3);
  });

  it("is a silent no-op for a missing file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "afk-history-"));
    expect(await historyTrim(join(dir, "missing.jsonl"), 5)).toBeNull();
  });
});
