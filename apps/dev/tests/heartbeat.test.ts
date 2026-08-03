import { describe, expect, it } from "vitest";
import type { JsonlLogRecord } from "../src/core/jsonl-log.js";
import {
  buildHeartbeatRecord,
  buildProgressHeartbeat,
  DEFAULT_HEARTBEAT_S,
  emitHeartbeatTick,
  escapeStreamLine,
  formatDiffVolume,
  formatElapsed,
  formatIterationMarker,
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
      activity: "tests",
      elapsedSeconds: 842,
      lastStreamLine: "running pnpm test",
      cpu: 12,
      rss: 420,
    });
    expect(line).toBe(
      '[heartbeat] activity:tests t+00:14:02 last_stream_line="running pnpm test" cpu=12% rss=420M',
    );
  });

  it("escapes embedded double-quotes and collapses newlines", () => {
    expect(escapeStreamLine('he said "ok"')).toBe('he said \\"ok\\"');
    expect(escapeStreamLine("a\nb")).toBe("a b");
    const line = formatVitalsLine({
      activity: "impl",
      elapsedSeconds: 0,
      lastStreamLine: 'he said "ok"',
      cpu: 0,
      rss: 0,
    });
    expect(line).toContain('last_stream_line="he said \\"ok\\""');
  });

  it("renders an empty stage as ? like the bash default", () => {
    const line = formatVitalsLine({ activity: "", elapsedSeconds: 0, lastStreamLine: "", cpu: 0, rss: 0 });
    expect(line).toBe('[heartbeat] activity:? t+00:00:00 last_stream_line="" cpu=0% rss=0M');
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
    const state: HeartbeatState = { activity: "tests", lastStreamLine: "running pnpm test" };
    const vitals: HeartbeatVitals = { cpu: 12, rss: 420 };
    const record = buildHeartbeatRecord(state, 130, vitals, TS, { worker: "wHB", issue: 250, attempt: 1 });
    expect(record.type).toBe("heartbeat");
    expect(record.msg).toBe("activity:tests t+00:02:10");
    expect(record.worker).toBe("wHB");
    expect(record.issue).toBe(250);
    expect(record.attempt).toBe(1);
    expect(record.activity).toBe("tests");
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
      readState: () => ({ activity: "tests", lastStreamLine: "running pnpm test" }),
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
      '[heartbeat] activity:tests t+00:14:02 last_stream_line="running pnpm test" cpu=12% rss=420M',
    ]);
    expect(firehose).toHaveLength(1);
    expect(firehose[0]!.type).toBe("heartbeat");
    expect(firehose[0]!.msg).toBe("activity:tests t+00:14:02");
  });

  it("re-reads state each tick so a mid-iteration activity flip shows up", () => {
    let activity = "impl";
    const { io, iterLog } = makeIO({ readState: () => ({ activity, lastStreamLine: "writing test" }) });
    emitHeartbeatTick(io, { startedEpoch: 1000 });
    activity = "tests";
    emitHeartbeatTick(io, { startedEpoch: 1000 });
    expect(iterLog[0]).toContain("activity:impl ");
    expect(iterLog[1]).toContain("activity:tests ");
  });

  it("writes the plain line only when no firehose sink is configured", () => {
    const iterLog: string[] = [];
    const io: HeartbeatTickIO = {
      readState: () => ({ activity: "tests", lastStreamLine: "x" }),
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

describe("formatIterationMarker — per-agentic-iteration boundary", () => {
  it("renders N/max with the phase when max is known", () => {
    expect(formatIterationMarker(3, "started", 20)).toBe("[afk] agent iteration 3/20 started");
    expect(formatIterationMarker(12, "ended", 20)).toBe("[afk] agent iteration 12/20 ended");
  });
  it("omits the /max when unknown or non-positive", () => {
    expect(formatIterationMarker(1, "started")).toBe("[afk] agent iteration 1 started");
    expect(formatIterationMarker(1, "started", 0)).toBe("[afk] agent iteration 1 started");
  });
  it("is distinct from the attempt-level heartbeat marker", () => {
    // attempt boundary uses [heartbeat] iteration started for #N; this is [afk] agent iteration N
    expect(formatIterationMarker(1, "started", 20)).not.toContain("[heartbeat]");
    expect(formatIterationMarker(1, "started", 20).startsWith("[afk] agent iteration")).toBe(true);
  });
});

describe("formatDiffVolume", () => {
  it("renders +A -R and clamps negatives to 0", () => {
    expect(formatDiffVolume(42, 10)).toBe("+42 -10");
    expect(formatDiffVolume(0, 0)).toBe("+0 -0");
    expect(formatDiffVolume(-5, -3)).toBe("+0 -0");
  });
});

describe("buildProgressHeartbeat (#448)", () => {
  it("carries the line-diff in the msg, the firehose extra, and the state patch", () => {
    const hb = buildProgressHeartbeat({
      secsSinceProgress: 75,
      lastProgressAt: "2026-06-03T12:00:00.000Z",
      head: "40ac9326abcdef",
      added: 382,
      removed: 45,
    });
    // msg surfaces evolution at a glance: short head + +A -R.
    expect(hb.msg).toBe("progress: 75s since last commit @ 40ac9326 · +382 -45");
    // firehose extra carries the diff fields (string-valued like the bash builder).
    expect(hb.extra.diff).toBe("+382 -45");
    expect(hb.extra.diff_added).toBe("382");
    expect(hb.extra.diff_removed).toBe("45");
    expect(hb.extra.secs_since_progress).toBe("75");
    // state patch persists the volume the monitor prefers over a live git diff.
    // Canonical-only (ADR 0065): last_commit_at + loc_* — no legacy diff_* in state.
    expect(hb.statePatch).toEqual({
      "current.last_commit_at": "2026-06-03T12:00:00.000Z",
      "current.loc_added": 382,
      "current.loc_removed": 45,
    });
    // firehose extra keeps the legacy diff_* alias for one release (asserted above).
    expect(hb.extra.last_commit_at).toBe("2026-06-03T12:00:00.000Z");
    // no activity snapshot → no activity fields, no msg tail (back-compat)
    expect(hb.extra.tools_called_count).toBeUndefined();
    expect(hb.msg.includes("tools:")).toBe(false);
  });

  it("omits the head fragment when HEAD is unresolved and clamps the diff", () => {
    const hb = buildProgressHeartbeat({
      secsSinceProgress: 0,
      lastProgressAt: "2026-06-03T12:00:00.000Z",
      head: "",
      added: -1,
      removed: -2,
    });
    expect(hb.msg).toBe("progress: 0s since last commit · +0 -0");
    expect(hb.statePatch["current.loc_added"]).toBe(0);
    expect(hb.statePatch["current.loc_removed"]).toBe(0);
  });

  it("folds the activity-meter snapshot into the msg tail, extra, and state", () => {
    const hb = buildProgressHeartbeat({
      secsSinceProgress: 75,
      lastProgressAt: "2026-06-03T12:00:00.000Z",
      head: "40ac9326",
      added: 382,
      removed: 45,
      activity: { toolsCalled: 12, textChunks: 7, reasoningCount: 4, reasoningTokens: 130, waiting: 2, eventsThisWindow: 3, inputTokens: 1500, outputTokens: 320, costUsd: 0.04, contextTokens: 103_000 },
    });
    expect(hb.msg).toBe(
      "progress: 75s since last commit @ 40ac9326 · +382 -45 · tools:12 text:7 think:4/130tok wait:2 tok:1500/320 $0.04",
    );
    expect(hb.extra.tools_called_count).toBe("12");
    expect(hb.extra.text_chunk_count).toBe("7");
    // canonical reasoning_events + legacy thinking_called_count alias (firehose).
    expect(hb.extra.reasoning_events).toBe("4");
    expect(hb.extra.thinking_called_count).toBe("4");
    expect(hb.extra.reasoning_tokens).toBe("130");
    expect(hb.extra.waiting_count).toBe("2");
    expect(hb.extra.loc_added).toBe("382");
    expect(hb.extra.loc_removed).toBe("45");
    // cost group (ADR 0065)
    expect(hb.extra.input_tokens).toBe("1500");
    expect(hb.extra.output_tokens).toBe("320");
    expect(hb.extra.cost_usd).toBe("0.04");
    expect(hb.statePatch["current.tools_called_count"]).toBe(12);
    // canonical name in state — no legacy thinking_called_count in statePatch.
    expect(hb.statePatch["current.reasoning_events"]).toBe(4);
    expect(hb.statePatch["current.thinking_called_count"]).toBeUndefined();
    expect(hb.statePatch["current.reasoning_tokens"]).toBe(130);
    expect(hb.statePatch["current.waiting_count"]).toBe(2);
    expect(hb.statePatch["current.loc_added"]).toBe(382);
    expect(hb.statePatch["current.input_tokens"]).toBe(1500);
    expect(hb.statePatch["current.output_tokens"]).toBe(320);
    expect(hb.statePatch["current.cost_usd"]).toBe(0.04);
  });

  it("reasoning with no tokens (claude-style) shows think:N without /tok", () => {
    const hb = buildProgressHeartbeat({
      secsSinceProgress: 10,
      lastProgressAt: "t",
      head: "",
      added: 1,
      removed: 0,
      activity: { toolsCalled: 0, textChunks: 2, reasoningCount: 3, reasoningTokens: 0, waiting: 0, eventsThisWindow: 5, inputTokens: 0, outputTokens: 0, costUsd: 0, contextTokens: 0 },
    });
    expect(hb.msg).toContain("think:3 ");
    expect(hb.msg).not.toContain("tok");
  });

  it("marks an idle window (no new stream events) in the msg tail", () => {
    const hb = buildProgressHeartbeat({
      secsSinceProgress: 130,
      lastProgressAt: "t",
      head: "",
      added: 0,
      removed: 0,
      activity: { toolsCalled: 5, textChunks: 3, reasoningCount: 1, reasoningTokens: 0, waiting: 4, eventsThisWindow: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, contextTokens: 0 },
    });
    expect(hb.msg).toContain("wait:4 (idle window)");
  });
});
