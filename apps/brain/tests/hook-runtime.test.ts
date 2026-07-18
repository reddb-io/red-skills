import { decode } from "@reddb-io/toon";
import { describe, expect, it } from "vitest";
import {
  decodeLastSession,
  encodeLastSession,
  type LastSessionRecord,
} from "../src/hook-runtime.js";

describe("brain SessionStart breadcrumb — TOON round-trip seam", () => {
  const record: LastSessionRecord = {
    runner: "claude",
    lifecycle: "SessionStart",
    rootDir: "/repo",
    connectionString: "postgres://brain",
    startedAt: "2026-07-18T00:00:00.000Z",
  };

  it("round-trips encode -> decode losslessly", () => {
    expect(decodeLastSession(encodeLastSession(record))).toEqual(record);
  });

  it("emits TOON content, not JSON, decodable by the toon reader", () => {
    const encoded = encodeLastSession(record);
    expect(encoded.trimStart().startsWith("{")).toBe(false);
    expect(decode(encoded)).toEqual(record);
  });

  it("sniff-decodes a legacy JSON breadcrumb written by an older bundle", () => {
    const legacy = JSON.stringify(record, null, 2);
    expect(decodeLastSession(legacy)).toEqual(record);
  });
});
