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
});
