import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { readCastleHistoryRecords } from "@reddb-io/worker/engine";
import {
  buildSparkline,
  historyAppend,
  historyTrim,
  parseHistoryLines,
  readHistoryRecords,
  readDoneBuckets,
  renderSparkline,
  requeueOrdinal,
  type HistoryRecord,
  type HistoryTrimTool,
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
  it("appends one TOONL row per call with defaults, numeric fields, and explicit nulls", async () => {
    const dir = await mkdtemp(join(tmpdir(), "afk-history-"));
    const path = join(dir, "nested", "afk-history.toonl");

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

    const body = await readFile(path, "utf8");
    expect(body.split("\n")[0]).toBe("[1]{ts,epoch,worker,issue,event,duration_s,runner,merge_sha,reason}:");
    expect(body).toContain(",abcdef1,null");
    const records = parseHistoryLines(body);
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
    const path = join(dir, "afk-history.toonl");
    const nowEpoch = 1700000000;
    await historyAppend(path, { ts: "t", epoch: nowEpoch }, "done", { worker: "wRT", issue: 1 });
    const records = parseHistoryLines(await readFile(path, "utf8"));
    const { total } = buildSparkline(records, nowEpoch, 48);
    expect(total).toBe(1);
  });

  it("writes the canonical castle history ledger directly", async () => {
    const dir = await mkdtemp(join(tmpdir(), "afk-history-"));
    const path = join(dir, ".red", "state", "castle", "history.toonl");

    await historyAppend(
      path,
      { ts: "2026-07-17T03:30:00.000Z", epoch: 1784259000 },
      "done",
      { worker: "wCASTLE", issue: 1919, runner: "codex", duration_s: 180, merge_sha: "abc1234" },
    );

    const castle = await readCastleHistoryRecords(path);
    expect(castle).toEqual([
      expect.objectContaining({
        event: "done",
        issue: 1919,
        worker: "wCASTLE",
        runner: "codex",
        merge_sha: "abc1234",
      }),
    ]);
  });

  it("skips malformed legacy JSONL lines while keeping valid monitor history", () => {
    const records = parseHistoryLines(
      [
        JSON.stringify({ ts: "t1", epoch: 1, worker: "wA", issue: 1, event: "done", duration_s: 0, runner: "codex" }),
        "{not-json",
        "",
        JSON.stringify({ ts: "t2", epoch: 2, worker: "wB", issue: 2, event: "blocked", duration_s: 3, runner: "claude" }),
      ].join("\n"),
    );

    expect(records.map((record) => record.issue)).toEqual([1, 2]);
  });

  it("skips a crash-truncated TOONL tail while keeping complete rows", () => {
    const records = parseHistoryLines(
      [
        "[3]{ts,epoch,worker,issue,event,duration_s,runner,merge_sha,reason}:",
        "  t1,1,wA,1,done,0,codex,null,null",
        "  t2,2,wB,2,blocked,3,claude,null,no-sentinel",
        "  t3,",
        "",
      ].join("\n"),
    );

    expect(records.map((record) => record.issue)).toEqual([1, 2]);
    expect(records[0]).not.toHaveProperty("merge_sha");
    expect(records[0]).not.toHaveProperty("reason");
  });

  it("rejects an empty event", async () => {
    const dir = await mkdtemp(join(tmpdir(), "afk-history-"));
    const path = join(dir, "afk-history.jsonl");
    await expect(historyAppend(path, { ts: "t", epoch: 1 }, "")).rejects.toThrow(/event/);
  });
});

