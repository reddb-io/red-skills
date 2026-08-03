import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { encode, encodeRecords, type JsonValue } from "@reddb-io/toon";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readCatalogToonVersion } from "../src/core/toon-version.js";

const execFileAsync = promisify(execFile);
const ROOT = join(import.meta.dirname, "..", "..", "..");

let dir = "";

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "red-skills-toon-roundtrip-"));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

/**
 * The bundled encoder and the host `tq` reader are pinned to one catalog version precisely so the
 * reader can never drift from the writer (ADR 0097). These tests are the empirical half of that
 * pin: they encode with the bundled library and decode with the installed binary, so a format
 * break between the two shows up as a red test rather than as an operator blind to their own logs.
 */
describe("bundled toon encoder round-trips through pinned tq", () => {
  it("runs the tq pinned by the catalog", async () => {
    const { stdout } = await execFileAsync("tq", ["--version"]);
    expect(stdout.trim()).toBe(`tq ${readCatalogToonVersion(ROOT).version}`);
  });

  it("reads back every field of an encoder-written TOONL lane", async () => {
    const records = [
      { ts: "2026-07-15T00:00:00Z", worker: "wRT", type: "agent", msg: "hello", iteration: 1, kind: "text" },
      { ts: "2026-07-15T00:00:01Z", worker: "wRT", type: "agent", msg: "second, with comma", iteration: 2, kind: "text" },
    ];
    const lane = join(dir, "agent.log.toonl");
    await writeFile(lane, encodeRecords(records), "utf8");

    const { stdout } = await execFileAsync("tq", ["-p", "toonl", "-o", "json", "-c", ".", lane]);
    expect(stdout.trim().split("\n").map((line) => JSON.parse(line))).toEqual(records);
  });

  it("preserves values that would break a naive line format", async () => {
    const records = [
      { id: 1, note: 'quotes " and, commas', empty: "", nil: null, flag: true, ratio: 1.5 },
      { id: 2, note: "newline\nembedded", empty: "", nil: null, flag: false, ratio: -0.25 },
    ];
    const lane = join(dir, "gnarly.toonl");
    await writeFile(lane, encodeRecords(records), "utf8");

    const { stdout } = await execFileAsync("tq", ["-p", "toonl", "-o", "json", "-c", ".", lane]);
    expect(stdout.trim().split("\n").map((line) => JSON.parse(line))).toEqual(records);
  });

  it("reads back a nested document written by the non-streaming encoder", async () => {
    const document = {
      schema_version: "red.dev.roundtrip.v1",
      status: "changed",
      changes: [
        { path: "pnpm-workspace.yaml", replacements: [{ site: "workspace.catalog", before: "0.3.0", after: "0.13.0" }] },
      ],
    };
    const file = join(dir, "document.toon");
    await writeFile(file, encode(document as unknown as JsonValue), "utf8");

    const { stdout } = await execFileAsync("tq", ["-o", "json", ".", file]);
    expect(JSON.parse(stdout)).toEqual(document);
  });

  /**
   * toon 0.13.0 added a cyclic-array wire whose meta keys are `order`, `discriminator`, `rows` and
   * `common`, and its decoder tests for them exactly one level below the document root — so a
   * root-level map whose entries carry any of those names decodes as a malformed cyclic section
   * (`invalid cyclic array wire`) in both the bundled decoder and pinned `tq`. Every keyed map we
   * write therefore sits under an envelope key, which puts our field names at depth two. This is the
   * cross-boundary half of that rule: it fails on the writer that forgets the envelope, not just on
   * the decoder we happen to import (issue #3072).
   */
  it("reads back a keyed map whose entries carry cyclic-wire meta names", async () => {
    const document = {
      files: {
        "/workers/wRT/3072/log.toonl": {
          cursor: { byteOffset: 128, rowsSinceHeader: 1, activeHeader: "", taggedHeaders: { raw: "raw{ts,msg}" } },
          rows: [{ ts: "2026-07-15T00:00:00Z", input: 7, output: 11, total: 0 }],
        },
      },
    };
    const file = join(dir, "keyed-map.toon");
    await writeFile(file, encode(document as unknown as JsonValue), "utf8");

    const { stdout } = await execFileAsync("tq", ["-o", "json", ".", file]);
    expect(JSON.parse(stdout)).toEqual(document);
  });
});
