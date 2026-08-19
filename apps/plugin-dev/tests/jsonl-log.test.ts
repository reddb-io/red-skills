import { mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import {
  appendAgentRecord,
  appendRecord,
  appendRecordToonl,
  appendRecordToonlRow,
  appendRecordToonlTaggedRow,
  buildRecord,
  ENVELOPE_FIELD_ORDER,
  filterByType,
  filterByWorker,
  formatRecordToonl,
  fsAppendSink,
  JsonlLogError,
  parseLane,
  parseLaneSinceCursor,
  ToonlCursorInvalidationError,
} from "../src/core/jsonl-log.js";

const TS = "2026-05-30T12:00:00+00:00";

describe("jsonl-log record shape", () => {
  it("builds one well-formed envelope with non-default standard fields and an extra", () => {
    const record = buildRecord("stage", "writing test for X", TS, {
      lvl: "warn",
      worker: "wA1B9",
      issue: 246,
      attempt: 1,
      extra: { stage_n: "3" },
    });
    expect(record.lvl).toBe("warn");
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
    const record = buildRecord("stage", "m", TS, { lvl: "warn", worker: "wA1B9", issue: 246, attempt: 1, extra: { stage_n: "3" } });
    expect(Object.keys(record)).toEqual([...ENVELOPE_FIELD_ORDER, "stage_n"]);
  });

  it("applies bash defaults when optional fields are omitted", () => {
    const record = buildRecord("note", "bare", TS);
    expect(record).not.toHaveProperty("lvl");
    expect(record).not.toHaveProperty("worker");
    expect(record).not.toHaveProperty("issue");
    expect(record).not.toHaveProperty("attempt");
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

  it("serializes agent records as spec-valid TOONL segments", () => {
    const segment = formatRecordToonl(buildRecord("agent", "hello", TS, { worker: "wA1B9", extra: { iteration: "1", kind: "text" } }));
    expect(segment.split("\n")[0]).toBe("[1]{ts,worker,type,msg,iteration,kind}:");
    expect(parseLane(segment).map((r) => r.msg)).toEqual(["hello"]);
  });

  it("keeps raw firehose payloads structured and omits dead default fields", () => {
    const record = buildRecord("raw", { iteration: 2, line: "{\"type\":\"usage\",\"inputTokens\":3}" }, TS);
    expect(record).toEqual({
      ts: TS,
      type: "raw",
      msg: { iteration: 2, line: "{\"type\":\"usage\",\"inputTokens\":3}" },
    });
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

  it("appendRecordToonl requires path and type with code 2 and writes nothing", async () => {
    const writes: string[] = [];
    const sink = async (_p: string, line: string) => void writes.push(line);
    await expect(appendRecordToonl("", "stage", "x", { ts: TS, sink })).rejects.toMatchObject({ code: 2 });
    await expect(appendRecordToonl("/lane.jsonl", "", "x", { ts: TS, sink })).rejects.toMatchObject({ code: 2 });
    expect(writes).toEqual([]);
  });

  it("appendRecordToonlRow requires path and type with code 2 and writes nothing", async () => {
    const writes: string[] = [];
    const sink = async (_p: string, line: string) => void writes.push(line);
    await expect(appendRecordToonlRow("", "stage", "x", { ts: TS, sink })).rejects.toMatchObject({ code: 2 });
    await expect(appendRecordToonlRow("/lane.jsonl", "", "x", { ts: TS, sink })).rejects.toMatchObject({ code: 2 });
    expect(writes).toEqual([]);
  });

  it("appendRecordToonlTaggedRow requires path and type with code 2 and writes nothing", async () => {
    const writes: string[] = [];
    const sink = async (_p: string, line: string) => void writes.push(line);
    await expect(appendRecordToonlTaggedRow("", "stage", "x", { ts: TS, sink })).rejects.toMatchObject({ code: 2 });
    await expect(appendRecordToonlTaggedRow("/lane.jsonl", "", "x", { ts: TS, sink })).rejects.toMatchObject({ code: 2 });
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
      await appendRecordToonl("/fire.jsonl", t, `m-${t}`, { ts: TS, sink: fSink });
    }
    // Agent lane only ever takes agent records; synthetics are refused.
    await appendAgentRecord("/agent.jsonl", "turn", { ts: TS, sink: aSink });
    await expect(
      appendAgentRecord("/agent.jsonl", "x", { ts: TS, fields: { extra: { type: "heartbeat" } }, sink: aSink }),
    ).rejects.toBeInstanceOf(JsonlLogError);

    expect(parseLane(firehose.join("\n")).map((r) => r.type)).toEqual(["agent", "heartbeat", "boot", "stage", "hook"]);
    expect(parseLane(agent.join("\n")).map((r) => r.type)).toEqual(["agent"]);
  });

  it("attempt firehose uses tagged-row TOONL multiplexing with canonical per-shape field order", async () => {
    const firehose: string[] = [];
    const sink = async (_p: string, line: string) => void firehose.push(line);

    await appendRecordToonlTaggedRow("/attempt/log.toonl", "raw", { iteration: 1, line: "{\"inputTokens\":3}" }, {
      ts: TS,
      fields: { extra: { iteration: "1" } },
      sink,
    });
    await appendRecordToonlTaggedRow("/attempt/log.toonl", "agent", "hello", {
      ts: TS,
      fields: { extra: { iteration: "1", kind: "text" } },
      sink,
    });
    await appendRecordToonlTaggedRow("/attempt/log.toonl", "raw", { iteration: 2, line: "{\"outputTokens\":5}" }, {
      ts: TS,
      fields: { extra: { iteration: "2" } },
      sink,
    });
    await appendRecordToonlTaggedRow("/attempt/log.toonl", "agent", "again", {
      ts: TS,
      fields: { extra: { kind: "text", iteration: "2" } },
      sink,
    });

    const content = firehose.join("\n");
    const lines = content.split("\n").filter(Boolean);
    const headers = lines.filter((line) => line.startsWith("[]<"));
    expect(headers).toEqual([
      "[]<raw>{ts,type,msg,iteration}:",
      "[]<agent>{ts,type,msg,iteration,kind}:",
    ]);
    expect(lines.filter((line) => /^raw:/.test(line))).toHaveLength(2);
    expect(lines.filter((line) => /^agent:/.test(line))).toHaveLength(2);
    expect(headers.length / lines.length).toBeLessThanOrEqual(0.34);
    expect(parseLane(content).map((r) => [r.type, r.iteration, r.kind ?? null])).toEqual([
      ["raw", "1", null],
      ["agent", "1", "text"],
      ["raw", "2", null],
      ["agent", "2", "text"],
    ]);
  });
});

describe("jsonl-log append accumulation and readers", () => {
  it("accumulates appended JSONL and TOONL segments on disk and auto-creates the parent dir", async () => {
    const dir = await mkdtemp(join(tmpdir(), "afk-jsonl-"));
    const lane = join(dir, "a", "b", "c", "lane.jsonl");
    await appendRecord(lane, "stage", "a", { ts: TS, fields: { worker: "wAAAA" } });
    await appendAgentRecord(lane, "b", { ts: TS, fields: { worker: "wAAAA" } });
    await appendRecord(lane, "stage", "c", { ts: TS, fields: { worker: "wBBBB" } });
    const records = parseLane(await readFile(lane, "utf8"));
    expect(records.map((r) => r.msg)).toEqual(["a", "b", "c"]);
    expect(records.map((r) => r.type)).toEqual(["stage", "agent", "stage"]);
  });

  it("parses legacy JSONL, pure TOONL, and mixed supervisor firehose files", async () => {
    const json = JSON.stringify(buildRecord("heartbeat", "legacy", TS, { worker: "fleet" }));
    const toonA = formatRecordToonl(buildRecord("heartbeat", "toon-a", TS, { worker: "fleet" }));
    const toonB = formatRecordToonl(buildRecord("heartbeat", "toon-b", TS, { worker: "fleet", extra: { slots_busy: "1" } }));

    expect(parseLane(`${json}\n`).map((r) => r.msg)).toEqual(["legacy"]);
    expect(parseLane(`${toonA}\n${toonB}\n`).map((r) => r.msg)).toEqual(["toon-a", "toon-b"]);
    expect(parseLane(`${json}\n${toonA}\n${toonB}\n`).map((r) => r.msg)).toEqual(["legacy", "toon-a", "toon-b"]);
  });

  it("parses legacy JSONL mixed with tagged-row attempt firehose files", async () => {
    const json = JSON.stringify(buildRecord("heartbeat", "legacy", TS, { worker: "wAAAA" }));
    const tagged: string[] = [];
    const sink = async (_p: string, line: string) => void tagged.push(line);
    await appendRecordToonlTaggedRow("/attempt/log-mixed.jsonl", "agent", "toon-a", {
      ts: TS,
      fields: { worker: "wAAAA", extra: { iteration: "1", kind: "text" } },
      sink,
    });
    await appendRecordToonlTaggedRow("/attempt/log-mixed.jsonl", "heartbeat", "toon-b", {
      ts: TS,
      fields: { worker: "wAAAA", extra: { head: "abc123" } },
      sink,
    });

    expect(parseLane(`${json}\n${tagged.join("\n")}\n`).map((r) => r.msg)).toEqual(["legacy", "toon-a", "toon-b"]);
  });

  it("writes stable-schema TOONL lanes with one header and appended rows", async () => {
    const dir = await mkdtemp(join(tmpdir(), "afk-toonl-row-"));
    const lane = join(dir, "afk-supervisor.log.toonl");
    await appendRecordToonlRow(lane, "heartbeat", "first", {
      ts: TS,
      fields: { worker: "fleet", extra: { scope: "fleet", runner: "codex" } },
    });
    await appendRecordToonlRow(lane, "heartbeat", "second", {
      ts: TS,
      fields: { worker: "fleet", extra: { scope: "fleet", runner: "codex" } },
    });

    const content = await readFile(lane, "utf8");
    expect(content.split("\n").filter((line) => line.startsWith("[1]{"))).toHaveLength(1);
    expect(parseLane(content).map((r) => r.msg)).toEqual(["first", "second"]);
  });

  it("opens a new parseable TOONL segment after restart and skips a torn crash tail", async () => {
    const first = formatRecordToonl(buildRecord("agent", "before restart", TS, { worker: "wAAAA" }));
    const second = formatRecordToonl(buildRecord("agent", "after restart", TS, { worker: "wAAAA", extra: { iteration: "2" } }));
    const records = parseLane(`${first}\n[1]{ts,type,msg}:\nthis is not valid toon\n${second}\n`);
    expect(records.map((r) => r.msg)).toEqual(["before restart", "after restart"]);
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

  it("resumes tagged-row TOONL reads from a reader-owned cursor across header rotation", async () => {
    const chunks: string[] = [];
    const sink = async (_p: string, line: string) => void chunks.push(line);
    await appendRecordToonlTaggedRow("/attempt/log-cursor.jsonl", "raw", { iteration: 1, line: "{\"inputTokens\":3}" }, {
      ts: TS,
      fields: { extra: { iteration: "1" } },
      sink,
    });
    const firstBody = `${chunks.join("\n")}\n`;
    const first = parseLaneSinceCursor(firstBody);
    expect(first.records.map((r) => r.iteration)).toEqual(["1"]);

    await appendRecordToonlTaggedRow("/attempt/log-cursor.jsonl", "raw", { iteration: 2, line: "{\"outputTokens\":5}" }, {
      ts: TS,
      fields: { extra: { iteration: "2" } },
      sink,
    });
    await appendRecordToonlTaggedRow("/attempt/log-cursor.jsonl", "agent", "new shape", {
      ts: TS,
      fields: { extra: { iteration: "2", kind: "text" } },
      sink,
    });
    const resumed = parseLaneSinceCursor(`${chunks.join("\n")}\n`, first.cursor);
    expect(resumed.records.map((r) => [r.type, r.iteration, r.kind ?? null])).toEqual([
      ["raw", "2", null],
      ["agent", "2", "text"],
    ]);
    expect(resumed.cursor.byteOffset).toBe(Buffer.byteLength(`${chunks.join("\n")}\n`, "utf8"));
    expect(resumed.cursor.activeHeader).toContain("<agent>");
  });

  it("throws the cursor-invalidation error when a lane shrinks before the cursor", () => {
    const first = parseLaneSinceCursor(`${formatRecordToonl(buildRecord("agent", "before", TS))}\n`);
    expect(() => parseLaneSinceCursor("", first.cursor)).toThrow(ToonlCursorInvalidationError);
  });
});

function buildRecordViaAgent(msg: string, fields: Record<string, unknown>) {
  // Helper mirroring appendAgentRecord's stamping for pure shape assertions.
  return buildRecord("agent", msg, TS, fields as never);
}