describe("history trim", () => {
  it("delegates over-bound TOONL caps to the tq trim runner", async () => {
    const dir = await mkdtemp(join(tmpdir(), "afk-history-"));
    const path = join(dir, "afk-history.toonl");
    for (let i = 1; i <= 6; i += 1) {
      await historyAppend(path, { ts: `t${i}`, epoch: i }, "done", {});
    }
    const calls: Array<{ path: string; keepLast: number }> = [];
    const tool: HistoryTrimTool = {
      async trimKeepLast(calledPath, keepLast) {
        calls.push({ path: calledPath, keepLast });
        await writeFile(
          calledPath,
          [
            "[2]{ts,epoch,worker,issue,event,duration_s,runner,merge_sha,reason}:",
            "  t5,5,,0,done,0,,null,null",
            "  t6,6,,0,done,0,,null,null",
            "",
          ].join("\n"),
          "utf8",
        );
        return true;
      },
    };

    expect(await historyTrim(path, 2, undefined, tool)).toBe(2);
    expect(calls).toEqual([{ path, keepLast: 2 }]);
    expect(parseHistoryLines(await readFile(path, "utf8")).map((record) => record.epoch)).toEqual([5, 6]);
  });

  it("falls back in-process when the tq trim runner is unavailable", async () => {
    const dir = await mkdtemp(join(tmpdir(), "afk-history-"));
    const path = join(dir, "afk-history.toonl");
    for (let i = 1; i <= 6; i += 1) {
      await historyAppend(path, { ts: `t${i}`, epoch: i }, "done", {});
    }
    const tool: HistoryTrimTool = {
      async trimKeepLast() {
        return false;
      },
    };

    expect(await historyTrim(path, 3, undefined, tool)).toBe(3);
    const body = await readFile(path, "utf8");
    expect(body.split("\n")[0]).toBe("[3]{ts,epoch,worker,issue,event,duration_s,runner,merge_sha,reason}:");
    expect(parseHistoryLines(body).map((record) => record.epoch)).toEqual([4, 5, 6]);
  });

  it("caps to the bound, keeps newest, preserves the TOONL header, and returns the cap", async () => {
    const dir = await mkdtemp(join(tmpdir(), "afk-history-"));
    const path = join(dir, "afk-history.toonl");
    const clock = (epoch: number) => ({ ts: "t", epoch });
    for (let i = 1; i <= 20; i += 1) {
      await historyAppend(path, clock(i), "done", {});
    }
    const echoed = await historyTrim(path, 5);
    expect(echoed).toBe(5);
    const body = await readFile(path, "utf8");
    expect(body.split("\n")[0]).toBe("[5]{ts,epoch,worker,issue,event,duration_s,runner,merge_sha,reason}:");
    const records = parseHistoryLines(body);
    expect(records.length).toBe(5);
    expect(records[0]?.epoch).toBe(16); // newest 5 survive (16..20)
  });

  it("preserves TOONL header validity around every trim boundary", async () => {
    const dir = await mkdtemp(join(tmpdir(), "afk-history-"));
    const path = join(dir, "afk-history.toonl");
    for (let i = 1; i <= 12; i += 1) {
      await historyAppend(path, { ts: "t", epoch: i }, "done", {});
    }

    for (let cap = 1; cap <= 12; cap += 1) {
      const copy = join(dir, `copy-${cap}.toonl`);
      await writeFile(copy, await readFile(path, "utf8"), "utf8");
      await historyTrim(copy, cap);
      const body = await readFile(copy, "utf8");
      expect(body.split("\n")[0]).toBe(`[${cap}]{ts,epoch,worker,issue,event,duration_s,runner,merge_sha,reason}:`);
      expect(parseHistoryLines(body).map((record) => record.epoch)).toEqual(
        Array.from({ length: cap }, (_, index) => 13 - cap + index),
      );
    }
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

  it("preserves the original ledger when the atomic temp write fails", async () => {
    const dir = await mkdtemp(join(tmpdir(), "afk-history-"));
    const path = join(dir, "afk-history.jsonl");
    const original = [1, 2, 3]
      .map((epoch) => JSON.stringify({ ts: "t", epoch, worker: "", issue: 0, event: "done", duration_s: 0, runner: "" }))
      .join("\n") + "\n";
    await writeFile(path, original, "utf8");
    await mkdir(`${path}.tmp`);

    await expect(historyTrim(path, 2)).rejects.toThrow();
    expect(await readFile(path, "utf8")).toBe(original);
  });
});

describe("history format sniffing", () => {
  it("reads converted TOONL before legacy JSONL and falls back to legacy during migration", async () => {
    const dir = await mkdtemp(join(tmpdir(), "afk-history-"));
    const legacy = join(dir, ".red", "state", "afk-history.jsonl");
    const converted = join(dir, ".red", "state", "afk-history.toonl");
    await mkdir(join(dir, ".red", "state"), { recursive: true });
    await writeFile(
      legacy,
      `${JSON.stringify({ ts: "legacy", epoch: 1, worker: "wA", issue: 1, event: "done", duration_s: 0, runner: "codex" })}\n`,
      "utf8",
    );

    expect((await readHistoryRecords(converted)).map((record) => record.ts)).toEqual(["legacy"]);

    await historyAppend(converted, { ts: "converted", epoch: 2 }, "blocked", { worker: "wB", issue: 2 });
    expect((await readHistoryRecords(converted)).map((record) => record.ts)).toEqual(["converted"]);
  });
});

describe("requeueOrdinal — the ADR 0103 retry-cap counter", () => {
  const record = (issue: number, event: string): HistoryRecord => ({
    ts: "t",
    epoch: 0,
    worker: "wA",
    issue,
    event,
    duration_s: 0,
    runner: "claude",
  });

  it("is 1 for a Ticket the ledger has never seen", () => {
    expect(requeueOrdinal([], 249)).toBe(1);
    expect(requeueOrdinal([record(250, "blocked")], 249)).toBe(1);
  });

  it("counts one per terminal record for the Ticket, ignoring other Tickets", () => {
    const records = [record(249, "blocked"), record(250, "blocked"), record(249, "merge-conflict")];
    expect(requeueOrdinal(records, 249)).toBe(3);
  });

  it("resets the budget after a done so a reopened Ticket starts fresh", () => {
    const records = [record(249, "blocked"), record(249, "done"), record(249, "blocked")];
    expect(requeueOrdinal(records, 249)).toBe(2);
  });
});
