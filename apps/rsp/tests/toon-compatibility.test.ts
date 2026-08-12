import { decode, encode, encodeRecords, parseRecords } from "@reddb-io/toon";
import { describe, expect, it } from "vitest";

describe("published TOON toolchain compatibility", () => {
  it("writes and reads the canonical v4.1 counted keyed-map form", () => {
    const expected = {
      workers: {
        w1: { status: "running", tokens: 12 },
        w2: { status: "done", tokens: 34 },
      },
    };

    const encoded = encode(expected);
    expect(encoded).toContain("workers[2:]{status,tokens}:");
    expect(decode(encoded)).toEqual(expected);
  });

  it("writes and reads TOONL through the current 0.21 API", () => {
    const expected = [{
      spool_id: "current-1",
      collection: "rsp.telemetry.decisions.v1",
      created_at: "2026-07-15T00:00:00Z",
      ok: true,
      total: 7,
    }];

    expect(parseRecords(encodeRecords(expected, {}))).toEqual(expected);
  });
});
