import { describe, expect, test } from "vitest";
import {
  formatAuditLogEntry,
  formatIngestTrailer,
  formatNoIngestTrailer,
  ingestGuidance,
  parseAuditMarker,
} from "../src/audit-marker.js";

const SHA = "3a9fa65946eadd9845d28ebf0639f9ce8d9ee34e";
const SHORT_SHA = "3a9fa65";

describe("parseAuditMarker — commit trailer (ingested)", () => {
  test("recognises a well-formed Memory-Ingested trailer with a full SHA", () => {
    expect(parseAuditMarker(`Memory-Ingested: ${SHA}`)).toEqual({
      form: "commit-trailer",
      kind: "ingested",
      sha: SHA,
    });
  });

  test("recognises a short SHA and tolerates surrounding whitespace", () => {
    expect(parseAuditMarker(`  Memory-Ingested:   ${SHORT_SHA}  `)).toEqual({
      form: "commit-trailer",
      kind: "ingested",
      sha: SHORT_SHA,
    });
  });

  test("rejects a non-hex / too-short SHA with a clear error", () => {
    expect(() => parseAuditMarker("Memory-Ingested: nothex")).toThrow(/hex SHA/i);
    expect(() => parseAuditMarker("Memory-Ingested: 123")).toThrow(/hex SHA/i);
    expect(() => parseAuditMarker("Memory-Ingested:")).toThrow(/hex SHA/i);
  });
});

describe("parseAuditMarker — commit trailer (NoIngest bypass)", () => {
  test("recognises Memory-NoIngest with a reason", () => {
    expect(parseAuditMarker("Memory-NoIngest: formatting-only edit")).toEqual({
      form: "commit-trailer",
      kind: "noingest",
      reason: "formatting-only edit",
    });
  });

  test("rejects a Memory-NoIngest trailer with an empty reason", () => {
    expect(() => parseAuditMarker("Memory-NoIngest:")).toThrow(/reason/i);
    expect(() => parseAuditMarker("Memory-NoIngest:   ")).toThrow(/reason/i);
  });
});

describe("parseAuditMarker — audit-log entry", () => {
  const TS = "2026-05-28T16:07:52Z";

  test("recognises a well-formed audit-log entry", () => {
    expect(parseAuditMarker(`${TS} ingest plugins/memory ${SHA}`)).toEqual({
      form: "audit-log",
      at: TS,
      path: "plugins/memory",
      sha: SHA,
    });
  });

  test("accepts an offset timezone and fractional seconds", () => {
    const ts = "2026-05-28T16:07:52.123-03:00";
    expect(parseAuditMarker(`${ts} ingest . ${SHORT_SHA}`)).toEqual({
      form: "audit-log",
      at: ts,
      path: ".",
      sha: SHORT_SHA,
    });
  });

  test("rejects a malformed timestamp", () => {
    expect(() => parseAuditMarker(`28-05-2026 ingest . ${SHA}`)).toThrow(/timestamp/i);
    expect(() => parseAuditMarker(`2026-13-99T99:99:99Z ingest . ${SHA}`)).toThrow(/timestamp/i);
  });

  test("rejects a missing or wrong action token", () => {
    expect(() => parseAuditMarker(`${TS} reindex . ${SHA}`)).toThrow(/ingest/i);
  });

  test("rejects the wrong field count", () => {
    expect(() => parseAuditMarker(`${TS} ingest ${SHA}`)).toThrow();
    expect(() => parseAuditMarker(`${TS} ingest a b ${SHA}`)).toThrow();
  });

  test("rejects a malformed SHA in an otherwise valid log line", () => {
    expect(() => parseAuditMarker(`${TS} ingest . zzz`)).toThrow(/hex SHA/i);
  });
});

describe("parseAuditMarker — total rejection", () => {
  test("rejects empty / blank / unrelated input with a clear error", () => {
    expect(() => parseAuditMarker("")).toThrow(/audit marker/i);
    expect(() => parseAuditMarker("   ")).toThrow(/audit marker/i);
    expect(() => parseAuditMarker("just some commit subject")).toThrow(/audit marker/i);
  });
});

describe("formatters round-trip through the parser", () => {
  test("formatIngestTrailer", () => {
    const line = formatIngestTrailer(SHA);
    expect(line).toBe(`Memory-Ingested: ${SHA}`);
    expect(parseAuditMarker(line)).toMatchObject({ kind: "ingested", sha: SHA });
  });

  test("formatNoIngestTrailer", () => {
    const line = formatNoIngestTrailer("typo fix");
    expect(line).toBe("Memory-NoIngest: typo fix");
    expect(parseAuditMarker(line)).toMatchObject({ kind: "noingest", reason: "typo fix" });
  });

  test("formatAuditLogEntry", () => {
    const line = formatAuditLogEntry("2026-05-28T16:07:52Z", "plugins/memory", SHA);
    expect(line).toBe(`2026-05-28T16:07:52Z ingest plugins/memory ${SHA}`);
    expect(parseAuditMarker(line)).toMatchObject({ form: "audit-log", sha: SHA });
  });

  test("formatIngestTrailer rejects an invalid SHA at the source", () => {
    expect(() => formatIngestTrailer("nope")).toThrow(/hex SHA/i);
  });
});

describe("ingestGuidance", () => {
  test("embeds a parseable Memory-Ingested trailer when the SHA is known", () => {
    const text = ingestGuidance(SHA);
    expect(text).toContain(`Memory-Ingested: ${SHA}`);
    expect(text).toMatch(/Memory-NoIngest/);
    // the trailer it suggests must itself satisfy the contract
    const trailer = text.split("\n").find((l) => l.includes("Memory-Ingested:"))!.trim();
    expect(parseAuditMarker(trailer)).toMatchObject({ kind: "ingested", sha: SHA });
  });

  test("falls back to a placeholder when HEAD is unknown", () => {
    const text = ingestGuidance(null);
    expect(text).toContain("Memory-Ingested: <ingest-sha>");
    expect(text).toMatch(/Memory-NoIngest/);
  });
});
