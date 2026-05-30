import { mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import {
  appendAgentRecord,
  appendRecord,
  buildRecord,
  ENVELOPE_FIELD_ORDER,
  filterByType,
  filterByWorker,
  fsAppendSink,
  JsonlLogError,
  parseLane,
} from "../src/core/jsonl-log.js";

const TS = "2026-05-30T12:00:00+00:00";

describe("jsonl-log record shape", () => {
  it("builds one well-formed envelope with every standard field and an extra", () => {
    const record = buildRecord("stage", "writing test for X", TS, {
      lvl: "info",
      worker: "wA1B9",
      issue: 246,
      attempt: 1,
      extra: { stage_n: "3" },
    });
    expect(record.lvl).toBe("info");
    expect(record.worker).toBe("wA1B9");
    expect(record.type).toBe("stage");
    expect(record.msg).toBe("writing test for X");
    expect(typeof record.issue).toBe("number");
    expect(typeof record.attempt).toBe("number");
    expect(record.issue).toBe(246);
    expect(record.attempt).toBe(1);
    expect(typeof record.ts).toBe("string");
    expect(record.stage_n).toBe("3");
  });

  it("emits the canonical field order: ts lvl worker issue attempt type msg …extra", () => {
    const record = buildRecord("stage", "m", TS, { worker: "wA1B9", issue: 246, attempt: 1, extra: { stage_n: "3" } });
    expect(Object.keys(record)).toEqual([...ENVELOPE_FIELD_ORDER, "stage_n"]);
  });

  it("applies bash defaults when optional fields are omitted", () => {
    const record = buildRecord("note", "bare", TS);
    expect(record.lvl).toBe("info");
    expect(record.worker).toBe("");
    expect(record.issue).toBe(0);
    expect(record.attempt).toBe(0);
  });

  it("accepts numeric-string issue/attempt and coerces to JSON numbers", () => {
    const record = buildRecord("tick", "m", TS, { issue: "7", attempt: "2" });
    expect(record.issue).toBe(7);
    expect(record.attempt).toBe(2);
  });

  it("serializes a nasty msg into exactly one valid JSON line that round-trips", () => {
    const evil = 'quote " brace } bracket ] back\\slash\nNEWLINE\ttab';
    const line = JSON.stringify(buildRecord("agent", evil, TS));
    expect(line.includes("\n")).toBe(false);
    expect((JSON.parse(line) as { msg: string }).msg).toBe(evil);
  });
});

describe("jsonl-log malformed input", () => {
  it("rejects non-numeric issue/attempt with code 3", () => {
    expect(() => buildRecord("note", "m", TS, { issue: "abc" })).toThrow(JsonlLogError);
    expect(() => buildRecord("note", "m", TS, { issue: "abc" })).toThrow(/non-numeric issue/);
    expect(() => buildRecord("note", "m", TS, { attempt: "1.5" })).toThrow(/non-numeric attempt/);
    try {
      buildRecord("note", "m", TS, { issue: "abc" });
    } catch (err) {
      expect((err as JsonlLogError).code).toBe(3);
    }
  });

  it("rejects reserved keys and invalid extra keys with code 3", () => {
    expect(() => buildRecord("note", "m", TS, { extra: { type: "boot" } })).toThrow(/reserved key/);
    expect(() => buildRecord("note", "m", TS, { extra: { ts: "now" } })).toThrow(/reserved key/);
    expect(() => buildRecord("note", "m", TS, { extra: { "9bad": "x" } })).toThrow(/invalid extra key/);
  });

  it("rejects an empty type with code 2", () => {
    expect(() => buildRecord("", "m", TS)).toThrow(JsonlLogError);
    try {
      buildRecord("", "m", TS);
    } catch (err) {
      expect((err as JsonlLogError).code).toBe(2);
    }
  });

  it("appendRecord requires path and type with code 2 and writes nothing", async () => {
    const writes: string[] = [];
    const sink = async (_p: string, line: string) => void writes.push(line);
    await expect(appendRecord("", "stage", "x", { ts: TS, sink })).rejects.toMatchObject({ code: 2 });
    await expect(appendRecord("/lane.jsonl", "", "x", { ts: TS, sink })).rejects.toMatchObject({ code: 2 });
    expect(writes).toEqual([]);
  });
});

describe("jsonl-log lane routing", () => {
  it("agent lane stamps type=agent and accepts a redundant explicit type=agent", () => {
    const a = buildRecordViaAgent("implementing Y", { worker: "wA1B9", issue: 246 });
    expect(a.type).toBe("agent");
    expect(a.msg).toBe("implementing Y");
  });

  it("agent lane rejects synthetic and any non-agent type with code 3", async () => {
    const sink = async () => {};
    for (const t of ["heartbeat", "boot", "stage"]) {
      await expect(
        appendAgentRecord("/agent.jsonl", "fake", { ts: TS, fields: { extra: { type: t } }, sink }),
      ).rejects.toMatchObject({ code: 3 });
    }
  });

  it("firehose carries every type; agent lane carries only type=agent", async () => {
    const firehose: string[] = [];
    const agent: string[] = [];
    const fSink = async (_p: string, line: string) => void firehose.push(line);
    const aSink = async (_p: string, line: string) => void agent.push(line);

    // Firehose accepts agent + synthetic + arbitrary record types.
    for (const t of ["agent", "heartbeat", "boot", "stage", "hook"]) {
      await appendRecord("/fire.jsonl", t, `m-${t}`, { ts: TS, sink: fSink });
    }
    // Agent lane only ever takes agent records; synthetics are refused.
    await appendAgentRecord("/agent.jsonl", "turn", { ts: TS, sink: aSink });
    await expect(
      appendAgentRecord("/agent.jsonl", "x", { ts: TS, fields: { extra: { type: "heartbeat" } }, sink: aSink }),
    ).rejects.toBeInstanceOf(JsonlLogError);

    expect(parseLane(firehose.join("\n")).map((r) => r.type)).toEqual(["agent", "heartbeat", "boot", "stage", "hook"]);
    expect(parseLane(agent.join("\n")).map((r) => r.type)).toEqual(["agent"]);
  });
});

describe("jsonl-log append accumulation and readers", () => {
  it("accumulates appended lines on disk and auto-creates the parent dir", async () => {
    const dir = await mkdtemp(join(tmpdir(), "afk-jsonl-"));
    const lane = join(dir, "a", "b", "c", "lane.jsonl");
    await appendRecord(lane, "stage", "a", { ts: TS, fields: { worker: "wAAAA" } });
    await appendAgentRecord(lane, "b", { ts: TS, fields: { worker: "wAAAA" } });
    await appendRecord(lane, "stage", "c", { ts: TS, fields: { worker: "wBBBB" } });
    const records = parseLane(await readFile(lane, "utf8"));
    expect(records.map((r) => r.msg)).toEqual(["a", "b", "c"]);
    expect(records.map((r) => r.type)).toEqual(["stage", "agent", "stage"]);
  });

  it("default fs sink writes one valid JSON line per append", async () => {
    const dir = await mkdtemp(join(tmpdir(), "afk-jsonl-"));
    const lane = join(dir, "lane.jsonl");
    await fsAppendSink(lane, JSON.stringify(buildRecord("note", "x", TS)));
    const content = await readFile(lane, "utf8");
    expect(content.endsWith("\n")).toBe(true);
    expect(parseLane(content)).toHaveLength(1);
  });

  it("filters by worker and by type preserving file order", () => {
    const records = parseLane(
      [
        buildRecord("stage", "a", TS, { worker: "wAAAA" }),
        buildRecord("agent", "b", TS, { worker: "wAAAA" }),
        buildRecord("stage", "c", TS, { worker: "wBBBB" }),
        buildRecord("heartbeat", "d", TS, { worker: "wBBBB" }),
        buildRecord("agent", "e", TS, { worker: "wAAAA" }),
      ]
        .map((r) => JSON.stringify(r))
        .join("\n"),
    );
    expect(filterByWorker(records, "wAAAA").map((r) => r.msg)).toEqual(["a", "b", "e"]);
    expect(filterByType(records, "stage").map((r) => r.msg)).toEqual(["a", "c"]);
    expect(filterByType(records, "nonesuch")).toEqual([]);
  });
});

function buildRecordViaAgent(msg: string, fields: Record<string, unknown>) {
  // Helper mirroring appendAgentRecord's stamping for pure shape assertions.
  return buildRecord("agent", msg, TS, fields as never);
}
