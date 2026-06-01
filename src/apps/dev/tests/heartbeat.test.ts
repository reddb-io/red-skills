import { describe, expect, it } from "vitest";
import type { JsonlLogRecord } from "../src/core/jsonl-log.js";
import {
  buildHeartbeatRecord,
  DEFAULT_HEARTBEAT_S,
  emitHeartbeatTick,
  escapeStreamLine,
  formatElapsed,
  formatStartedMarker,
  formatStoppedMarker,
  formatVitalsLine,
  isPeriodicEnabled,
  resolveIntervalSeconds,
  type HeartbeatState,
  type HeartbeatTickIO,
  type HeartbeatVitals,
} from "../src/core/heartbeat.js";

const TS = "2026-05-30T12:00:00+00:00";

describe("heartbeat elapsed formatting", () => {
  it("formats HH:MM:SS like bash printf (incl. >1h)", () => {
    expect(formatElapsed(0)).toBe("00:00:00");
    expect(formatElapsed(65)).toBe("00:01:05");
    expect(formatElapsed(842)).toBe("00:14:02");
    expect(formatElapsed(3742)).toBe("01:02:22");
    expect(formatElapsed(3600 * 30 + 61)).toBe("30:01:01");
  });

  it("clamps non-integer or negative seconds to zero, like the bash regex guard", () => {
    expect(formatElapsed(-5)).toBe("00:00:00");
    expect(formatElapsed(1.5)).toBe("00:00:00");
  });
});

describe("heartbeat vitals line", () => {
  it("byte-matches the issue #194 spec example", () => {
    const line = formatVitalsLine({
      stage: "tests",
      elapsedSeconds: 842,
      lastStreamLine: "running pnpm test",
      cpu: 12,
      rss: 420,
    });
    expect(line).toBe(
      '[heartbeat] stage:tests t+00:14:02 last_stream_line="running pnpm test" cpu=12% rss=420M',
    );
  });

  it("escapes embedded double-quotes and collapses newlines", () => {
    expect(escapeStreamLine('he said "ok"')).toBe('he said \\"ok\\"');
    expect(escapeStreamLine("a\nb")).toBe("a b");
    const line = formatVitalsLine({
      stage: "impl",
      elapsedSeconds: 0,
      lastStreamLine: 'he said "ok"',
      cpu: 0,
      rss: 0,
    });
    expect(line).toContain('last_stream_line="he said \\"ok\\""');
  });

  it("renders an empty stage as ? like the bash default", () => {
    const line = formatVitalsLine({ stage: "", elapsedSeconds: 0, lastStreamLine: "", cpu: 0, rss: 0 });
    expect(line).toBe('[heartbeat] stage:? t+00:00:00 last_stream_line="" cpu=0% rss=0M');
  });
});

describe("heartbeat boundary markers", () => {
  it("formats the iteration-started marker", () => {
    expect(formatStartedMarker(194, TS)).toBe(`[heartbeat] iteration started for #194 at ${TS}`);
  });

  it("formats the iteration-stopped marker", () => {
    expect(formatStoppedMarker(TS)).toBe(`[heartbeat] iteration stopped at ${TS}`);
  });
});

describe("heartbeat interval resolution", () => {
  it("defaults to 60 for unset or non-numeric values", () => {
    expect(resolveIntervalSeconds(undefined)).toBe(DEFAULT_HEARTBEAT_S);
    expect(resolveIntervalSeconds("")).toBe(DEFAULT_HEARTBEAT_S);
    expect(resolveIntervalSeconds("abc")).toBe(DEFAULT_HEARTBEAT_S);
    expect(DEFAULT_HEARTBEAT_S).toBe(60);
  });

  it("honors a numeric interval and disables on 0", () => {
    expect(resolveIntervalSeconds("1")).toBe(1);
    expect(resolveIntervalSeconds("120")).toBe(120);
    expect(resolveIntervalSeconds("0")).toBe(0);
    expect(isPeriodicEnabled("0")).toBe(false);
    expect(isPeriodicEnabled("1")).toBe(true);
    expect(isPeriodicEnabled(undefined)).toBe(true);
  });
});

