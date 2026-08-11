import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { encodeRecords, parseRecords } from "@reddb-io/toon";
import { parse as decodeLegacy, serialize as encodeLegacy } from "@reddb-io/toon/legacy";
import { describe, expect, it } from "vitest";

const fixtures = join(import.meta.dirname, "fixtures", "toon-compat");

describe("published TOON toolchain compatibility", () => {
  it("reads and losslessly rewrites a pre-v4 keyed-map TOON fixture", async () => {
    const input = await readFile(join(fixtures, "legacy-v013.toon"), "utf8");
    const expected = {
      workers: {
        w1: { status: "running", tokens: 12 },
        w2: { status: "done", tokens: 34 },
      },
    };

    expect(decodeLegacy(input)).toEqual(expected);
    expect(decodeLegacy(encodeLegacy(expected, { keyedMapCollapse: true }))).toEqual(expected);
  });

  it("reads and losslessly rewrites a pre-v4 TOONL fixture", async () => {
    const input = await readFile(join(fixtures, "legacy-v013.toonl"), "utf8");
    const expected = [{
      spool_id: "legacy-1",
      collection: "rsp.telemetry.decisions.v1",
      created_at: "2026-07-15T00:00:00Z",
      ok: true,
      total: 7,
    }];

    expect(parseRecords(input)).toEqual(expected);
    expect(parseRecords(encodeRecords(expected))).toEqual(expected);
  });
});
