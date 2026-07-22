import { describe, expect, it } from "vitest";
import { parseRecords } from "@reddb-io/toon";
import {
  ATTEMPT_LOG_HEADER,
  ATTEMPT_SIDECAR_FILES,
  FAILURE_SCHEMA,
  LEGACY_ATTEMPT_SIDECAR_FILES,
  encodeAttemptLogAppend,
  encodeFailureReason,
  encodeValidationSidecar,
  looksLikeToonl,
  parseAttemptLog,
  parseFailureReason,
  parseValidationSidecar,
  renderAttemptLogLines,
} from "../src/core/attempt-sidecars.js";

describe("attempt sidecar filenames", () => {
  it("pins the migrated TOON/TOONL names and their legacy twins", () => {
    expect(ATTEMPT_SIDECAR_FILES).toEqual({
      validation: "validation.toonl",
      identity: "identity.toon",
      failure: "failure.toon",
      log: "afk.log.toonl",
    });
    expect(LEGACY_ATTEMPT_SIDECAR_FILES).toEqual({
      validation: "validation.jsonl",
      identity: "identity.json",
      failure: "failure.reason",
      log: "afk.log",
    });
  });
});

describe("validation sidecar", () => {
  const records = [
    { schema: "red.afk.validation.v1", name: "test:apps/dev", status: "passed", exitCode: 0, durationMs: 42 },
    { schema: "red.afk.validation.v1", name: "lint:.", status: "failed", summary: "boom, with comma\nand a newline" },
    { schema: "red.afk.validation.v1", name: "build:.", status: "skipped" },
  ];
  const jsonlCarrier = records.map((record) => JSON.stringify(record));

  it("writes TOONL and round-trips every record losslessly", () => {
    const text = encodeValidationSidecar(jsonlCarrier);
    expect(looksLikeToonl(text)).toBe(true);
    expect(parseRecords(text)).toEqual(records);
    expect(parseValidationSidecar(text)).toEqual(records);
  });

  it("rotates the segment header so heterogeneous records keep their optional fields", () => {
    const text = encodeValidationSidecar(jsonlCarrier);
    const headers = text.split("\n").filter((line) => line.startsWith("[]{"));
    expect(headers).toEqual([
      "[]{schema,name,status,exitCode,durationMs}:",
      "[]{schema,name,status,summary}:",
      "[]{schema,name,status}:",
    ]);
  });

  it("reads a pre-migration validation.jsonl through the legacy fallback", () => {
    expect(parseValidationSidecar(`${jsonlCarrier.join("\n")}\n`)).toEqual(records);
  });

  it("drops unparseable carrier lines instead of corrupting the document", () => {
    const text = encodeValidationSidecar(["not json", "", jsonlCarrier[2]!]);
    expect(parseValidationSidecar(text)).toEqual([records[2]]);
  });

  it("returns no records for an empty sidecar in either format", () => {
    expect(encodeValidationSidecar([])).toBe("");
    expect(parseValidationSidecar("")).toEqual([]);
  });
});

describe("failure marker", () => {
  it("writes a schema-stamped TOON snapshot that round-trips", () => {
    const reason = "gate failed: pnpm -C apps/dev test\nexit 1";
    const text = encodeFailureReason(reason);
    expect(text).toContain(FAILURE_SCHEMA);
    expect(parseFailureReason(text)).toBe(reason);
  });

  it("reads a pre-migration bare-text failure.reason verbatim", () => {
    expect(parseFailureReason("runner failure\n")).toBe("runner failure\n");
    expect(parseFailureReason("main is red: pnpm test failed\nline 2\n")).toBe(
      "main is red: pnpm test failed\nline 2\n",
    );
  });

  it("returns null for an absent or empty marker", () => {
    expect(parseFailureReason(null)).toBeNull();
    expect(parseFailureReason("")).toBeNull();
    expect(parseFailureReason(undefined)).toBeNull();
  });
});

describe("attempt log lane", () => {
  const lines = ["[afk] worker: wABCD", "gate: running pnpm -C apps/dev test", 'tool: Bash({"cmd":"ls, -la"})'];

  function writeLog(): string {
    let text = "";
    for (const [index, msg] of lines.entries()) {
      text += encodeAttemptLogAppend({ at: `2026-07-21T00:0${index}:00Z`, kind: "log", msg }, text.length > 0);
    }
    return text;
  }

  it("writes ONE segment header and one physical line per narrative line", () => {
    const text = writeLog();
    expect(text.startsWith(`${ATTEMPT_LOG_HEADER}\n`)).toBe(true);
    expect(text.split("\n").filter((line) => line.startsWith("[]{"))).toHaveLength(1);
    expect(text.trimEnd().split("\n")).toHaveLength(lines.length + 1);
  });

  it("round-trips every narrative line, including commas and quotes", () => {
    const records = parseAttemptLog(writeLog());
    expect(records.map((record) => record.msg)).toEqual(lines);
    expect(records[0]).toEqual({ at: "2026-07-21T00:00:00Z", kind: "log", msg: lines[0] });
    expect(renderAttemptLogLines(records)).toBe(lines.join("\n"));
  });

  it("preserves an embedded newline in a single narrative record", () => {
    const text = encodeAttemptLogAppend({ at: "2026-07-21T00:00:00Z", kind: "agent", msg: "a\nb" }, false);
    expect(parseAttemptLog(text).map((record) => record.msg)).toEqual(["a\nb"]);
  });

  it("reads a pre-migration plain-text afk.log through the legacy fallback", () => {
    const records = parseAttemptLog(`${lines.join("\n")}\n`);
    expect(records.map((record) => record.msg)).toEqual(lines);
    expect(records[0]!.at).toBe("");
    expect(renderAttemptLogLines(records)).toBe(lines.join("\n"));
  });

  it("returns no records for an empty log", () => {
    expect(parseAttemptLog("")).toEqual([]);
  });
});