describe("heartbeat firehose record", () => {
  it("is a type=heartbeat envelope carrying identity + vitals", () => {
    const state: HeartbeatState = { stage: "tests", lastStreamLine: "running pnpm test" };
    const vitals: HeartbeatVitals = { cpu: 12, rss: 420 };
    const record = buildHeartbeatRecord(state, 130, vitals, TS, { worker: "wHB", issue: 250, attempt: 1 });
    expect(record.type).toBe("heartbeat");
    expect(record.msg).toBe("stage:tests t+00:02:10");
    expect(record.worker).toBe("wHB");
    expect(record.issue).toBe(250);
    expect(record.attempt).toBe(1);
    expect(record.stage).toBe("tests");
    expect(record.elapsed).toBe("00:02:10");
    expect(record.cpu).toBe("12");
    expect(record.rss).toBe("420");
    expect(record.last_stream_line).toBe("running pnpm test");
  });
});

describe("heartbeat tick emit", () => {
  function makeIO(overrides: Partial<HeartbeatTickIO> = {}): {
    io: HeartbeatTickIO;
    iterLog: string[];
    firehose: JsonlLogRecord[];
  } {
    const iterLog: string[] = [];
    const firehose: JsonlLogRecord[] = [];
    const io: HeartbeatTickIO = {
      readState: () => ({ stage: "tests", lastStreamLine: "running pnpm test" }),
      readVitals: () => ({ cpu: 12, rss: 420 }),
      nowEpoch: () => 1000 + 842,
      appendIterLog: (line) => iterLog.push(line),
      appendFirehose: (record) => firehose.push(record),
      nowIso: () => TS,
      ...overrides,
    };
    return { io, iterLog, firehose };
  }

  it("appends one plain vitals line and one firehose heartbeat record", () => {
    const { io, iterLog, firehose } = makeIO();
    emitHeartbeatTick(io, { startedEpoch: 1000, identity: { worker: "wHB", issue: 250, attempt: 1 } });
    expect(iterLog).toEqual([
      '[heartbeat] stage:tests t+00:14:02 last_stream_line="running pnpm test" cpu=12% rss=420M',
    ]);
    expect(firehose).toHaveLength(1);
    expect(firehose[0]!.type).toBe("heartbeat");
    expect(firehose[0]!.msg).toBe("stage:tests t+00:14:02");
  });

  it("re-reads state each tick so a mid-iteration stage flip shows up", () => {
    let stage = "impl";
    const { io, iterLog } = makeIO({ readState: () => ({ stage, lastStreamLine: "writing test" }) });
    emitHeartbeatTick(io, { startedEpoch: 1000 });
    stage = "tests";
    emitHeartbeatTick(io, { startedEpoch: 1000 });
    expect(iterLog[0]).toContain("stage:impl ");
    expect(iterLog[1]).toContain("stage:tests ");
  });

  it("writes the plain line only when no firehose sink is configured", () => {
    const iterLog: string[] = [];
    const io: HeartbeatTickIO = {
      readState: () => ({ stage: "tests", lastStreamLine: "x" }),
      readVitals: () => ({ cpu: 0, rss: 0 }),
      nowEpoch: () => 1130,
      appendIterLog: (line) => iterLog.push(line),
    };
    emitHeartbeatTick(io, { startedEpoch: 1000 });
    expect(iterLog).toHaveLength(1);
  });

  it("RED_AFK_HEARTBEAT_S=0 disables the periodic loop while boundary markers still fire", () => {
    // The periodic loop never runs (no tick lines), but the boundary markers,
    // which are independent of the interval, still produce their lines.
    expect(isPeriodicEnabled("0")).toBe(false);
    expect(formatStartedMarker(194, TS)).toContain("iteration started");
    expect(formatStoppedMarker(TS)).toContain("iteration stopped");
  });
});
